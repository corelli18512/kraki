/**
 * Claude Agent SDK adapter for Kraki.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` and normalises Claude Code events
 * into the abstract `AgentAdapter` callback interface.
 *
 * Key responsibilities:
 *  - Start `query()` sessions with streaming input for multi-turn conversation
 *  - Map SDKMessage stream → adapter `on*` callbacks
 *  - Implement permission control via `canUseTool` callback with Kraki's 4-mode system
 *  - Handle `AskUserQuestion` tool → `onQuestionRequest` with blocking Promise
 *  - Session lifecycle: create, resume, fork, kill, abort
 */

import type { SessionUsage, ModelDetail, Attachment } from '@kraki/protocol';
import { AgentAdapter, type CreateSessionConfig, type SessionInfo, type PermissionDecision, type QuestionAnswer, type QuestionResponseResult, type PermissionResponseResult, type SendMessageOptions } from './base.js';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getConfigDir } from '../config.js';
import { DEFAULT_SESSION_MODE } from '@kraki/protocol';
import { TurnTracker } from './turn-tracker.js';
import { KRAKI_MODES_PROMPT, krakiAutoApproves, modeChangeSignal, type SessionMode } from './permission-policy.js';
import { TITLE_SYSTEM_PROMPT, buildTitlePrompt, cleanTitle, type TitleContext } from './title.js';
import { linkIntoShadow } from './shadow-link.js';
import { cloneTree } from '../fs-clone.js';
import { handleSDKMessage } from './claude-messages.js';
import { makeCanUseToolHandler, emitQuestionCard, broadcastPendingResolutions } from './claude-permissions.js';
import { resetSubagentPhase } from './claude-subagents.js';
import { loadClaudeSettingsEnv, claudeConfigSource, secureStorageEnv, isClaudeLoggedOut, aliasEnvKey } from './claude-env.js';
import { getErrorMessage } from './claude-errors.js';
import { logger, type SDKSystemMessage, type SDKUserMessage, type Options, type PermissionMode, type Query, type PendingPermission, type PendingQuestion, type SessionEntry, createInputChannel } from './claude-session.js';
import { toolNameToKind } from './claude-tools.js';
export { loadClaudeSettingsEnv, claudeConfigSource, secureStorageEnv, isClaudeLoggedOut } from './claude-env.js';
export { normalizeClaudeSDKError } from './claude-errors.js';
export { toolNameToKind, editsToDiff } from './claude-tools.js';

export { linkIntoShadow };

// ── Adapter ─────────────────────────────────────────────

export class ClaudeAdapter extends AgentAdapter {
  sessions = new Map<string, SessionEntry>();
  /** Per-session auto-approve sets (populated by "Always Allow" clicks) */
  /** Session permission mode */
  sessionModes = new Map<string, SessionMode>();
  /** Sessions with a pending mode change to prepend on next user message */
  private pendingModeSignals = new Map<string, string>();
  /** Last API response id whose usage was counted, per session. */
  lastCountedResponse = new Map<string, string>();
  /** Last `total_cost_usd` reported by the session's current query. */
  lastQueryCost = new Map<string, number>();
  /** Per-session cumulative token usage */
  sessionUsage = new Map<string, SessionUsage>();
  /** Cached model list from last session init */
  private cachedModels: ModelDetail[] = [];
  /** Map resolved display name → SDK alias for env-overridden models */
  private modelAliasMap = new Map<string, string>();
  /** Track in-flight tool_use IDs per session for correlating tool_complete */
  pendingToolCalls = new Map<string, Map<string, { toolName: string; args: Record<string, unknown>; parentToolCallId?: string }>>();
  /** Map Kraki session ID → SDK session UUID (resume/fork). */
  sdkSessionIds = new Map<string, string>();

  readonly attachmentStore?: import('../attachment-store.js').AttachmentStore;
  private readonly krakiMcp?: {
    urlForSession: (sessionId: string) => string;
    tokenForSession: (sessionId: string) => string;
  };
  /**
   * Absolute path to the `claude` binary, set by the multi-adapter via
   * `which claude` / `where claude`. We pass this to every SDK query() as
   * `pathToClaudeCodeExecutable` to bypass the SDK's own resolution code,
   * which calls `createRequire(import.meta.url)` and fails inside our SEA
   * binary (no node_modules next to the executable).
   */
  private readonly claudeExecutablePath?: string;

  constructor(options: {
    attachmentStore?: import('../attachment-store.js').AttachmentStore;
    krakiMcp?: {
      urlForSession: (sessionId: string) => string;
      tokenForSession: (sessionId: string) => string;
    };
    claudeExecutablePath?: string;
  } = {}) {
    super();
    this.attachmentStore = options.attachmentStore;
    this.krakiMcp = options.krakiMcp;
    this.claudeExecutablePath = options.claudeExecutablePath;
  }

  // ── Co-located storage ────────────────────────────────────
  // Claude's private transcript (its LLM-context store) is relocated INTO the
  // Kraki session dir via a per-session CLAUDE_CONFIG_DIR. Auth/config is shared
  // by symlinking every ~/.claude entry except `projects` (the transcript store)
  // into a per-session shadow home, so the transcript lands co-located while
  // login still works. A small sidecar persists the bits needed to resume after
  // a daemon restart: cwd (the transcript path is cwd-mangled) and the SDK's own
  // session UUID (the value the SDK `resume` option actually expects).

