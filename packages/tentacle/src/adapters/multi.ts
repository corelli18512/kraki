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

import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import type { ModelDetail, SessionUsage, AgentId, AgentCapabilities, Attachment } from '@kraki/protocol';
import {
  AgentAdapter,
  type CreateSessionConfig,
  type SessionInfo,
  type PermissionDecision,
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
  try {
    const cmd = platform() === 'win32' ? `where ${name}` : `which ${name}`;
    execSync(cmd, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
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

  return agents;
}

// ── Adapter options ─────────────────────────────────────

export interface MultiAgentAdapterOptions {
  /** Override auto-detection: only start these agents. */
  agentIds?: AgentId[];
  /** Passed through to sub-adapters that need it. */
  attachmentStore?: import('../attachment-store.js').AttachmentStore;
  /** Kraki MCP server info (optional). */
  krakiMcp?: { urlForSession: (sid: string) => string; bearerToken: string };
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
        'or Claude Code CLI (npm i -g @anthropic-ai/claude-code) to get started.',
      );
    }

    const adapterOpts = {
      attachmentStore: this.opts.attachmentStore,
      ...(this.opts.krakiMcp && { krakiMcp: this.opts.krakiMcp }),
    };

    for (const id of ids) {
      try {
        let adapter: AgentAdapter;
        if (id === 'copilot') {
          const { CopilotAdapter } = await import('./copilot.js');
          adapter = new CopilotAdapter(adapterOpts);
        } else if (id === 'claude') {
          const { ClaudeAdapter } = await import('./claude.js');
          adapter = new ClaudeAdapter(adapterOpts);
        } else {
          logger.warn({ id }, 'Unknown agent ID, skipping');
          continue;
        }

        this.wireCallbacks(id, adapter);
        await adapter.start();
        this.adapters.set(id, adapter);
        logger.info({ id }, 'Agent adapter started');
      } catch (err) {
        logger.warn({ id, err: (err as Error).message }, 'Agent adapter failed to start — skipping');
      }
    }

    if (this.adapters.size === 0) {
      throw new Error('All agent adapters failed to start.');
    }

    logger.info({ agents: [...this.adapters.keys()] }, 'Multi-agent adapter ready');
  }

  async stop(): Promise<void> {
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

  async sendMessage(sessionId: string, text: string, attachments?: Attachment[]): Promise<void> {
    return this.getSessionAdapter(sessionId).sendMessage(sessionId, text, attachments);
  }

  async respondToPermission(sessionId: string, permissionId: string, decision: PermissionDecision): Promise<void> {
    return this.getSessionAdapter(sessionId).respondToPermission(sessionId, permissionId, decision);
  }

  async respondToQuestion(sessionId: string, questionId: string, answer: string, wasFreeform: boolean): Promise<void> {
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

  setSessionMode(sessionId: string, mode: 'safe' | 'discuss' | 'execute' | 'delegate'): void {
    this.getSessionAdapter(sessionId).setSessionMode(sessionId, mode);
  }

  async setSessionModel(sessionId: string, model: string, reasoningEffort?: string): Promise<void> {
    return this.getSessionAdapter(sessionId).setSessionModel(sessionId, model, reasoningEffort);
  }

  getSessionUsage(sessionId: string): SessionUsage | null {
    return this.getSessionAdapter(sessionId).getSessionUsage(sessionId);
  }

  setSessionUsage(sessionId: string, usage: SessionUsage): void {
    this.getSessionAdapter(sessionId).setSessionUsage(sessionId, usage);
  }

  async generateTitle(context: Parameters<AgentAdapter['generateTitle']>[0]): Promise<string | null> {
    // Use the first available adapter for title generation
    const adapter = this.adapters.values().next().value;
    return adapter ? adapter.generateTitle(context) : null;
  }

  override registerSessionAgent(sessionId: string, agentId: string): void {
    if (this.adapters.has(agentId as AgentId)) {
      this.sessionAgent.set(sessionId, agentId as AgentId);
    }
  }

  // ── Internal helpers ────────────────────────────────

  private defaultAgentId(): AgentId {
    return this.adapters.keys().next().value!;
  }

  private getSessionAdapter(sessionId: string): AgentAdapter {
    const agentId = this.sessionAgent.get(sessionId);
    if (agentId) {
      const adapter = this.adapters.get(agentId);
      if (adapter) return adapter;
    }
    // Fallback: try first adapter (session might have been created before multi-adapter)
    logger.warn({ sessionId }, 'No agent mapping for session, falling back to first adapter');
    for (const adapter of this.adapters.values()) {
      return adapter;
    }
    throw new Error(`No adapter available for session ${sessionId}`);
  }

  /** Resolve adapter for resume — uses pre-registered mapping or falls back. */
  private resolveAdapter(sessionId: string, _context?: SessionContext): AgentAdapter {
    // If we already know the mapping (via registerSessionAgent or prior create), use it
    const known = this.sessionAgent.get(sessionId);
    if (known) {
      const adapter = this.adapters.get(known);
      if (adapter) return adapter;
    }

    // Fallback to first adapter
    const fallback = this.defaultAgentId();
    this.sessionAgent.set(sessionId, fallback);
    return this.adapters.get(fallback)!;
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
    adapter.onMessageDelta = (sid, e) => this.onMessageDelta?.(sid, e);
    adapter.onPermissionRequest = (sid, e) => this.onPermissionRequest?.(sid, e);
    adapter.onPermissionAutoResolved = (sid, pid, r) => this.onPermissionAutoResolved?.(sid, pid, r);
    adapter.onQuestionAutoResolved = (sid, qid) => this.onQuestionAutoResolved?.(sid, qid);
    adapter.onQuestionRequest = (sid, e) => this.onQuestionRequest?.(sid, e);
    adapter.onToolStart = (sid, e) => this.onToolStart?.(sid, e);
    adapter.onToolComplete = (sid, e) => this.onToolComplete?.(sid, e);
    adapter.onAttachmentBytes = (sid, e) => this.onAttachmentBytes?.(sid, e);
    adapter.onIdle = (sid) => this.onIdle?.(sid);
    adapter.onFlushComplete = (sid) => this.onFlushComplete?.(sid);
    adapter.onError = (sid, e) => this.onError?.(sid, e);
    adapter.onSessionEnded = (sid, e) => {
      this.sessionAgent.delete(sid);
      this.onSessionEnded?.(sid, e);
    };
    adapter.onSessionEvicted = (sid) => {
      this.sessionAgent.delete(sid);
      this.onSessionEvicted?.(sid);
    };
    adapter.onTitleChanged = (sid, t) => this.onTitleChanged?.(sid, t);
    adapter.onUsageUpdate = (sid, u) => this.onUsageUpdate?.(sid, u);
  }
}
