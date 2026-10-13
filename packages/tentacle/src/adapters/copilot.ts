/**
 * Copilot SDK adapter for Kraki.
 *
 * Wraps `@github/copilot-sdk` and normalises Copilot CLI events
 * into the abstract `AgentAdapter` callback interface.
 *
 * Key responsibilities:
 *  - Manage the CopilotClient lifecycle (start/stop the CLI server)
 *  - Create/resume/kill sessions via the SDK
 *  - Wire SDK streaming events → `on*` callbacks
 *  - Implement the permission-request / question blocking pattern:
 *    the SDK handler returns a Promise that resolves when the
 *    remote user approves/denies/answers via the tentacle runtime.
 */

import { agentEnv } from '../agent-env.js';
import type { CopilotClient as CopilotClientType, CopilotSession, SessionConfig, MessageOptions, PermissionRequestResult, SessionMetadata, MCPServerConfig, ContextTier } from '@github/copilot-sdk';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getKrakiHome } from '../config.js';
import { isSea } from 'node:sea';
import { cloneTree } from '../fs-clone.js';
import { AgentAdapter, type CreateSessionConfig, type SessionInfo, type PermissionDecision, type QuestionAnswer, type QuestionResponseResult, type PermissionResponseResult, type SendMessageOptions } from './base.js';
import { DEFAULT_SESSION_MODE } from '@kraki/protocol';
import { TurnTracker } from './turn-tracker.js';
import { KRAKI_MODES_PROMPT, modeChangeSignal, type SessionMode } from './permission-policy.js';
import { TITLE_SYSTEM_PROMPT, buildTitlePrompt, cleanTitle, type TitleContext } from './title.js';
import { wireEvents } from './copilot-events.js';
import { startEvictionSweep, stopEvictionSweep, touchSession } from './copilot-eviction.js';
import { makePermissionHandler, makeQuestionHandler, cleanupSessionPermissions, broadcastPendingResolutions } from './copilot-permissions.js';
import { resumeTrackedSession, handleUnavailableSession, linkCopilotStore } from './copilot-resume.js';
import { resolveCopilotCliPath, getCopilotConfigDir } from './copilot-paths.js';
import { loadCopilotSdk } from './copilot-sdk.js';
import { logger, type PendingPermission, type PendingQuestion, type SessionEntry, getErrorMessage } from './copilot-session.js';
export { resolveCopilotCliPath, sanitizeCopilotEventsFile } from './copilot-paths.js';
export { installCopilotSdkImportCompatibility } from './copilot-sdk.js';

// ── Adapter ─────────────────────────────────────────────

export class CopilotAdapter extends AgentAdapter {
  client: CopilotClientType | null = null;
  /** Serialises rebuildClient() so concurrent callers don't spawn multiple runtimes. */
  private rebuildingClient: Promise<void> | null = null;
  sessions = new Map<string, SessionEntry>();
  private cliPath: string | undefined;
  /** Per-session auto-approve sets (populated by "Always Allow" clicks) */
  /** Session permission mode */
  sessionModes = new Map<string, SessionMode>();
  /** Sessions with a pending mode change to prepend on next user message */
  pendingModeSignals = new Map<string, string>();
  /** Per-session cumulative token usage */
  sessionUsage = new Map<string, import('@kraki/protocol').SessionUsage>();
  /** Track tool start args by toolCallId for correlating with tool_complete */
  pendingToolArgs = new Map<string, Record<string, unknown>>();
  /** Subagents by the toolCallId of the task call that dispatched them. */
  subagents = new Map<string, import('@kraki/protocol').SubagentInfo>();
  /** A subagent's latest prose, held until a further step shows it was
   *  narration (its final words are its report = the task's result). */
  subagentDrafts = new Map<string, { sessionId: string; text: string }>();
  /**
   * Tool identity captured at tool.execution_start, keyed by toolCallId.
   * The Copilot SDK omits these fields from tool.execution_complete events —
   * only toolCallId is present there. We stash the names on start and look
   * them up on complete (especially for `mcpServerName`/`mcpToolName`, which
   * we use to recognise our own MCP presenter tools).
   */
  pendingToolIdentity = new Map<string, {
    toolName?: string;
    mcpServerName?: string;
    mcpToolName?: string;
  }>();
  /**
   * Tool calls in flight per session — reverse index so we can clean up
   * pendingToolArgs/pendingToolIdentity when a session ends without each
   * tool call completing (kill, abort, error mid-flight). Without this the
   * two maps grow unbounded over a long-lived daemon.
   */
  sessionToolCallIds = new Map<string, Set<string>>();
  /** Expected model per session — detects involuntary model fallbacks by the CLI */
  expectedModels = new Map<string, string>();
  /** User's originally requested model — never updated on involuntary fallbacks */
  userRequestedModels = new Map<string, string>();
  /** Latest title Copilot generated itself (session.title_changed). */
  nativeTitles = new Map<string, string>();
  /** Whether the current turn has produced any output (message or tool call) */
  turnHasOutput = new Map<string, boolean>();
  /** Whether an error was already reported for the current turn */
  turnErrorReported = new Map<string, boolean>();