  private storeDir(sessionId: string): string {
    return join(getConfigDir(), 'sessions', sessionId);
  }
  /** Per-session shadow CLAUDE_CONFIG_DIR (auth symlinked in, projects fresh). */
  private claudeHome(sessionId: string): string {
    return join(this.storeDir(sessionId), 'claude-home');
  }
  private sidecarPath(sessionId: string): string {
    return join(this.storeDir(sessionId), '.claude-adapter.json');
  }

  /** Build the per-session shadow home: symlink every ~/.claude entry except
   *  `projects` so the SDK writes its transcript into our co-located dir while
   *  reusing the real login/config. Returns the shadow home path. */
  private setupShadowHome(sessionId: string): string {
    const home = this.claudeHome(sessionId);
    mkdirSync(home, { recursive: true });
    const source = claudeConfigSource();
    const failed: string[] = [];
    if (existsSync(source.dir)) {
      for (const entry of readdirSync(source.dir)) {
        if (entry === 'projects') continue; // keep transcript store co-located
        if (!linkIntoShadow(join(source.dir, entry), join(home, entry))) failed.push(entry);
      }
    }
    // With CLAUDE_CONFIG_DIR set, Claude reads `.claude.json` (user MCP
    // servers, onboarding state) from inside it; by default it lives next to
    // ~/.claude. Bring the user's copy along so their MCP servers still load.
    const userJson = source.explicit ? join(source.dir, '.claude.json') : join(homedir(), '.claude.json');
    if (!source.explicit && existsSync(userJson) && !linkIntoShadow(userJson, join(home, '.claude.json'))) failed.push('.claude.json');
    if (failed.length) logger.warn({ sessionId, failed }, 'Could not share some Claude settings with the session; Claude may ask to sign in');
    return home;
  }

