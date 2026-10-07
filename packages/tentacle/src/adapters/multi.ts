/**
 * Multi-agent adapter — manages multiple sub-adapters behind a single
 * AgentAdapter interface.
 *
 * The tentacle runtime (RelayClient, SessionManager) only see *one*
 * adapter instance.  MultiAgentAdapter routes session operations to
 * the sub-adapter that owns each session and aggregates model lists.
 *
 * Agent detection:
 *  - Copilot: `@github/copilot-sdk` importable + `gh auth token` succeeds
 *  - Claude:  `@anthropic-ai/claude-agent-sdk` importable + `claude` CLI on PATH
 */

import { claudeSdkExecutable } from '../cli-launch.js';
import { findAppBundledCli } from '../agent-paths.js';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import type { ModelDetail, SessionUsage, AgentId, AgentCapabilities, Attachment } from '@kraki/protocol';
import {
  AgentAdapter,
  type CreateSessionConfig,
  type SessionInfo,
  type PermissionDecision,
  type QuestionAnswer,
  type QuestionResponseResult,
  type PermissionResponseResult,
  type SendMessageOptions,
} from './base.js';
import type { SessionContext } from '../session-manager.js';
import { createLogger } from '../logger.js';

const logger = createLogger('multi-adapter');

// ── Detection helpers ───────────────────────────────────

// Each SDK is probed via a string-literal dynamic import so esbuild can
// statically bundle the module into the SEA binary. A previous version
// used a generic `canImport(specifier)` helper, but a variable-specifier
// `import()` collapses to a runtime `require()` lookup, which fails
// inside the SEA bundle (no node_modules tree alongside the binary).
async function canImportCopilotSdk(): Promise<boolean> {
  try {
    await import('@github/copilot-sdk');
    return true;
  } catch (err) {
    logger.debug({ error: (err as Error).message }, '@github/copilot-sdk import failed');
    return false;
  }
}