  /** Max time to wait for a single session.abort() during adapter.stop().
   *  If exceeded we fall through and let client.stop() kill the SDK process.
   *  At worst we get the legacy orphaned tool_use behavior for that session;
   *  any cleanly-aborted sessions still benefit. */
  private static readonly STOP_ABORT_TIMEOUT_MS = 2_000;

  /** Max time to wait for getAuthStatus during probeRuntime before assuming the
   *  runtime is wedged/dead. Picked so a transient slow RPC is still tolerated
   *  but a hung runtime doesn't stall every recovery attempt. */
  private static readonly PROBE_RUNTIME_TIMEOUT_MS = 5_000;

  // ── Idle-session eviction ────────────────────────────
  // Long-lived daemon → working set grows over time as more sessions get
  // lazy-resumed and then sit idle. To bound runtime memory we periodically
  // sweep the loaded set:
  //   - skip if total runtime RSS is below the threshold (do nothing when
  //     memory is fine — eviction is adaptive, not eager)
  //   - skip any session that's mid-turn or has a pending permission/question
  //     (would be rude to drop while the user is waiting)
  //   - evict sessions that have been quiet longer than IDLE_TTL_MS
  // The evicted session's on-disk state is intact; next user interaction
  // triggers the existing lazy-resume path (relay-client ensureSessionResumed).
  static readonly EVICTION_SCAN_INTERVAL_MS = 5 * 60_000;
  static readonly EVICTION_RSS_THRESHOLD_MB = 2048;
  static readonly EVICTION_IDLE_TTL_MS = 30 * 60_000;
  /** Per-session "last time anything happened" timestamp (ms epoch). Used
   *  by the eviction sweep to identify candidates. Updated by sendMessage,
   *  every SDK event handler, and permission/question responses. */
  lastActivityAt = new Map<string, number>();
  evictionTimer: ReturnType<typeof setInterval> | null = null;

  /** Models known to support long_context tier (updated from Copilot docs).
   *  Used to populate supportedContextTiers in model details. */
  private static readonly LONG_CONTEXT_MODELS = new Set([
    'claude-sonnet-4.6',
    'claude-opus-4.6',
    'claude-opus-4.7',
    'claude-opus-4.8',
    'gpt-5.3-codex',
    'gpt-5.4',
    'gpt-5.5',
    'gemini-3.1-pro-preview',
  ]);

  /** Set of attachment ids already broadcast for this session — prevents
   *  re-broadcasting bytes when the same image is shown twice. */
  private broadcastedAttachmentIds = new Map<string, Set<string>>();

  constructor(options: {
    cliPath?: string;
    /** Tentacle's attachment store. When set, the adapter externalises
     *  image bytes from `kraki-show_image` to it instead of carrying them
     *  inline in the broadcast envelope. */
    attachmentStore?: import('../attachment-store.js').AttachmentStore;
    /** When set, the adapter wires the Kraki MCP server into every Copilot
     *  session it creates/resumes, with the URL scoped per Kraki sessionId. */
    krakiMcp?: {
      urlForSession: (sessionId: string) => string;
      tokenForSession: (sessionId: string) => string;
    };
  } = {}) {
    super();
    this.cliPath = options.cliPath;
    this.attachmentStore = options.attachmentStore;
    this.krakiMcp = options.krakiMcp;
  }

  setTurnIdentity(sessionId: string, turnId: string): void {
    const entry = this.sessions.get(sessionId);
    // Keep the previous provider-run snapshot until assistant.turn_start;
    // callbacks in the handoff window must not inherit the new ID.
    if (entry) entry.turn.relayTurnId = turnId;
  }

  isTurnSettled(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.turn.isSettled === true;
  }

  lifecycleEvent(sessionId: string): { turnId?: string } {
    return this.sessions.get(sessionId)?.turn.event() ?? {};
  }

  /** Sessions whose send is retrying across a runtime rebuild. */
  private retryingSends = new Set<string>();

  /** session.error reports still deciding whether it is a sign-out. */
  pendingErrorReports = new Map<string, Promise<void>>();

  /** `turn`: the identity captured when the error happened (a report that
   *  awaits a probe must not take the turn current after it). */
  emitError(sessionId: string, message: string, turn: { turnId?: string } = this.lifecycleEvent(sessionId)): void {
    this.onError?.(sessionId, { message, ...turn });
  }


  readonly attachmentStore?: import('../attachment-store.js').AttachmentStore;
  readonly krakiMcp?: {
    urlForSession: (sessionId: string) => string;
    tokenForSession: (sessionId: string) => string;
  };

  /** System prompt appended to the SDK's built-in prompt. See system-prompt.md for docs. */
  static readonly SYSTEM_PROMPT = [
    'You are running inside Kraki, a remote control platform. A human operator is',
    'monitoring and controlling your session from a separate device through an',
    'encrypted relay. Your tool calls are routed through a permission system that',
    'approves, denies, or prompts the operator depending on the current mode.',
    '',
    KRAKI_MODES_PROMPT,
  ].join('\n');