  /** Environment for every Claude Code child: the daemon env plus the user's
   *  Claude settings.json `env` block. Built per call and passed via
   *  `options.env` instead of mutating process.env, so Claude provider keys
   *  never leak into the Copilot / Pi / Codex children of the same daemon. */
  private claudeEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
    return {
      // Kraki relays the user's own Claude Code configuration as-is; it does not
      // switch agent features on or off (e.g. background tasks).
      ...process.env,
      ...loadClaudeSettingsEnv(claudeConfigSource().dir),
      ...extra,
    };
  }

  /** Resolve a Kraki-visible model id back to the SDK alias it came from. */
  private sdkModel(model: string): string {
    return this.modelAliasMap.get(model) ?? model;
  }

  persistMeta(sessionId: string, meta: { cwd?: string; sdkSessionId?: string; model?: string; reasoningEffort?: string; forkFrom?: string }): void {
    try {
      mkdirSync(this.storeDir(sessionId), { recursive: true });
      const prev = this.loadMeta(sessionId) ?? {};
      writeFileSync(this.sidecarPath(sessionId), JSON.stringify({ ...prev, ...meta }), 'utf8');
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'claude persistMeta failed');
    }
  }

  private loadMeta(sessionId: string): { cwd?: string; sdkSessionId?: string; model?: string; reasoningEffort?: string; forkFrom?: string } | null {
    const p = this.sidecarPath(sessionId);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  }

  /** System prompt appended to Claude Code's built-in prompt. */
  private static readonly SYSTEM_PROMPT = [
    'You are running inside Kraki, a remote control platform. A human operator is',
    'monitoring and controlling your session from a separate device through an',
    'encrypted relay. Your tool calls are routed through a permission system that',
    'approves, denies, or prompts the operator depending on the current mode.',
    '',
    KRAKI_MODES_PROMPT,
  ].join('\n');

  /** Appended when the Kraki MCP server is wired in. */
  private static readonly KRAKI_MCP_PROMPT = [
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
  ].join('\n');

  // ── Lifecycle ───────────────────────────────────────

  async start(): Promise<void> {
    // Verify the SDK can be imported
    const sdk = await import('@anthropic-ai/claude-agent-sdk').catch(() => null);
    if (!sdk) {
      throw new Error(
        'Claude Agent SDK not found. Install it with: npm install @anthropic-ai/claude-agent-sdk'
      );
    }

    // Authentication is the SDK's business: an API key, ANTHROPIC_AUTH_TOKEN,
    // a cloud provider, or a Claude subscription login are all valid. One
    // throwaway control-only query (no model call) lists models and reports
    // whether ANY credential is configured; Kraki does not guess from env vars.
    const env = this.claudeEnv(secureStorageEnv());
    let loggedOut = false;
    try {
      const ac = new AbortController();
      const noop = (async function* () { /* never yields — query blocks waiting for input */ })();
      const q = sdk.query({
        prompt: noop,
        options: {
          abortController: ac,
          env,
          permissionMode: 'default' as PermissionMode,
          ...(this.claudeExecutablePath && { pathToClaudeCodeExecutable: this.claudeExecutablePath }),
        },
      });
      const models = await q.supportedModels();
      try {
        const account = await (q as { accountInfo?: () => Promise<unknown> }).accountInfo?.();
        loggedOut = isClaudeLoggedOut(account);
      } catch (err) {
        logger.debug({ err: (err as Error).message }, 'Claude accountInfo unavailable');
      }
      ac.abort();
      if (models.length > 0) {
        // Resolve SDK aliases to actual backend model names via env overrides,
        // then deduplicate so the UI shows real models (e.g. "deepseek-v4-pro[1m]")
        // instead of generic aliases ("opus", "sonnet") that map to the same backend.
        this.modelAliasMap.clear();
        const seen = new Set<string>();
        const resolved: ModelDetail[] = [];

        for (const m of models) {
          const alias = m.value;
          const envKey = aliasEnvKey(alias);
          const displayId = envKey ? (env[envKey] || alias) : alias;

          if (!seen.has(displayId)) {
            seen.add(displayId);
            this.modelAliasMap.set(displayId, alias);
            resolved.push({
              id: displayId,
              name: m.displayName ?? displayId,
              supportsReasoningEffort: !!m.supportsEffort,
              ...(m.supportedEffortLevels && {
                supportedReasoningEfforts: m.supportedEffortLevels as import('@kraki/protocol').ReasoningEffort[],
              }),
            });
          }
        }

        this.cachedModels = resolved;
        logger.info({ count: this.cachedModels.length }, 'Fetched Claude model list from SDK');
      }
    } catch (err) {
      this.lastModelListError = (err as Error).message;
      logger.warn({ err: (err as Error).message }, 'Could not fetch model list from SDK');
    }

    if (loggedOut) {
      throw new Error(
        'Claude Code is not logged in. Run `claude` and use /login (Claude subscription), ' +
        'or configure ANTHROPIC_API_KEY / a cloud provider, then restart Kraki.',
      );
    }

    logger.info({ models: this.cachedModels.map(m => m.id) }, 'Claude adapter started');
  }

  async stop(): Promise<void> {
    for (const [sessionId, entry] of this.sessions) {
      try {
        broadcastPendingResolutions(this, sessionId);
        entry.inputChannel.end();
        entry.abortController.abort();
      } catch {
        logger.warn({ sessionId }, 'Error stopping session during adapter shutdown');
      }
    }
    this.sessions.clear();
    logger.info('Claude adapter stopped');
  }

  // ── Session management ──────────────────────────────

  async createSession(config: CreateSessionConfig): Promise<{ sessionId: string }> {
    const sessionId = config.sessionId ?? `claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pendingPermissions = new Map<string, PendingPermission>();
    const pendingQuestions = new Map<string, PendingQuestion>();
    const abortController = new AbortController();
    const { iterable, channel } = createInputChannel();

    const entry: SessionEntry = {
      query: null,
      abortController,
      inputChannel: channel,
      inputIterable: iterable,
      pendingPermissions,
      pendingQuestions,
      sessionId,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      consumerLoop: Promise.resolve(),
      deferredConfig: config,
      turn: new TurnTracker(this, sessionId),
    };

    this.sessions.set(sessionId, entry);
    logger.info({ sessionId, model: config.model }, 'session created (deferred — query starts on first message)');

    // Persist the durable resume bits up-front (cwd is needed to locate the
    // cwd-mangled transcript; the SDK session UUID is filled in at init).
    this.persistMeta(sessionId, { cwd: config.cwd, model: config.model, reasoningEffort: config.reasoningEffort });

    this.onSessionCreated?.({
      sessionId,
      agent: 'claude',
      model: config.model,
      reasoningEffort: config.reasoningEffort,
    });

    return { sessionId };
  }

  async resumeSession(sessionId: string): Promise<{ sessionId: string }> {
    const pendingPermissions = new Map<string, PendingPermission>();
    const pendingQuestions = new Map<string, PendingQuestion>();
    const abortController = new AbortController();
    const { iterable, channel } = createInputChannel();

    // Recover the durable bits from the co-located sidecar. The SDK `resume`
    // option expects the SDK's own session UUID (NOT Kraki's id), and the
    // transcript path is cwd-mangled — so without these a fresh daemon spawns a
    // blank session (the daemon-restart "no context" bug). Fall back to the
    // Kraki id / process cwd for sessions created before co-location.
    const meta = this.loadMeta(sessionId);
    if (meta?.sdkSessionId) this.sdkSessionIds.set(sessionId, meta.sdkSessionId);

    const entry: SessionEntry = {
      query: null,
      abortController,
      inputChannel: channel,
      inputIterable: iterable,
      pendingPermissions,
      pendingQuestions,
      sessionId,
      model: meta?.model,
      reasoningEffort: meta?.reasoningEffort,
      consumerLoop: Promise.resolve(),
      turn: new TurnTracker(this, sessionId),
      deferredConfig: {
        // A fork that never ran yet still has to be made from its source.
        ...(!meta?.sdkSessionId && meta?.forkFrom && { fork: true }),
        resume: meta?.sdkSessionId ?? meta?.forkFrom ?? sessionId,
        ...(meta?.cwd && { cwd: meta.cwd }),
        ...(meta?.model && { model: meta.model }),
        ...(meta?.reasoningEffort && { reasoningEffort: meta.reasoningEffort as CreateSessionConfig['reasoningEffort'] }),
        sessionId,
      },
    };

    this.sessions.set(sessionId, entry);
    logger.info({ sessionId, sdkSessionId: meta?.sdkSessionId }, 'session resumed (deferred)');
    return { sessionId };
  }

  async forkSession(sourceSessionId: string, newSessionId: string): Promise<{ sessionId: string }> {
    const pendingPermissions = new Map<string, PendingPermission>();
    const pendingQuestions = new Map<string, PendingQuestion>();
    const abortController = new AbortController();
    const { iterable, channel } = createInputChannel();

    // A fork must read the source transcript from the NEW session's co-located
    // config dir, so seed it by copying the source projects/ across, and resume
    // with the source's SDK session UUID (not the Kraki id).
    const srcMeta = this.loadMeta(sourceSessionId);
    const srcProjects = join(this.claudeHome(sourceSessionId), 'projects');
    if (existsSync(srcProjects)) {
      try {
        mkdirSync(this.claudeHome(newSessionId), { recursive: true });
        cloneTree(srcProjects, join(this.claudeHome(newSessionId), 'projects'));
      } catch (err) {
        logger.debug({ err: (err as Error).message }, 'claude fork copy failed');
      }
    }
    const resumeId = srcMeta?.sdkSessionId ?? this.sdkSessionIds.get(sourceSessionId) ?? sourceSessionId;

    const entry: SessionEntry = {
      query: null,
      abortController,
      inputChannel: channel,
      inputIterable: iterable,
      pendingPermissions,
      pendingQuestions,
      sessionId: newSessionId,
      consumerLoop: Promise.resolve(),
      turn: new TurnTracker(this, newSessionId),
      deferredConfig: {
        resume: resumeId,
        fork: true,
        ...(srcMeta?.cwd && { cwd: srcMeta.cwd }),
        ...(srcMeta?.model && { model: srcMeta.model }),
        ...(srcMeta?.reasoningEffort && { reasoningEffort: srcMeta.reasoningEffort as CreateSessionConfig['reasoningEffort'] }),
        sessionId: newSessionId,
      },
    };

    this.sessions.set(newSessionId, entry);
    // The fork is made by the first query (resume + forkSession). Record what
    // it forks from, so a daemon restart before that still forks the right
    // conversation instead of starting an empty one.
    this.persistMeta(newSessionId, {
      cwd: srcMeta?.cwd, model: srcMeta?.model, reasoningEffort: srcMeta?.reasoningEffort, forkFrom: resumeId,
    });

    this.onSessionCreated?.({
      sessionId: newSessionId,
      agent: 'claude',
    });

    logger.info({ sourceSessionId, newSessionId }, 'session forked (deferred)');
    return { sessionId: newSessionId };
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: Attachment[],
    options?: SendMessageOptions,
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.warn({ sessionId }, 'sendMessage: session not found');
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Streaming input accepts another user message while the query is running.
    // Keep the active draft for an interjection. A steer arriving after the
    // authoritative result belongs to a new logical turn and must re-arm the
    // terminal callback guard before it enters the SDK input channel.
    if (options?.delivery !== 'steer' || entry.turn.isSettled) {
      if (entry.turn.isAborted && !entry.turn.isSettled) entry.staleResults = (entry.staleResults ?? 0) + 1;
      entry.pendingError = undefined;
      resetSubagentPhase(this, entry);
      // A new logical turn owns every event from here on. The SDK does not
      // echo prompts back, and only tool turns produce SDK 'user' messages,
      // so waiting for one left text-only turns tagged with the PREVIOUS
      // turn's id — RelayClient then dropped their reply and idle as late.
      entry.turn.beginTurn({ captureNow: true });
    } else if (entry.awaitingSubagents) {
      // An interjection while the turn is held for background subagents: no
      // provider turn is in flight, so this message starts the next one and
      // every event from here on belongs to the interjecting relay turn.
      entry.turn.captureTurnId();
    }

    // Prepend mode-switch signal if mode changed since last message
    const pendingMode = this.pendingModeSignals.get(sessionId);
    if (pendingMode) {
      this.pendingModeSignals.delete(sessionId);
      text = `${modeChangeSignal(pendingMode as SessionMode)}\n\n${text}`;
    }

    // Lazily start the query on first message — the SDK binary needs a
    // prompt to work with, so we pass the first user message directly
    // instead of using the streaming input channel.
    const content = this.buildUserContent(sessionId, text, attachments);
    if (!entry.query) {
      await this.spawnQuery(sessionId, content);
      return;
    }

    entry.inputChannel.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    } as unknown as SDKUserMessage);
  }

  /** Text plus user-attached images as Anthropic content blocks. Images may
   *  arrive inline (base64) or as a content_ref into the AttachmentStore. */
  private buildUserContent(sessionId: string, text: string, attachments?: Attachment[]): string | Array<Record<string, unknown>> {
    const images: Array<Record<string, unknown>> = [];
    for (const att of attachments ?? []) {
      let data: string | undefined;
      let mimeType = att.mimeType;
      if (att.type === 'image') {
        data = att.data;
      } else if (att.type === 'content_ref' && this.attachmentStore) {
        const hit = this.attachmentStore.read(sessionId, att.id);
        if (hit) { data = hit.bytes.toString('base64'); mimeType = hit.meta.mimeType ?? mimeType; }
      }
      if (!data || !/^image\/(png|jpeg|gif|webp)$/.test(mimeType)) continue;
      images.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data } });
    }
    if (images.length === 0) return text;
    return [...(text ? [{ type: 'text', text }] : []), ...images];
  }

  /**
   * Spawn the SDK query() for a session. Called on first sendMessage.
   * Pushes the initial prompt into the streaming input channel so the
   * SDK gets its first user message, then starts the consumer loop for
   * multi-turn conversation.
   */
  setTurnIdentity(sessionId: string, turnId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.turn.relayTurnId = turnId;
    // Keep the previous provider-run snapshot until the next SDK user event;
    // a late callback in the handoff window must not inherit this new ID.
  }

  isTurnSettled(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.turn.isSettled === true;
  }

  lifecycleEvent(entry?: SessionEntry): { turnId?: string } {
    return entry ? entry.turn.event() : {};
  }

  private emitError(sessionId: string, entry: SessionEntry, message: string): void {
    this.onError?.(sessionId, { message, ...this.lifecycleEvent(entry) });
  }

  /** End the turn: reply (or the held error), then idle — once. */
  finishTurn(entry: SessionEntry): boolean {
    const error = entry.pendingError?.message;
    entry.pendingError = undefined;
    return entry.turn.finish({ error });
  }

  private async spawnQuery(sessionId: string, initialPrompt: string | Array<Record<string, unknown>>): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    const { query: queryFn } = await import('@anthropic-ai/claude-agent-sdk');
    const config = entry.deferredConfig;

    // Push the first user message into the channel BEFORE creating the query.
    // The SDK's async iterable reads the first value immediately on start.
    entry.inputChannel.push({
      type: 'user',
      message: { role: 'user', content: initialPrompt },
      parent_tool_use_id: null,
    } as unknown as SDKUserMessage);

    // Wire Kraki MCP server if available, scoped by Kraki session ID
    type McpServerConfig = { type: 'http'; url: string; headers?: Record<string, string> };
    let mcpServers: Record<string, McpServerConfig> | undefined;
    if (this.krakiMcp) {
      mcpServers = {
        kraki: {
          type: 'http' as const,
          url: this.krakiMcp.urlForSession(sessionId),
          headers: { Authorization: `Bearer ${this.krakiMcp.tokenForSession(sessionId)}` },
        },
      };
      logger.info({ sessionId }, 'wired kraki MCP into session');
    }

    const systemPromptContent = this.krakiMcp
      ? `${ClaudeAdapter.SYSTEM_PROMPT}\n\n${ClaudeAdapter.KRAKI_MCP_PROMPT}`
      : ClaudeAdapter.SYSTEM_PROMPT;

    const options: Options = {
      abortController: entry.abortController,
      // Relocate Claude's private transcript INTO the Kraki session dir while
      // reusing the real login (symlinked into the per-session shadow home).
      // Secure storage stays pinned to the real config root so a Keychain-held
      // subscription login is found (see secureStorageEnv).
      env: this.claudeEnv({ CLAUDE_CONFIG_DIR: this.setupShadowHome(sessionId), ...secureStorageEnv() }),
      ...(this.claudeExecutablePath && { pathToClaudeCodeExecutable: this.claudeExecutablePath }),
      ...((entry.model ?? config?.model) && { model: this.sdkModel((entry.model ?? config?.model)!) }),
      ...(config?.cwd && { cwd: config.cwd }),
      ...(config?.resume && { resume: config.resume }),
      ...(config?.fork && { forkSession: true }),
      permissionMode: 'default' as PermissionMode,
      tools: { type: 'preset' as const, preset: 'claude_code' as const },
      systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemPromptContent },
      ...(mcpServers && { mcpServers }),
      includePartialMessages: true,
      // Forward subagent prose (tagged parent_tool_use_id) so Kraki can show
      // what each subagent said in its own steps. Display-only: it does not
      // change how Claude Code runs.
      forwardSubagentText: true,
      canUseTool: makeCanUseToolHandler(this, sessionId, entry.pendingPermissions, entry.pendingQuestions),
      // Kraki's mode is the authority on asking. In `safe`, a local Claude
      // ALLOW rule (settings / "always allow" clicked in the terminal) must not
      // let a side-effecting tool skip the operator; forcing `ask` routes it to
      // canUseTool. Local DENY rules are left to Claude Code and still apply.
      hooks: {
        PreToolUse: [{
          hooks: [async (hookInput: unknown) => {
            const toolName = (hookInput as { tool_name?: string }).tool_name ?? '';
            const mode = this.sessionModes.get(sessionId) ?? DEFAULT_SESSION_MODE;
            if (toolName === 'AskUserQuestion' || krakiAutoApproves(mode, toolNameToKind(toolName))) return {};
            return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'ask' as const } };
          }],
        }],
      },
      ...((entry.reasoningEffort ?? config?.reasoningEffort) && {
        effort: (entry.reasoningEffort ?? config?.reasoningEffort) as Options['effort'],
      }),
    };

    // Use the streaming input iterable — supports multi-turn.
    // The first message is already queued in the channel above.
    const q = queryFn({ prompt: entry.inputIterable, options });

    entry.query = q;
    entry.deferredConfig = undefined;
    // A new query reports its cost from zero again (see lastQueryCost).
    this.lastQueryCost.delete(sessionId);
    entry.consumerLoop = this.consumeMessages(sessionId, q, entry.abortController);
    if (config?.cwd) this.persistMeta(sessionId, { cwd: config.cwd, model: entry.model, reasoningEffort: entry.reasoningEffort });
    logger.debug({ sessionId }, 'SDK query spawned');
  }

  async respondToPermission(
    sessionId: string,
    permissionId: string,
    decision: PermissionDecision,
    reason?: string,
  ): Promise<PermissionResponseResult> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.warn({ sessionId }, 'respondToPermission: session not found');
      return 'session_gone';
    }
    const pending = entry.pendingPermissions.get(permissionId);
    if (!pending) {
      logger.warn({ permissionId }, 'respondToPermission: no pending permission');
      return 'not_found';
    }

    if (decision === 'approve') {
      pending.resolve({ behavior: 'allow', updatedInput: pending.input });
    } else {
      pending.resolve({ behavior: 'deny', message: reason ? `Denied by user: ${reason}` : 'Denied by user' });
    }
    entry.pendingPermissions.delete(permissionId);
    logger.debug({ permissionId, sessionId, decision }, 'permission resolved');
    return 'accepted';
  }

  async respondToQuestion(
    sessionId: string,
    questionId: string,
    answer: QuestionAnswer | string,
    _wasFreeform: boolean,
  ): Promise<QuestionResponseResult> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.warn({ sessionId }, 'respondToQuestion: session not found');
      return 'session_gone';
    }
    const pending = entry.pendingQuestions.get(questionId);
    if (!pending) {
      logger.warn({ questionId }, 'respondToQuestion: no pending question');
      return 'not_found';
    }
    const answerValue = typeof answer === 'string' ? { text: answer } : answer;
    const answerText = answerValue.text || (answerValue.attachments?.length ? 'The user answered with image attachment(s).' : '');

    // SDK schema: AskUserQuestion's `answers` is a Record keyed by each
    // question's `question` TEXT (not a literal "answer" key), and `questions`
    // is required. Passing `{ answer }` here was the bug that made every answer
    // read as "The user did not answer the questions."
    //
    // The SDK may ask 1–4 questions per call. We surface them one card at a
    // time: record this card's answer, then either emit the next question or,
    // once all are answered, resolve the tool permission with the full map.
    const qs = pending.questions ?? [];
    const collected = pending.collected ?? {};
    const index = pending.qIndex ?? 0;
    const thisQuestionText = qs[index]?.question;
    if (thisQuestionText) collected[thisQuestionText] = answerText;

    entry.pendingQuestions.delete(questionId);

    const nextIndex = index + 1;
    if (nextIndex < qs.length) {
      emitQuestionCard(this, sessionId, pending.resolve, qs, nextIndex, collected, entry.pendingQuestions);
      logger.debug({ questionId, sessionId, index, nextIndex, total: qs.length }, 'question answered, advancing');
      return 'accepted';
    }

    pending.resolve({
      behavior: 'allow',
      updatedInput: { questions: qs, answers: collected },
    });
    logger.debug({ questionId, sessionId, answered: Object.keys(collected).length }, 'all questions answered');
    return 'accepted';
  }

  async killSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      broadcastPendingResolutions(this, sessionId);
      entry.inputChannel.end();
      entry.abortController.abort();
      this.sessions.delete(sessionId);
    }
    this.cleanupSessionState(sessionId);
    this.onSessionEnded?.(sessionId, { reason: 'killed' });
    logger.info({ sessionId }, 'session killed');
  }

  async abortSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      // Mark BEFORE interrupting: the SDK's result for the interrupted turn may
      // arrive before interrupt() resolves. RelayClient already snapshotted the
      // live draft into turn_status(user_abort) and owns the aborted idle, so the
      // adapter must not also emit a conclusion bubble / error / idle for it.
      if (entry.awaitingSubagents) {
        // No provider turn is in flight (it ended; only subagents run), so no
        // result will come for it. Settle silently — RelayClient owns the
        // aborted boundary.
        resetSubagentPhase(this, entry);
        entry.turn.settleSilently();
        entry.pendingError = undefined;
      } else if (entry.query && !entry.turn.isSettled) {
        resetSubagentPhase(this, entry);
        entry.turn.abort();
        entry.pendingError = undefined;
      }
      // Stop means stop the delegated work too: a subagent finishing later
      // would wake the parent into a turn nobody is listening to.
      if (entry.query && entry.runningSubagents?.size) {
        for (const taskId of entry.runningSubagents) entry.query.stopTask(taskId).catch(() => {});
      }
      broadcastPendingResolutions(this, sessionId);
      if (entry.query) {
        try {
          await entry.query.interrupt();
        } catch {
          // Interrupt may fail if query already completed
        }
      }
      logger.debug({ sessionId }, 'session aborted');
    }
  }

  /**
   * Kraki's Claude sessions in this process. (The SDK's own listSessions
   * reads ~/.claude/projects, but Kraki's transcripts live in per-session
   * shadow homes, so it never saw them; Kraki titles sessions itself.)
   */
  async listSessions(): Promise<SessionInfo[]> {
    return [...this.sessions.keys()].map((id) => ({
      id,
      state: 'active' as const,
      model: undefined,
      summary: '',
    }));
  }

  /** Why the model list is empty, so `kraki agents` can show the real cause
   *  instead of guessing "not signed in". */
  private lastModelListError: string | undefined;
  override modelListError(): string | undefined {
    return this.cachedModels.length === 0 ? this.lastModelListError : undefined;
  }

  async listModels(): Promise<string[]> {
    return this.cachedModels.map(m => m.id);
  }

  async listModelDetails(): Promise<ModelDetail[]> {
    return this.cachedModels;
  }

  setSessionMode(sessionId: string, mode: SessionMode): void {
    const prev = this.sessionModes.get(sessionId);
    this.sessionModes.set(sessionId, mode);
    if ((prev ?? DEFAULT_SESSION_MODE) !== mode) {
      this.pendingModeSignals.set(sessionId, mode);
    }

    // Also update SDK permission mode on the running query
    const entry = this.sessions.get(sessionId);
    if (entry?.query) {
      entry.query.setPermissionMode('default' as PermissionMode).catch((err) => {
        logger.warn({ err, sessionId }, 'Failed to set SDK permission mode');
      });
    }

    logger.debug({ sessionId, mode }, 'Session permission mode changed');
  }

  async setSessionModel(sessionId: string, model: string, reasoningEffort?: string, _contextTier?: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.warn({ sessionId }, 'setSessionModel: session not found');
      return;
    }
    if (entry.query) {
      await entry.query.setModel(this.sdkModel(model));
      if (reasoningEffort) {
        // The settings layer accepts low..xhigh; `max` is start-time only.
        if (reasoningEffort === 'max') {
          logger.info({ sessionId }, 'effort "max" applies from the next session start');
        } else {
          await entry.query.applyFlagSettings({ effortLevel: reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' });
        }
      }
    }
    entry.model = model;
    if (reasoningEffort) entry.reasoningEffort = reasoningEffort;
    // A query that has not started yet reads the deferred config.
    if (entry.deferredConfig) {
      entry.deferredConfig.model = model;
      if (reasoningEffort) entry.deferredConfig.reasoningEffort = reasoningEffort as CreateSessionConfig['reasoningEffort'];
    }
    // Survive daemon restart / lazy resume.
    this.persistMeta(sessionId, { model, ...(reasoningEffort && { reasoningEffort }) });
    logger.info({ sessionId, model, reasoningEffort }, 'Session model changed');
  }

  getSessionUsage(sessionId: string): SessionUsage | null {
    return this.sessionUsage.get(sessionId) ?? null;
  }

  setSessionUsage(sessionId: string, usage: SessionUsage): void {
    this.sessionUsage.set(sessionId, { ...usage });
  }

  // ── Title generation via throwaway query ──────────

  // ── Title generation (tool-less side-call) ──────────

  async generateTitle(sessionId: string, context: TitleContext): Promise<string | null> {
    // The session's own model is, by construction, reachable with this
    // account/provider. A title needs no big model, though: when this user's
    // own Claude catalog offers a Haiku alias, try it first (cheaper, does not
    // eat an Opus quota), falling back to the session model. Nothing is
    // hardcoded — an account without Haiku just uses the session model.
    const sessionModel = context.model ?? this.sessions.get(sessionId)?.model ?? this.loadMeta(sessionId)?.model;
    const haiku = [...this.modelAliasMap.entries()]
      .find(([, alias]) => alias.replace(/\[[^\]]*\]$/, '') === 'haiku')?.[0];
    const candidates = [...new Set([haiku, sessionModel].filter((m): m is string => !!m))];
    if (candidates.length === 0) candidates.push('');
    for (const model of candidates) {
      const title = await this.runTitleQuery(sessionId, context, model || undefined);
      if (title) return title;
    }
    return null;
  }

  private async runTitleQuery(sessionId: string, context: TitleContext, model?: string): Promise<string | null> {
    const supportsEffort = model ? this.cachedModels.find((m) => m.id === model)?.supportsReasoningEffort : false;
    // A hung side-call must not pin the session's "title in flight" state.
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 60_000);
    timer.unref?.();
    try {
      const { query: queryFn } = await import('@anthropic-ai/claude-agent-sdk');
      let raw = '';
      const q = queryFn({
        prompt: buildTitlePrompt(context),
        options: {
          abortController,
          ...(this.claudeExecutablePath && { pathToClaudeCodeExecutable: this.claudeExecutablePath }),
          env: this.claudeEnv(secureStorageEnv()),
          systemPrompt: TITLE_SYSTEM_PROMPT,
          ...(model && { model: this.sdkModel(model) }),
          ...(supportsEffort && { effort: 'low' as Options['effort'] }),
          // A pure text side-call: no tools, no MCP, no filesystem settings, no
          // transcript, and every permission denied. The prompt contains user
          // text, so it must never be able to act on the machine.
          tools: [],
          settingSources: [],
          canUseTool: async () => ({ behavior: 'deny' as const, message: 'Title generation has no tools' }),
          maxTurns: 1,
          persistSession: false,
        },
      });
      for await (const msg of q) {
        if (msg.type === 'result') raw = (msg as unknown as { result?: string }).result ?? '';
      }
      return cleanTitle(raw);
    } catch (err) {
      logger.warn({ err: (err as Error).message, sessionId, model }, 'Title generation failed');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Message consumer loop ──────────────────────────

  /**
   * Consume the SDKMessage async generator and map messages to adapter callbacks.
   * Runs for the lifetime of the session query.
   */
  private async consumeMessages(sessionId: string, q: Query, abortController?: AbortController): Promise<void> {
    try {
      for await (const msg of q) {
        try {
          handleSDKMessage(this, sessionId, msg);
        } catch (err) {
          logger.error({ err, sessionId, type: msg.type }, 'Error handling SDK message');
        }
      }

      // Query completed normally. A result event is the authoritative turn
      // boundary; only fall back here when the SDK ended without one.
      const entry = this.sessions.get(sessionId);
      if (entry) {
        resetSubagentPhase(this, entry);
        this.finishTurn(entry); // a user stop settles silently
      } else {
        this.onIdle?.(sessionId);
      }
      // Input is a long-lived stream, so a normal end means the CLI process
      // exited (killSession removes its entry first). Keeping the entry would
      // push the next message into a channel nobody reads; evict it so the
      // next message resumes the session, as the error path does.
      if (entry && this.sessions.get(sessionId) === entry && !abortController?.signal.aborted) {
        broadcastPendingResolutions(this, sessionId);
        try { entry.inputChannel.end(); } catch { /* already closed */ }
        this.sessions.delete(sessionId);
        this.onSessionEvicted?.(sessionId);
      }
    } catch (err) {
      // stop()/killSession() abort the controller on purpose; the SDK surfaces
      // that as a plain Error("Operation aborted"), not an AbortError. That is
      // a clean shutdown, never a session error.
      if ((err as Error).name === 'AbortError' || abortController?.signal.aborted) {
        logger.debug({ sessionId }, 'Session query aborted');
        return;
      }
      logger.error({ err, sessionId }, 'Session consumer loop error');
      const entry = this.sessions.get(sessionId);
      if (entry) resetSubagentPhase(this, entry);
      if (entry) {
        // Settle the turn that was running when the process died so the
        // relay freezes it as failed instead of waiting forever. (A user stop
        // settles silently; a settled turn still gets the error reported.)
        const message = getErrorMessage(err);
        if (entry.turn.isSettled) this.emitError(sessionId, entry, message);
        else {
          entry.pendingError = undefined;
          entry.turn.finish({ error: message });
        }
        broadcastPendingResolutions(this, sessionId);
        try { entry.inputChannel.end(); } catch { /* already closed */ }
        // The process is gone but the transcript is intact. Drop the dead
        // entry and report an eviction (like Pi/Codex), so the next message
        // lazily resumes instead of being pushed into a dead input channel.
        if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId);
      } else {
        this.onError?.(sessionId, { message: getErrorMessage(err) });
      }
      this.onSessionEvicted?.(sessionId);
    }
  }

  /** A tool (or question) follows: the prose before it was narration. */
  flushNarration(sessionId: string): void {
    this.sessions.get(sessionId)?.turn.toolStarted();
  }

  emitCompaction(sessionId: string, event: Omit<import('./base.js').CompactionEvent, 'turnId'>): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (event.phase === 'start') {
      if (entry.compacting) return;
      entry.compacting = true;
    } else {
      if (!entry.compacting) return;
      entry.compacting = false;
    }
    this.onCompaction?.(sessionId, { ...event, ...this.lifecycleEvent(entry) });
  }

  static SUBAGENT_CONTINUATION_GRACE_MS = 5_000;

  // ── Permission handler ────────────────────────────

  // ── Helpers ───────────────────────────────────────

  private cleanupSessionState(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry?.subagentSettleTimer) clearTimeout(entry.subagentSettleTimer);
    this.sessionModes.delete(sessionId);
    this.pendingModeSignals.delete(sessionId);
    this.sessionUsage.delete(sessionId);
    this.lastCountedResponse.delete(sessionId);
    this.lastQueryCost.delete(sessionId);
    this.pendingToolCalls.delete(sessionId);
    this.sdkSessionIds.delete(sessionId);
  }

  updateUsage(sessionId: string, usage: Record<string, unknown>, fromSubagent = false): void {
    const prev = this.sessionUsage.get(sessionId) ?? {
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0,
      totalCost: 0, totalDurationMs: 0,
    };
    const updated: SessionUsage = {
      inputTokens: prev.inputTokens + ((usage.input_tokens as number) ?? 0),
      outputTokens: prev.outputTokens + ((usage.output_tokens as number) ?? 0),
      cacheReadTokens: prev.cacheReadTokens + ((usage.cache_read_input_tokens as number) ?? 0),
      cacheWriteTokens: prev.cacheWriteTokens + ((usage.cache_creation_input_tokens as number) ?? 0),
      totalCost: prev.totalCost,
      totalDurationMs: prev.totalDurationMs,
      // Prompt size of the latest call = how full the context window is.
      // A subagent's prompt is its own window, not the parent's.
      contextTokens: fromSubagent ? prev.contextTokens : ((usage.input_tokens as number) ?? 0)
        + ((usage.cache_read_input_tokens as number) ?? 0)
        + ((usage.cache_creation_input_tokens as number) ?? 0) || prev.contextTokens,
    };
    this.sessionUsage.set(sessionId, updated);
    this.onUsageUpdate?.(sessionId, updated);
  }

  cacheModelsFromInit(sysMsg: SDKSystemMessage): void {
    try {
      const models = (sysMsg as unknown as { models?: Array<{ id: string; name?: string }> }).models;
      // start() already built the resolved, de-duplicated catalog (aliases,
      // effort levels). Only fall back to the raw init list when it is empty.
      if (this.cachedModels.length === 0 && Array.isArray(models) && models.length > 0) {
        this.cachedModels = models.map(m => ({
          id: m.id,
          name: m.name ?? m.id,
          supportsReasoningEffort: true,
        }));
      }
    } catch {
      // Models not available in init message — that's fine
    }
  }
}