async function canImportClaudeSdk(): Promise<boolean> {
  try {
    await import('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch (err) {
    logger.debug({ error: (err as Error).message }, '@anthropic-ai/claude-agent-sdk import failed');
    return false;
  }
}

function cliExists(name: string): boolean {
  return resolveCliPath(name) !== undefined;
}

/**
 * Resolve the absolute path to a CLI on PATH, or undefined if not present.
 * Preserve PATH order from `where` (Windows) and `which` (Unix), skipping
 * non-executable POSIX shims on Windows. Return an absolute path for callers
 * that need the binary location (e.g. Claude SDK's
 * pathToClaudeCodeExecutable, which is required when running inside SEA
 * binaries because the SDK's own resolution via createRequire/import.meta
 * cannot find a node_modules tree).
 */
export function selectCliPath(output: string, os = platform()): string | undefined {
  const paths = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // npm installs an extensionless POSIX script beside its Windows .cmd shim.
  // `where codex` lists that script first; CreateProcess cannot execute it.
  return os === 'win32'
    ? paths.find((path) => /\.(?:exe|com|cmd|bat)$/i.test(path))
    : paths[0];
}

/** PATH first, then the CLI bundled in the agent's desktop app (see agent-paths.ts). */
export function resolveCliPath(name: string): string | undefined {
  try {
    const cmd = platform() === 'win32' ? `where ${name}` : `which ${name}`;
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const onPath = selectCliPath(out);
    if (onPath) return onPath;
  } catch { /* not on PATH */ }
  return findAppBundledCli(name);
}

/** Detect which agents can be started on this machine. */
export async function detectAvailableAgents(): Promise<AgentId[]> {
  const agents: AgentId[] = [];

  // Copilot: SDK importable + `copilot` CLI on PATH
  const copilotSdk = await canImportCopilotSdk();
  const copilotCli = cliExists('copilot');
  if (copilotSdk && copilotCli) {
    agents.push('copilot');
    logger.info('Detected Copilot: SDK + copilot CLI OK');
  } else {
    logger.debug({ sdk: copilotSdk, cli: copilotCli }, 'Copilot not available');
  }

  // Claude: SDK importable + `claude` CLI on PATH
  const claudeSdk = await canImportClaudeSdk();
  const claudeCli = cliExists('claude');
  if (claudeSdk && claudeCli) {
    agents.push('claude');
    logger.info('Detected Claude Code: SDK + claude CLI OK');
  } else {
    logger.debug({ sdk: claudeSdk, cli: claudeCli }, 'Claude Code not available');
  }

  // pi: `pi` CLI on PATH (package @earendil-works/pi-coding-agent)
  if (cliExists('pi')) {
    agents.push('pi');
    logger.info('Detected pi: pi CLI OK');
  } else {
    logger.debug('pi not available');
  }

  // codex: `codex` CLI on PATH (package @openai/codex). Login is verified at
  // adapter start (account/read) so an unauthenticated install is skipped.
  if (cliExists('codex')) {
    agents.push('codex');
    logger.info('Detected Codex: codex CLI OK');
  } else {
    logger.debug('codex not available');
  }

  return agents;
}

// ── Adapter options ─────────────────────────────────────

export interface MultiAgentAdapterOptions {
  /** Override auto-detection: only start these agents. */
  agentIds?: AgentId[];
  /** Passed through to sub-adapters that need it. */
  attachmentStore?: import('../attachment-store.js').AttachmentStore;
  /** Kraki MCP server info (optional). */
  krakiMcp?: { urlForSession: (sid: string) => string; tokenForSession: (sessionId: string) => string };
}

/**
 * Build the adapter for one agent (not started). Shared by the daemon and by
 * `kraki agents --json`, so the setup check exercises exactly what sessions
 * will use. Returns null when the agent's CLI cannot be resolved.
 */
export async function createAgentAdapter(
  id: AgentId,
  adapterOpts: Pick<MultiAgentAdapterOptions, 'attachmentStore' | 'krakiMcp'> = {},
): Promise<AgentAdapter | null> {
  if (id === 'copilot') {
    const { CopilotAdapter } = await import('./copilot.js');
    return new CopilotAdapter(adapterOpts);
  }
  if (id === 'claude') {
    const { ClaudeAdapter } = await import('./claude.js');
    // Claude SDK uses createRequire(import.meta.url) and fileURLToPath to
    // locate the bundled `claude` binary. Inside our SEA binary that path
    // resolution fails (no node_modules next to the executable), so we
    // resolve the system-installed `claude` path up-front and hand it to
    // the adapter via pathToClaudeCodeExecutable.
    return new ClaudeAdapter({ ...adapterOpts, claudeExecutablePath: claudeSdkExecutable(resolveCliPath('claude')) });
  }
  if (id === 'pi') {
    const { PiAdapter } = await import('./pi.js');
    const piPath = resolveCliPath('pi');
    if (!piPath) { logger.warn('pi CLI path unresolved, skipping'); return null; }
    // pi has no MCP; it only needs the attachment store to externalize
    // image bytes from its show_image tool (krakiMcp is not applicable).
    return new PiAdapter({ cliPath: piPath, attachmentStore: adapterOpts.attachmentStore });
  }
  if (id === 'codex') {
    const { CodexAdapter } = await import('./codex.js');
    const codexPath = resolveCliPath('codex');
    if (!codexPath) { logger.warn('codex CLI path unresolved, skipping'); return null; }
    // Kraki tools (ask_user / show_image / kraki_get_mode) are hosted by the
    // adapter as Codex dynamic tools, so krakiMcp is not needed.
    return new CodexAdapter({ cliPath: codexPath, attachmentStore: adapterOpts.attachmentStore });
  }
  logger.warn({ id }, 'Unknown agent ID, skipping');
  return null;
}

// ── MultiAgentAdapter ───────────────────────────────────

export class MultiAgentAdapter extends AgentAdapter {
  private adapters = new Map<AgentId, AgentAdapter>();
  private sessionAgent = new Map<string, AgentId>();
  private opts: MultiAgentAdapterOptions;

  constructor(opts: MultiAgentAdapterOptions) {
    super();
    this.opts = opts;
  }

  // ── Lifecycle ───────────────────────────────────────

  async start(): Promise<void> {
    const ids = this.opts.agentIds ?? await detectAvailableAgents();
    if (ids.length === 0) {
      throw new Error(
        'No coding agents available. Install Copilot CLI (gh auth login) ' +
        'or Claude Code, pi, or Codex CLI to get started.',
      );
    }

    const adapterOpts = {
      attachmentStore: this.opts.attachmentStore,
      ...(this.opts.krakiMcp && { krakiMcp: this.opts.krakiMcp }),
    };

    // Start agents in parallel: each one spawns its CLI and lists models, and
    // the sum easily exceeded the daemon's readiness window on a cold machine.
    // Insert in detection order so the default agent stays deterministic.
    const started = await Promise.all(ids.map((id) => this.startAgent(id, adapterOpts)));
    started.forEach((ok, i) => { if (!ok) this.failedAgentIds.add(ids[i]); });

    if (this.adapters.size === 0) {
      logger.warn({ agents: ids }, 'No agent adapter started yet; retrying in the background');
    } else {
      logger.info({ agents: [...this.adapters.keys()] }, 'Multi-agent adapter ready');
    }
    if (this.failedAgentIds.size > 0) this.scheduleAgentRetry(adapterOpts, 60_000);
  }

  /** Agents that were detected but failed to start (e.g. signed out). */
  private failedAgentIds = new Set<AgentId>();
  private agentRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  private async startAgent(id: AgentId, adapterOpts: Parameters<typeof createAgentAdapter>[1]): Promise<boolean> {
    try {
      const adapter = await createAgentAdapter(id, adapterOpts);
      if (!adapter) return false;
      this.wireCallbacks(id, adapter);
      await adapter.start();
      if (this.stopped) { await adapter.stop().catch(() => {}); return false; }
      this.adapters.set(id, adapter);
      logger.info({ id }, 'Agent adapter started');
      return true;
    } catch (err) {
      logger.warn({ id, err: (err as Error).message }, 'Agent adapter failed to start');
      return false;
    }
  }

  /**
   * Keep retrying agents that failed at startup (a user who signs in to Claude
   * after the daemon started should not need to restart it). Backs off to
   * 15 minutes; apps are re-greeted when an agent comes up.
   */
  private scheduleAgentRetry(adapterOpts: Parameters<typeof createAgentAdapter>[1], delayMs: number): void {
    if (this.stopped) return;
    this.agentRetryTimer = setTimeout(async () => {
      this.agentRetryTimer = undefined;
      let recovered = false;
      for (const id of [...this.failedAgentIds]) {
        if (await this.startAgent(id, adapterOpts)) {
          this.failedAgentIds.delete(id);
          recovered = true;
        }
      }
      if (recovered) this.onCapabilitiesChanged?.();
      if (this.failedAgentIds.size > 0) this.scheduleAgentRetry(adapterOpts, Math.min(delayMs * 2, 15 * 60_000));
    }, delayMs);
    this.agentRetryTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.agentRetryTimer) clearTimeout(this.agentRetryTimer);
    const stops = [...this.adapters.entries()].map(async ([id, adapter]) => {
      try {
        await adapter.stop();
      } catch (err) {
        logger.warn({ id, err: (err as Error).message }, 'Error stopping adapter');
      }
    });
    await Promise.all(stops);
    this.adapters.clear();
    this.sessionAgent.clear();
  }

  // ── Agent capabilities ──────────────────────────────

  /** Get per-agent capabilities for the greeting / device capabilities. */
  async getAgentCapabilities(): Promise<AgentCapabilities[]> {
    const caps: AgentCapabilities[] = [];
    for (const [id, adapter] of this.adapters) {
      const modelDetails = await adapter.listModelDetails();
      caps.push({
        type: 'code',
        id,
        models: modelDetails.map(m => m.id),
        modelDetails,
      });
    }
    return caps;
  }

  // ── Model aggregation ──────────────────────────────

  async listModels(): Promise<string[]> {
    const all: string[] = [];
    for (const adapter of this.adapters.values()) {
      all.push(...await adapter.listModels());
    }
    return all;
  }

  async listModelDetails(): Promise<ModelDetail[]> {
    const all: ModelDetail[] = [];
    for (const adapter of this.adapters.values()) {
      all.push(...await adapter.listModelDetails());
    }
    return all;
  }

  // ── Session management ──────────────────────────────

  async createSession(config: CreateSessionConfig): Promise<{ sessionId: string }> {
    const agentId = config.agentId ?? this.defaultAgentId();
    const adapter = this.adapters.get(agentId);
    if (!adapter) {
      throw new Error(`Agent '${agentId}' is not available. Available: ${[...this.adapters.keys()].join(', ')}`);
    }

    const result = await adapter.createSession(config);
    this.sessionAgent.set(result.sessionId, agentId);
    return result;
  }

  async resumeSession(sessionId: string, context?: SessionContext): Promise<{ sessionId: string }> {
    const adapter = this.resolveAdapter(sessionId, context);
    const result = await adapter.resumeSession(sessionId, context);
    // Ensure mapping exists (resume may change the effective sessionId)
    if (!this.sessionAgent.has(result.sessionId)) {
      this.sessionAgent.set(result.sessionId, this.agentIdFor(adapter));
    }
    return result;
  }

  async forkSession(sourceSessionId: string, newSessionId: string): Promise<{ sessionId: string }> {
    const adapter = this.getSessionAdapter(sourceSessionId);
    const result = await adapter.forkSession(sourceSessionId, newSessionId);
    this.sessionAgent.set(result.sessionId, this.sessionAgent.get(sourceSessionId)!);
    return result;
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: Attachment[],
    options?: SendMessageOptions,
  ): Promise<void> {
    return this.getSessionAdapter(sessionId).sendMessage(sessionId, text, attachments, options);
  }

  async respondToPermission(sessionId: string, permissionId: string, decision: PermissionDecision, reason?: string): Promise<PermissionResponseResult> {
    return reason
      ? this.getSessionAdapter(sessionId).respondToPermission(sessionId, permissionId, decision, reason)
      : this.getSessionAdapter(sessionId).respondToPermission(sessionId, permissionId, decision);
  }

  async respondToQuestion(sessionId: string, questionId: string, answer: QuestionAnswer | string, wasFreeform: boolean): Promise<QuestionResponseResult> {
    return this.getSessionAdapter(sessionId).respondToQuestion(sessionId, questionId, answer, wasFreeform);
  }

  async killSession(sessionId: string): Promise<void> {
    const adapter = this.getSessionAdapter(sessionId);
    await adapter.killSession(sessionId);
    this.sessionAgent.delete(sessionId);
  }

  async abortSession(sessionId: string): Promise<void> {
    return this.getSessionAdapter(sessionId).abortSession(sessionId);
  }

  async listSessions(): Promise<SessionInfo[]> {
    const all: SessionInfo[] = [];
    for (const adapter of this.adapters.values()) {
      all.push(...await adapter.listSessions());
    }
    return all;
  }

  setSessionMode(sessionId: string, mode: import('@kraki/protocol').SessionMode): void {
    this.getSessionAdapter(sessionId).setSessionMode(sessionId, mode);
  }

  async setSessionModel(sessionId: string, model: string, reasoningEffort?: string, contextTier?: string): Promise<void> {
    return this.getSessionAdapter(sessionId).setSessionModel(sessionId, model, reasoningEffort, contextTier);
  }

  getSessionUsage(sessionId: string): SessionUsage | null {
    return this.getSessionAdapter(sessionId).getSessionUsage(sessionId);
  }

  setSessionUsage(sessionId: string, usage: SessionUsage): void {
    this.getSessionAdapter(sessionId).setSessionUsage(sessionId, usage);
  }

  async generateTitle(sessionId: string, context: import('./title.js').TitleContext): Promise<string | null> {
    // A session is titled by ITS OWN agent, on its own account and model —
    // never by whichever adapter happens to be registered first. If that
    // agent is not running, there is no title rather than a cross-agent call.
    const agentId = (context.agent as AgentId | undefined) ?? this.sessionAgent.get(sessionId);
    const adapter = agentId ? this.adapters.get(agentId) : undefined;
    if (!adapter) {
      logger.debug({ sessionId, agentId }, 'title: session agent unavailable, skipping');
      return null;
    }
    return adapter.generateTitle(sessionId, context);
  }

  /** Record a session's agent even when that agent is not running now: the
   *  session must then fail with "not available", never fall back to another
   *  agent (and it routes correctly once the agent starts). */
  override registerSessionAgent(sessionId: string, agentId: string): void {
    if (agentId) this.sessionAgent.set(sessionId, agentId as AgentId);
  }

  // ── Internal helpers ────────────────────────────────

  private defaultAgentId(): AgentId {
    return this.adapters.keys().next().value!;
  }

  private getSessionAdapter(sessionId: string): AgentAdapter {
    return this.adapterForSession(sessionId);
  }

  /** Resolve adapter for resume — uses pre-registered mapping or falls back. */
  private resolveAdapter(sessionId: string, _context?: SessionContext): AgentAdapter {
    const adapter = this.adapterForSession(sessionId);
    if (!this.sessionAgent.has(sessionId)) this.sessionAgent.set(sessionId, this.agentIdFor(adapter));
    return adapter;
  }

  /**
   * The adapter that owns a session. A session whose agent is not running on
   * this computer (e.g. Claude Code is signed out) must fail with that reason —
   * routing it to another agent would resume or send into a foreign session.
   * Only sessions with no recorded agent (created before multi-agent support,
   * all Copilot) fall back to Copilot.
   */
  private adapterForSession(sessionId: string): AgentAdapter {
    const agentId = this.sessionAgent.get(sessionId);
    if (agentId) {
      const adapter = this.adapters.get(agentId);
      if (adapter) return adapter;
      throw new Error(`${agentLabel(agentId)} is not available on this computer`);
    }
    const legacy = this.adapters.get('copilot');
    if (legacy) {
      logger.warn({ sessionId }, 'No agent mapping for session; treating it as a legacy Copilot session');
      return legacy;
    }
    throw new Error(`No agent is recorded for session ${sessionId}`);
  }

  private agentIdFor(adapter: AgentAdapter): AgentId {
    for (const [id, a] of this.adapters) {
      if (a === adapter) return id;
    }
    return this.defaultAgentId();
  }

  /** Wire all on* callbacks from a sub-adapter to our own callbacks. */
  private wireCallbacks(id: AgentId, adapter: AgentAdapter): void {
    adapter.onSessionCreated = (event) => {
      this.sessionAgent.set(event.sessionId, id);
      this.onSessionCreated?.(event);
    };
    adapter.onMessage = (sid, e) => this.onMessage?.(sid, e);
    adapter.onCapabilitiesChanged = () => this.onCapabilitiesChanged?.();
    adapter.onMessageDelta = (sid, e) => this.onMessageDelta?.(sid, e);
    adapter.onNarration = (sid, e) => this.onNarration?.(sid, e);
    adapter.onNarrationTrace = (sid, e) => this.onNarrationTrace?.(sid, e);
    adapter.onPermissionRequest = (sid, e) => this.onPermissionRequest?.(sid, e);
    adapter.onPermissionAutoResolved = (sid, pid, r) => this.onPermissionAutoResolved?.(sid, pid, r);
    adapter.onQuestionAutoResolved = (sid, qid) => this.onQuestionAutoResolved?.(sid, qid);
    adapter.onQuestionRequest = (sid, e) => this.onQuestionRequest?.(sid, e);
    adapter.onToolStart = (sid, e) => this.onToolStart?.(sid, e);
    adapter.onToolComplete = (sid, e) => this.onToolComplete?.(sid, e);
    adapter.onIdle = (sid, e) => this.onIdle?.(sid, e);
    adapter.onFlushComplete = (sid) => this.onFlushComplete?.(sid);
    adapter.onError = (sid, e) => this.onError?.(sid, e);
    adapter.onCompaction = (sid, e) => this.onCompaction?.(sid, e);
    adapter.onSystemMessage = (sid, e) => this.onSystemMessage?.(sid, e);
    adapter.onSessionEnded = (sid, e) => {
      this.sessionAgent.delete(sid);
      this.onSessionEnded?.(sid, e);
    };
    adapter.onSessionEvicted = (sid) => {
      // Eviction frees the idle child process but the session persists on disk
      // and can be lazily resumed by THIS adapter. Keep the agent mapping so
      // later ops (fork/sendMessage/resume) route to the correct adapter rather
      // than falling back to the first one. The mapping is dropped only on
      // permanent end (onSessionEnded) or killSession.
      this.onSessionEvicted?.(sid);
    };
    adapter.onTitleChanged = (sid, t) => this.onTitleChanged?.(sid, t);
    adapter.onUsageUpdate = (sid, u) => this.onUsageUpdate?.(sid, u);
  }

  setTurnIdentity(sessionId: string, turnId: string): void {
    this.getSessionAdapter(sessionId).setTurnIdentity(sessionId, turnId);
  }

  isTurnSettled(sessionId: string): boolean {
    return this.getSessionAdapter(sessionId).isTurnSettled(sessionId);
  }
}

function agentLabel(agentId: string): string {
  return ({ claude: 'Claude Code', copilot: 'GitHub Copilot', codex: 'Codex', pi: 'Pi' } as Record<string, string>)[agentId] ?? agentId;
}