  /**
   * Appended to the system prompt when the Kraki MCP server is wired in.
   * Tools are exposed to the model with display names of the form
   * `<server>-<tool>` (dash), confirmed via a live SDK spike.
   */
  static readonly KRAKI_MCP_PROMPT = [
    'You have access to a Kraki MCP server. Its tools are visible with names',
    'beginning with "kraki-".',
    '',
    '**Default to `view` for any image you need to inspect.** `view` feeds the',
    'bytes to your vision; the user does NOT see it in their chat UI. This is',
    'the right choice for:',
    '- Screenshots of the user\'s own device (via ADB, iOS simulator, their',
    '  phone) — they are already looking at the device.',
    '- An image the user just attached or sent you — they already have it.',
    '- Any image file you read to inform your own reasoning.',
    '',
    '**Only call `kraki-show_image` when the user cannot already see the image',
    'and would gain new information from seeing it.** Typical cases:',
    '- A diagram or chart you just generated (mermaid, graphviz, plot).',
    '- A mockup or UI you designed for the user to review.',
    '- A file from your own machine the user has no other way to look at.',
    '',
    'When in doubt, use `view`. Echoing back an image the user can already see',
    'clutters the chat and re-encodes bytes for no benefit.',
    '',
    'Self-knowledge limit: `kraki-show_image` returns only a short text',
    'confirmation to you, not the image bytes. After a long session your older',
    'turns may be summarized, so you may not be able to introspect which tool',
    'you used on which file. If a user asks about your past behavior and you',
    'cannot directly verify it in your current context, say so explicitly',
    'rather than confidently assert from incomplete memory.',
  ].join('\n');

  // ── Lifecycle ───────────────────────────────────────

  async start(): Promise<void> {
    // Note: orphaned runtime processes from un-gracefully killed daemons
    // (SIGKILL / OS OOM-kill) are not auto-reaped here. The pgrep+ppid
    // heuristics we previously tried either matched nothing or risked
    // killing the user's independent `copilot` CLI. Graceful shutdown
    // (daemon-worker.ts) prevents the common case; if the daemon dies
    // un-gracefully, the user can `kill` the stray runtime by hand.
    //
    // Always prefer useLoggedInUser: true — the copilot CLI server manages
    // its own credential store (keychain) and silently refreshes the ~8h
    // access token for the lifetime of the daemon. Injecting a static gh
    // token bypasses this and causes silent auth death when it expires.

    let cliPath = this.cliPath ?? resolveCopilotCliPath();
    if (!cliPath && isSea()) {
      // At boot, PATH tools (nvm, copilot) may not be ready yet.
      // Retry for up to 30s before giving up.
      const deadline = Date.now() + 30_000;
      while (!cliPath && Date.now() < deadline) {
        logger.debug('Copilot CLI not found yet, retrying...');
        await new Promise(r => setTimeout(r, 2_000));
        cliPath = resolveCopilotCliPath();
      }
      if (!cliPath) {
        throw new Error('Copilot CLI not found on PATH. Install GitHub Copilot CLI so `copilot` is available.');
      }
    }

    // On Windows, resolve the actual .js entry point from the .cmd wrapper.
    // Node spawn() can't execute .cmd files, and the SDK handles .js files natively.
    if (cliPath && process.platform === 'win32' && !cliPath.endsWith('.js') && !cliPath.endsWith('.exe')) {
      const cmdPath = cliPath.endsWith('.cmd') ? cliPath : cliPath + '.cmd';
      if (existsSync(cmdPath)) {
        try {
          const cmdContent = readFileSync(cmdPath, 'utf8');
          const match = cmdContent.match(/"%dp0%\\(.+\.js)"/);
          if (match) {
            const jsPath = join(dirname(cmdPath), match[1]);
            if (existsSync(jsPath)) {
              cliPath = jsPath;
              logger.debug({ cliPath }, 'Resolved Windows .cmd to .js entry point');
            }
          }
        } catch { /* fall through to original path */ }
      }
    }

    // In SEA mode, process.execPath is the SEA binary, not node.exe.
    // The SDK uses process.execPath to spawn .js files — override it temporarily.
    let restoreExecPath: (() => void) | null = null;
    if (isSea() && cliPath?.endsWith('.js')) {
      try {
        const nodePath = execSync(
          process.platform === 'win32' ? 'where node' : 'command -v node',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim().split(/\r?\n/)[0];
        if (nodePath && existsSync(nodePath)) {
          const origExecPath = process.execPath;
          Object.defineProperty(process, 'execPath', { value: nodePath, writable: true, configurable: true });
          restoreExecPath = () => { Object.defineProperty(process, 'execPath', { value: origExecPath, writable: true, configurable: true }); };
          logger.debug({ nodePath }, 'Overriding process.execPath for Copilot SDK');
        }
      } catch { /* can't find node — SDK will use process.execPath */ }
    }

    // copilot-sdk 1.0.x takes the CLI path via a RuntimeConnection — the old
    // top-level `cliPath` option is silently ignored. Pass the resolved path
    // explicitly so the SDK never falls back to its `getBundledCliPath()`,
    // which uses `createRequire(bundlePath).resolve.paths('@github/copilot')`
    // and finds nothing inside a SEA binary (no node_modules tree beside the
    // bundle). When the path is unresolved we omit the connection so the SDK
    // can apply its own COPILOT_CLI_PATH / bundled fallback.
    const { CopilotClient, RuntimeConnection } = await loadCopilotSdk();
    const opts = {
      useLoggedInUser: true,
      env: agentEnv(),
      ...(cliPath && { connection: RuntimeConnection.forStdio({ path: cliPath }) }),
    };
    logger.debug({ isSea: isSea(), cliPath: cliPath ?? null }, 'starting CopilotClient');

    this.client = new CopilotClient(opts);
    await this.client.start();
    if (restoreExecPath) restoreExecPath();
    startEvictionSweep(this);
    logger.debug('started');
  }

  async stop(): Promise<void> {
    stopEvictionSweep(this);

    // Abort all active sessions first so the SDK writes a clean `abort` event
    // to events.jsonl for any in-flight tool_use. Without this, killing the
    // client mid-turn leaves the conversation history with an orphaned
    // tool_use block, and Claude rejects the next resume with
    // `messages.N: tool_use ids were found without tool_result blocks`.
    // Each abort is guarded by a short timeout so a hung session doesn't
    // hang shutdown — at worst we still get the legacy bad behavior for that
    // one session, no worse than today.
    const sessionIds = Array.from(this.sessions.keys());
    if (sessionIds.length > 0) {
      logger.debug({ count: sessionIds.length }, 'aborting active sessions before stop');
      await Promise.all(sessionIds.map(async (sessionId) => {
        try {
          await Promise.race([
            this.abortSession(sessionId),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('abort timeout')), CopilotAdapter.STOP_ABORT_TIMEOUT_MS),
            ),
          ]);
        } catch (err) {
          logger.warn({ err, sessionId }, 'pre-stop abort failed');
        }
      }));
    }

    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
    this.sessions.clear();
    this.lastActivityAt.clear();
    logger.debug('stopped');
  }

  /**
   * Tear down the dead runtime and spawn a fresh one.
   *
   * All existing SDK sessions are invalidated (they referenced the old
   * runtime process). The caller must re-resume individual sessions after
   * this returns. Concurrent callers share a single rebuild.
   *
   * Any pending permission/question requests across all sessions are
   * cancelled first so the arm UI doesn't get stuck waiting for an answer
   * the dead runtime will never deliver.
   */
  async rebuildClient(): Promise<void> {
    if (this.rebuildingClient) return this.rebuildingClient;
    this.rebuildingClient = (async () => {
      logger.warn('Rebuilding CopilotClient after runtime death');
      try {
        // Resolve all pending permissions/questions across every session
        // BEFORE clearing the entries — otherwise the arm UI stays stuck on
        // a request that will never be answered (the old runtime is dead).
        for (const [sessionId, entry] of this.sessions) {
          broadcastPendingResolutions(this, sessionId);
          // A running turn of the dead runtime will never idle; only a send
          // that is about to retry keeps its turn open.
          if (!this.retryingSends.has(sessionId)) {
            entry.turn.discardProse();
            entry.turn.finish({ error: 'The Copilot runtime stopped unexpectedly and was restarted; this turn was interrupted.' });
          }
        }
        if (this.client) {
          try { await this.client.stop(); } catch { /* old client may already be dead */ }
          this.client = null;
        }
        // All SDK session handles are now invalid
        this.sessions.clear();
        this.lastActivityAt.clear();
        await this.start();
        logger.info('CopilotClient rebuilt successfully');
      } finally {
        this.rebuildingClient = null;
      }
    })();
    return this.rebuildingClient;
  }

  // ── Idle-session eviction ────────────────────────────

  // ── Session management ──────────────────────────────

  async createSession(config: CreateSessionConfig): Promise<{ sessionId: string }> {
    this.ensureClient();

    const pendingPermissions = new Map<string, PendingPermission>();
    const pendingQuestions = new Map<string, PendingQuestion>();

    // Load MCP server config and inject into session
    const mcpConfigPath = join(homedir(), '.copilot', 'mcp-config.json');
    let mcpServers: Record<string, MCPServerConfig> | undefined;
    if (existsSync(mcpConfigPath)) {
      try {
        const mcpRaw = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
        const rawServers = mcpRaw.mcpServers ?? {};
        const serverNames = Object.keys(rawServers);
        if (serverNames.length > 0) {
          // CLI requires `tools` field on each server — default to all tools
          mcpServers = {};
          for (const [name, cfg] of Object.entries(rawServers)) {
            mcpServers[name] = { ...(cfg as MCPServerConfig), tools: (cfg as MCPServerConfig & { tools?: string[] }).tools ?? ['*'] };
          }
          logger.info(`MCP config found: ${serverNames.length} server(s) [${serverNames.join(', ')}]`);
        }
      } catch (err) {
        logger.warn(`MCP config exists but failed to parse: ${(err as Error).message}`);
      }
    } else {
      logger.info('No MCP config at ~/.copilot/mcp-config.json');
    }

    const validEfforts = new Set(['low', 'medium', 'high', 'xhigh']);
    const effort = config.reasoningEffort && validEfforts.has(config.reasoningEffort)
      ? config.reasoningEffort as SessionConfig['reasoningEffort']
      : undefined;

    const contextTier = config.contextTier === 'long_context'
      ? 'long_context' as ContextTier
      : undefined;

    // Two-phase MCP wiring: create session WITHOUT kraki MCP server first
    // (we need the SDK-assigned sessionId to scope the MCP URL), then the
    // adapter re-wires through resumeSession with the kraki entry below.
    // For simplicity in v1 we use a deterministic Kraki MCP wire-up:
    // we let the SDK pick the session id, then on every Copilot session
    // we add the kraki MCP at resume time. For initial creation we pre-pick
    // a session id when the caller supplied one; otherwise the kraki MCP
    // is added on the next message via resumeSession during normal flow.
    //
    // Simpler approach: register a Kraki MCP server using the *Copilot*
    // sessionId only after createSession returns it. To do that without
    // a second SDK call, we use a placeholder sessionId for the initial
    // mcpServers entry and rewrite via resume on first use. But that's
    // brittle — instead, see the comment block at the constructor: the
    // kraki MCP HTTP server validates sessionId by checking SessionManager,
    // not by Copilot SDK state, so we can ALWAYS include the kraki entry
    // here by using a stable session-scoped URL that the adapter knows
    // up-front via config.sessionId (the Kraki session id we assigned).
    if (this.krakiMcp && config.sessionId) {
      const krakiEntry: MCPServerConfig = {
        type: 'http' as const,
        url: this.krakiMcp.urlForSession(config.sessionId),
        headers: { Authorization: `Bearer ${this.krakiMcp.tokenForSession(config.sessionId)}` },
        tools: ['*'],
      } as MCPServerConfig;
      mcpServers = { ...(mcpServers ?? {}), kraki: krakiEntry };
      logger.info({ sessionId: config.sessionId }, 'wired kraki MCP into session config');
    }

    const systemPromptContent = this.krakiMcp
      ? `${CopilotAdapter.SYSTEM_PROMPT}\n\n${CopilotAdapter.KRAKI_MCP_PROMPT}`
      : CopilotAdapter.SYSTEM_PROMPT;

    const sessionConfig: SessionConfig = {
      ...(config.sessionId && { sessionId: config.sessionId }),
      ...(config.model && { model: config.model }),
      ...(effort && { reasoningEffort: effort }),
      ...(contextTier && { contextTier }),
      ...(config.cwd && { workingDirectory: config.cwd }),
      configDirectory: getCopilotConfigDir(),
      ...(mcpServers && { mcpServers }),
      systemMessage: { mode: 'append' as const, content: systemPromptContent },
      streaming: true,
      onPermissionRequest: makePermissionHandler(this, pendingPermissions),
      onUserInputRequest: makeQuestionHandler(this, pendingQuestions),
    };

    const session = await this.client!.createSession(sessionConfig);
    const sid = session.sessionId;

    this.sessions.set(sid, { session, pendingPermissions, pendingQuestions, turn: new TurnTracker(this, sid) });
    touchSession(this, sid);
    wireEvents(this, sid, session);
    linkCopilotStore(this, sid);
    logger.info(`session created: ${sid} (model: ${config.model ?? 'default'})`);
    if (config.model) {
      this.expectedModels.set(sid, config.model);
      this.userRequestedModels.set(sid, config.model);
    }
    this.onSessionCreated?.({
      sessionId: sid,
      agent: 'copilot',
      model: config.model,
      reasoningEffort: effort,
    });

    return { sessionId: sid };
  }

  async resumeSession(sessionId: string): Promise<{ sessionId: string }> {
    await resumeTrackedSession(this, sessionId);
    return { sessionId };
  }

  async forkSession(sourceSessionId: string, newSessionId: string): Promise<{ sessionId: string }> {
    const sdkStateDir = join(homedir(), '.copilot', 'session-state');
    const srcDir = join(sdkStateDir, sourceSessionId);
    const dstDir = join(sdkStateDir, newSessionId);

    // Copy SDK session state if it exists
    if (existsSync(srcDir)) {
      cloneTree(srcDir, dstDir);

      // Update the session ID in workspace.yaml
      const yamlPath = join(dstDir, 'workspace.yaml');
      if (existsSync(yamlPath)) {
        let yaml = readFileSync(yamlPath, 'utf8');
        yaml = yaml.replace(/^id:\s*.+$/m, `id: ${newSessionId}`);
        writeFileSync(yamlPath, yaml, 'utf8');
      }

      // Rewrite all session ID references in events.jsonl so the SDK
      // treats this as a fully independent session (not a shared conversation).
      const eventsPath = join(dstDir, 'events.jsonl');
      if (existsSync(eventsPath)) {
        let events = readFileSync(eventsPath, 'utf8');
        events = events.replaceAll(sourceSessionId, newSessionId);
        writeFileSync(eventsPath, events, 'utf8');
      }
    }

    // Resume the forked session via SDK
    await resumeTrackedSession(this, newSessionId);
    logger.info({ sourceSessionId, newSessionId }, 'session forked');

    // Notify relay so it broadcasts session_created to all arms
    this.onSessionCreated?.({
      sessionId: newSessionId,
      agent: 'copilot',
    });

    return { sessionId: newSessionId };
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: import('@kraki/protocol').Attachment[],
    options?: SendMessageOptions,
  ): Promise<void> {
    const turn = this.sessions.get(sessionId)?.turn;
    if (options?.delivery !== 'steer' || turn?.isSettled) {
      // A normal prompt starts a fresh cycle. An immediate interjection remains
      // part of the active cycle and must not reset its output/error tracking.
      this.turnErrorReported.set(sessionId, false);
      turn?.beginTurn();
    }
    touchSession(this, sessionId);

    // Prepend mode-switch signal if mode changed since last message
    const pendingMode = this.pendingModeSignals.get(sessionId);
    if (pendingMode) {
      this.pendingModeSignals.delete(sessionId);
      text = `${modeChangeSignal(pendingMode as SessionMode)}\n\n${text}`;
    }

    const opts: MessageOptions = {
      prompt: text,
      ...(options?.delivery === 'steer' && { mode: 'immediate' as const }),
    };
    const tempFiles: string[] = [];

    // Convert image attachments to files in the SDK session directory
    if (attachments?.length) {
      const entry = this.sessions.get(sessionId);
      const sdkFilesDir = entry
        ? join(homedir(), '.copilot', 'session-state', sessionId, 'files')
        : tmpdir();
      const sdkAttachments: Array<{ type: 'file'; path: string; displayName?: string }> = [];
      for (const att of attachments) {
        // Images arrive inline (base64) or, from current apps, as a content_ref
        // into the AttachmentStore (as Claude/Codex already read them).
        let bytes: Buffer | undefined;
        let mimeType = att.mimeType;
        if (att.type === 'image') {
          bytes = Buffer.from(att.data, 'base64');
        } else if (att.type === 'content_ref' && this.attachmentStore) {
          const hit = this.attachmentStore.read(sessionId, att.id);
          if (hit) { bytes = hit.bytes; mimeType = hit.meta.mimeType ?? mimeType; }
        }
        if (!bytes || !/^image\//.test(mimeType)) continue;
        const ext = mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : mimeType === 'image/gif' ? '.gif' : '.jpg';
        const fileName = `kraki-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
        const filePath = join(sdkFilesDir, fileName);
        mkdirSync(sdkFilesDir, { recursive: true });
        writeFileSync(filePath, bytes);
        if (!entry) tempFiles.push(filePath);
        sdkAttachments.push({ type: 'file' as const, path: filePath, displayName: fileName });
      }
      if (sdkAttachments.length) opts.attachments = sdkAttachments as MessageOptions['attachments'];
    }

    try {
      await this.sendMessageInner(sessionId, opts);
    } finally {
      for (const f of tempFiles) {
        try { unlinkSync(f); } catch { /* best effort */ }
      }
    }
  }

  private async sendMessageInner(sessionId: string, opts: MessageOptions): Promise<void> {
    // getSession() is inside the try so that a "Session not found" throw —
    // which happens when meta says active/idle but the SDK runtime never
    // loaded the session (state-drift after a crash, or a missed
    // ensureSessionResumed gate) — flows into the recovery path that calls
    // resumeTrackedSession instead of escaping all the way to the arm.
    let entry: SessionEntry;
    try {
      entry = this.getSession(sessionId);
      await entry.session.send(opts);
      return;
    } catch (err) {
      // Probe runtime to structurally determine error category
      const health = await this.probeRuntime();

      if (health === 'auth_error') {
        this.fireAuthError(sessionId, err);
        throw err;
      }

      if (health === 'dead') {
        // Runtime process died — rebuild the client and retry once. The retry
        // continues this send's open turn (and its relay identity).
        logger.warn({ err, sessionId }, 'Runtime died mid-send; rebuilding client');
        const turn = this.sessions.get(sessionId)?.turn;
        this.retryingSends.add(sessionId);
        try {
          await this.rebuildClient();
          entry = await resumeTrackedSession(this, sessionId, turn);
          await entry.session.send(opts);
          return;
        } catch (rebuildErr) {
          handleUnavailableSession(this, sessionId, rebuildErr);
          throw rebuildErr;
        } finally {
          this.retryingSends.delete(sessionId);
        }
      }

      // Runtime alive — session-level error; try resume + retry
      logger.warn({ err, sessionId }, 'Session send failed; attempting resume');

      try {
        entry = await resumeTrackedSession(this, sessionId);
      } catch (resumeErr) {
        handleUnavailableSession(this, sessionId, resumeErr);
        throw resumeErr;
      }

      try {
        await entry.session.send(opts);
      } catch (retryErr) {
        // On retry failure, re-probe to give a meaningful diagnosis
        const retryHealth = await this.probeRuntime();
        if (retryHealth === 'auth_error') {
          this.fireAuthError(sessionId, retryErr);
        } else {
          handleUnavailableSession(this, sessionId, retryErr);
        }
        throw retryErr;
      }
    }
  }

  async respondToPermission(
    sessionId: string,
    permissionId: string,
    decision: PermissionDecision,
    reason?: string,
  ): Promise<PermissionResponseResult> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.warn(`respondToPermission: session not found: ${sessionId}`);
      return 'session_gone';
    }
    const pending = entry.pendingPermissions.get(permissionId);
    if (!pending) {
      logger.warn(`respondToPermission: no pending permission: ${permissionId} (already resolved or timed out)`);
      return 'not_found';
    }

    const result: PermissionRequestResult = decision === 'approve'
      ? { kind: 'approve-once' }
      : reason ? { kind: 'reject', feedback: `Denied by user: ${reason}` } : { kind: 'reject' };
    pending.resolve(result);
    entry.pendingPermissions.delete(permissionId);
    touchSession(this, sessionId);
    logger.debug({ permissionId, sessionId, decision }, 'permission resolved');
    return 'accepted';
  }

  async respondToQuestion(
    sessionId: string,
    questionId: string,
    answer: QuestionAnswer | string,
    wasFreeform: boolean,
  ): Promise<QuestionResponseResult> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.warn(`respondToQuestion: session not found: ${sessionId}`);
      return 'session_gone';
    }
    const pending = entry.pendingQuestions.get(questionId);
    if (!pending) {
      logger.warn(`respondToQuestion: no pending question: ${questionId}`);
      return 'not_found';
    }

    const answerValue = typeof answer === 'string' ? { text: answer } : answer;
    const answerText = answerValue.text || (answerValue.attachments?.length ? 'The user answered with image attachment(s).' : '');
    pending.resolve({ answer: answerText, wasFreeform });
    entry.pendingQuestions.delete(questionId);
    touchSession(this, sessionId);
    return 'accepted';
  }

  async killSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      broadcastPendingResolutions(this, sessionId);
      await entry.session.abort().catch(() => {});
      await entry.session.disconnect();
      this.sessions.delete(sessionId);
    }
    cleanupSessionPermissions(this, sessionId);
    try { unlinkSync(join(getKrakiHome(), 'sessions', sessionId, 'copilot.jsonl')); } catch { /* no link */ }
    this.onSessionEnded?.(sessionId, { reason: 'killed' });
    logger.info(`session killed: ${sessionId}`);
  }

  async abortSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      // Mark BEFORE the abort lands so the subsequent session.idle handler
      // sees the flag and suppresses empty-cycle detection. If we marked
      // after session.abort() resolved, the idle event could fire first
      // (depending on SDK timing) and a false empty-cycle error would
      // beat us.
      entry.turn.abort();
      broadcastPendingResolutions(this, sessionId);
      await entry.session.abort();
      logger.debug({ sessionId }, 'session aborted');
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    if (!this.client) return [];
    const list: SessionMetadata[] = await this.client.listSessions();
    return list.map((s) => ({
      id: s.sessionId,
      state: this.sessions.has(s.sessionId) ? 'active' as const : 'ended' as const,
      model: undefined,
      cwd: s.context?.workingDirectory,
      summary: s.summary ?? '',
    }));
  }

  async listModels(): Promise<string[]> {
    if (!this.client) {
      logger.debug('listModels: client not initialized');
      return [];
    }
    try {
      const models = await this.client.listModels();
      return models.map((m: { id: string }) => m.id);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'listModels failed');
      return [];
    }
  }

  async listModelDetails(): Promise<import('@kraki/protocol').ModelDetail[]> {
    if (!this.client) {
      logger.debug('listModelDetails: client not initialized');
      return [];
    }
    try {
      const models = await this.client.listModels();
      return models.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        supportsReasoningEffort: m.capabilities?.supports?.reasoningEffort ?? false,
        ...(m.supportedReasoningEfforts && { supportedReasoningEfforts: m.supportedReasoningEfforts }),
        ...(m.defaultReasoningEffort && { defaultReasoningEffort: m.defaultReasoningEffort }),
        ...(m.capabilities?.limits?.max_context_window_tokens && { contextWindow: m.capabilities.limits.max_context_window_tokens }),
        ...(CopilotAdapter.LONG_CONTEXT_MODELS.has(m.id) && { supportedContextTiers: ['default', 'long_context'] as import('@kraki/protocol').ContextTier[] }),
      }));
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'listModelDetails failed');
      return [];
    }
  }

  /** Set permission mode for a session */
  setSessionMode(sessionId: string, mode: SessionMode): void {
    const prev = this.sessionModes.get(sessionId);
    this.sessionModes.set(sessionId, mode);
    if ((prev ?? DEFAULT_SESSION_MODE) !== mode) {
      this.pendingModeSignals.set(sessionId, mode);
    }
    logger.debug({ sessionId, mode }, 'Session permission mode changed');
  }

  /** Change model for a session via SDK */
  async setSessionModel(sessionId: string, model: string, reasoningEffort?: string, contextTier?: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.warn({ sessionId }, 'setSessionModel: session not found');
      return;
    }
    this.expectedModels.set(sessionId, model);
    this.userRequestedModels.set(sessionId, model);
    const validEfforts = new Set(['low', 'medium', 'high', 'xhigh']);
    const options: { reasoningEffort?: SessionConfig['reasoningEffort']; contextTier?: ContextTier } = {};
    if (reasoningEffort && validEfforts.has(reasoningEffort)) {
      options.reasoningEffort = reasoningEffort as SessionConfig['reasoningEffort'];
    }
    if (contextTier === 'long_context') {
      options.contextTier = 'long_context';
    }
    await entry.session.setModel(model, Object.keys(options).length > 0 ? options : undefined);
    logger.info({ sessionId, model, ...options }, 'Session model changed');
  }

  /** Get current cumulative usage for a session */
  getSessionUsage(sessionId: string): import('@kraki/protocol').SessionUsage | null {
    return this.sessionUsage.get(sessionId) ?? null;
  }

  /** Restore persisted usage totals on session resume */
  setSessionUsage(sessionId: string, usage: import('@kraki/protocol').SessionUsage): void {
    this.sessionUsage.set(sessionId, { ...usage });
  }



  signalFlushComplete(sessionId: string): void {
    const eventsPath = join(homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
    const MAX_CHECKS = 3;
    const CHECK_INTERVAL_MS = 200;
    let lastSize = -1;
    let checks = 0;

    const check = () => {
      let size: number;
      try { size = statSync(eventsPath).size; } catch { size = 0; }

      if (size === lastSize || checks >= MAX_CHECKS) {
        if (checks >= MAX_CHECKS && size !== lastSize) {
          logger.warn({ sessionId }, 'events.jsonl still growing after max wait — signalling flush anyway');
        }
        this.onFlushComplete?.(sessionId);
        return;
      }

      lastSize = size;
      checks++;
      setTimeout(check, CHECK_INTERVAL_MS);
    };

    // Start first check after a short delay to let the SDK write its final events
    setTimeout(check, CHECK_INTERVAL_MS);
  }

  /**
   * Probe the runtime to determine its health after an error.
   *
   * Uses `getAuthStatus()` as a lightweight RPC to structurally detect
   * whether the runtime process is alive, eliminating hardcoded error
   * string matching. Bounded by {@link PROBE_RUNTIME_TIMEOUT_MS} so a
   * wedged runtime is treated as dead instead of hanging the caller.
   *
   * Returns:
   *  - `'alive'`      — runtime is up, auth is good → session-level error
   *  - `'auth_error'`  — runtime is up but auth failed
   *  - `'dead'`        — runtime process is gone, wedged, or timed out
   */
  async probeRuntime(): Promise<'alive' | 'auth_error' | 'dead'> {
    if (!this.client) return 'dead';
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const status = await Promise.race([
        this.client.getAuthStatus(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('probeRuntime timeout')),
            CopilotAdapter.PROBE_RUNTIME_TIMEOUT_MS,
          );
        }),
      ]);
      return status.isAuthenticated ? 'alive' : 'auth_error';
    } catch {
      return 'dead';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Fire onError with a clear, actionable auth-error message. */
  fireAuthError(sessionId: string, err: unknown, turn?: { turnId?: string }): void {
    const raw = getErrorMessage(err);
    logger.error({ sessionId, err }, 'Authentication error detected');
    this.emitError(sessionId, `GitHub credential expired or invalid: ${raw}\n\nRun one of the following on the host machine to re-authenticate:\n• \`copilot /login\`\n• \`gh auth login\``, turn);
  }

  // ── SDK → callback wiring ─────────────────────────

  /** A tool follows: the prose before it was narration. */
  flushNarration(sessionId: string): void {
    this.sessions.get(sessionId)?.turn.toolStarted();
  }

  // ── Permission handler factory ────────────────────

  // ── Question handler factory ──────────────────────

  // ── Guards ────────────────────────────────────────

  ensureClient(): void {
    if (!this.client) throw new Error('Adapter not started — call start() first');
  }

  private getSession(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session not found: ${sessionId}`);
    return entry;
  }

  // ── Title generation via throwaway session ────────


  async generateTitle(sessionId: string, context: TitleContext): Promise<string | null> {
    // Copilot titles its own sessions (session.title_changed) as part of the
    // turn it already paid for. Prefer that: a side-call spends one more
    // premium/chat request, which matters on the Free plan's 200/month.
    const native = this.nativeTitles.get(sessionId);
    if (native) return cleanTitle(native);
    if (!this.client) return null;

    // Same model as the session (auto on plans without model choice).
    const model = context.model ?? this.userRequestedModels.get(sessionId) ?? this.expectedModels.get(sessionId);
    let session: CopilotSession | null = null;
    try {
      session = await this.client.createSession({
        configDirectory: getCopilotConfigDir(),
        ...(model && { model }),
        systemMessage: { mode: 'replace' as const, content: TITLE_SYSTEM_PROMPT },
        // A pure text side-call: the prompt is user text, so no tool may run.
        availableTools: [],
        onPermissionRequest: () => ({ kind: 'reject' as const }),
        onUserInputRequest: () => ({ answer: '', wasFreeform: true }),
      } as Parameters<CopilotClientType['createSession']>[0]);
      const response = await session.sendAndWait({ prompt: buildTitlePrompt(context) }, 30_000);
      return cleanTitle(response?.data?.content);
    } catch (err) {
      logger.warn({ err: (err as Error).message, sessionId }, 'Title generation failed');
      return null;
    } finally {
      if (session) {
        const throwawayId = session.sessionId;
        await session.disconnect().catch(() => {});
        await this.client?.deleteSession(throwawayId).catch(() => {});
      }
    }
  }

}
