/**
 * PiAdapter — bridges Kraki's tentacle to the pi coding agent
 * (`@earendil-works/pi-coding-agent`) via its `--mode rpc` JSON protocol.
 *
 * Design (pi-first, no backward-compat constraints):
 *  - **process-per-session**: every Kraki session owns one `pi --mode rpc`
 *    child. True isolation — one crash never touches another. Memory is
 *    bounded by killing idle children; pi re-resumes from its jsonl on the
 *    next message (lazy resume).
 *  - **permission = tool gating**: discuss → read-only tool set; execute /
 *    delegate → full tools; safe → read-only (writes blocked). No per-call
 *    UI round-trip — mode is a spawn-time tool restriction.
 *  - native fork/tree via pi's `fork` / `get_tree` RPC commands.
 */

import { randomUUID } from 'node:crypto';
import {
  AgentAdapter,
  type CreateSessionConfig,
  type SessionInfo,
  type PermissionDecision,
} from './base.js';
import { PiRpcProcess } from './pi-rpc-client.js';
import type { SessionContext } from '../session-manager.js';
import type { ModelDetail, SessionUsage, ReasoningEffort } from '@kraki/protocol';
import { createLogger } from '../logger.js';

const logger = createLogger('pi-adapter');

type Mode = 'safe' | 'discuss' | 'execute' | 'delegate';
const READONLY_TOOLS = ['read', 'grep', 'find', 'ls'];
const MUTATING_DEFAULT_MODE: Mode = 'discuss';

function toolsForMode(mode: Mode): string[] | undefined {
  // discuss / safe → read-only; execute / delegate → all tools (undefined = pi default set)
  return mode === 'execute' || mode === 'delegate' ? undefined : READONLY_TOOLS;
}

/** Kraki ReasoningEffort → pi ThinkingLevel. pi tops out at xhigh; "max" maps there. */
function effortToThinking(effort?: string): string | undefined {
  switch (effort) {
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh':
    case 'max': return 'xhigh';
    default: return undefined;
  }
}

interface PiSession {
  proc: PiRpcProcess;
  cwd: string;
  model: string;
  mode: Mode;
  thinking?: string;
  sessionFile?: string;
  usage: SessionUsage;
  lastActivity: number;
}

const DEFAULT_PROVIDER = 'github-copilot';
const DEFAULT_MODEL = 'github-copilot/claude-opus-4.8';
const EVICTION_INTERVAL_MS = 5 * 60_000;
const IDLE_TTL_MS = 30 * 60_000;

export class PiAdapter extends AgentAdapter {
  private cliPath: string;
  private sessions = new Map<string, PiSession>();
  private evictTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { cliPath: string }) {
    super();
    this.cliPath = opts.cliPath;
  }

  async start(): Promise<void> {
    this.evictTimer = setInterval(() => this.sweepIdle(), EVICTION_INTERVAL_MS);
    logger.info('PiAdapter started');
  }

  async stop(): Promise<void> {
    if (this.evictTimer) clearInterval(this.evictTimer);
    for (const s of this.sessions.values()) s.proc.kill();
    this.sessions.clear();
  }

  private blankUsage(): SessionUsage {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0, totalDurationMs: 0 };
  }

  private spawn(sessionId: string, cwd: string, model: string, mode: Mode, sessionFile?: string, thinking?: string): PiSession {
    const [provider, modelId] = model.includes('/') ? model.split('/') : [DEFAULT_PROVIDER, model];
    const proc = new PiRpcProcess({
      cliPath: this.cliPath,
      cwd,
      provider,
      model: modelId,
      tools: toolsForMode(mode),
      sessionFile,
      thinking,
    });
    const sess: PiSession = { proc, cwd, model, mode, thinking, sessionFile, usage: this.blankUsage(), lastActivity: Date.now() };
    proc.onEvent = (e) => this.handleEvent(sessionId, e);
    proc.onExit = () => this.onSessionEvicted?.(sessionId);
    proc.start();
    this.sessions.set(sessionId, sess);
    return sess;
  }

  private touch(id: string) {
    const s = this.sessions.get(id);
    if (s) s.lastActivity = Date.now();
  }

  // ── Event mapping: pi session.subscribe → Kraki callbacks ──
  private handleEvent(sessionId: string, e: { type: string; [k: string]: unknown }): void {
    this.touch(sessionId);
    switch (e.type) {
      case 'agent_start':
        break;
      case 'message_update': {
        const am = (e as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
        if (am?.type === 'text_delta' && typeof am.delta === 'string') {
          this.onMessageDelta?.(sessionId, { content: am.delta });
        }
        break;
      }
      case 'message_end': {
        const m = (e as { message?: { role?: string; content?: Array<{ type: string; text?: string }> } }).message;
        if (m?.role === 'assistant') {
          const text = (m.content ?? []).filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('');
          if (text) this.onMessage?.(sessionId, { content: text });
          void this.refreshUsage(sessionId);
        }
        break;
      }
      case 'tool_execution_start':
        this.onToolStart?.(sessionId, {
          toolName: String(e.toolName ?? 'tool'),
          args: (e.args as Record<string, unknown>) ?? {},
          toolCallId: e.toolCallId as string | undefined,
        });
        break;
      case 'tool_execution_end':
        this.onToolComplete?.(sessionId, {
          toolName: String(e.toolName ?? 'tool'),
          result: typeof e.result === 'string' ? e.result : JSON.stringify(e.result ?? ''),
          toolCallId: e.toolCallId as string | undefined,
          success: e.isError !== true,
        });
        break;
      case 'turn_end':
      case 'agent_end': {
        void this.refreshUsage(sessionId);
        this.onIdle?.(sessionId);
        break;
      }
      case 'session_shutdown':
        this.onSessionEnded?.(sessionId, { reason: 'pi shutdown' });
        break;
      default:
        break;
    }
  }

  /** Pull authoritative cumulative usage from pi (get_session_stats) and map
   *  pi's field names (input/output/cacheRead/cacheWrite/cost) → Kraki SessionUsage. */
  private async refreshUsage(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s?.proc.alive) return;
    try {
      const stats = await s.proc.request<{
        tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
        cost?: number;
      }>('get_session_stats');
      const t = stats.tokens;
      s.usage = {
        inputTokens: t?.input ?? 0,
        outputTokens: t?.output ?? 0,
        cacheReadTokens: t?.cacheRead ?? 0,
        cacheWriteTokens: t?.cacheWrite ?? 0,
        totalCost: stats.cost ?? 0,
        totalDurationMs: s.usage.totalDurationMs,
      };
      this.onUsageUpdate?.(sessionId, s.usage);
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'get_session_stats failed');
    }
  }

  async createSession(config: CreateSessionConfig): Promise<{ sessionId: string }> {
    const sessionId = config.sessionId ?? randomUUID();
    const model = config.model ?? DEFAULT_MODEL;
    const thinking = effortToThinking(config.reasoningEffort);
    const sess = this.spawn(sessionId, config.cwd ?? process.cwd(), model, MUTATING_DEFAULT_MODE, undefined, thinking);
    try {
      const state = await sess.proc.request<{ sessionFile?: string }>('get_state');
      sess.sessionFile = state.sessionFile;
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'get_state failed at create');
    }
    this.onSessionCreated?.({ sessionId, agent: 'pi', model });
    return { sessionId };
  }

  async resumeSession(sessionId: string, _ctx?: SessionContext): Promise<{ sessionId: string }> {
    const existing = this.sessions.get(sessionId);
    if (existing?.proc.alive) return { sessionId };
    this.spawn(sessionId, existing?.cwd ?? process.cwd(), existing?.model ?? DEFAULT_MODEL, existing?.mode ?? MUTATING_DEFAULT_MODE, existing?.sessionFile, existing?.thinking);
    return { sessionId };
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const s = this.sessions.get(sessionId) ?? (await this.resumeSession(sessionId), this.sessions.get(sessionId));
    if (!s) throw new Error(`pi session ${sessionId} not found`);
    this.touch(sessionId);
    s.proc.send('prompt', { message: text });
  }

  async abortSession(sessionId: string): Promise<void> {
    this.sessions.get(sessionId)?.proc.send('abort');
  }

  async respondToPermission(): Promise<void> {
    // discuss/execute use spawn-time tool gating; no interactive permission round-trip.
  }

  async respondToQuestion(): Promise<void> {
    // pi RPC questions arrive as extension_ui_request; not used by default tool set.
  }

  async killSession(sessionId: string): Promise<void> {
    this.sessions.get(sessionId)?.proc.kill();
    this.sessions.delete(sessionId);
    this.onSessionEnded?.(sessionId, { reason: 'killed' });
  }

  async forkSession(sourceSessionId: string, newSessionId: string): Promise<{ sessionId: string }> {
    const src = this.sessions.get(sourceSessionId);
    if (src?.proc.alive) {
      try { await src.proc.request('clone'); } catch { /* fall through to copy */ }
    }
    this.spawn(newSessionId, src?.cwd ?? process.cwd(), src?.model ?? DEFAULT_MODEL, src?.mode ?? MUTATING_DEFAULT_MODE, src?.sessionFile, src?.thinking);
    return { sessionId: newSessionId };
  }

  setSessionMode(sessionId: string, mode: Mode): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.mode === mode) return;
    s.mode = mode;
    // Tool gating is spawn-time; respawn to apply the new tool set.
    s.proc.kill();
    this.spawn(sessionId, s.cwd, s.model, mode, s.sessionFile, s.thinking);
  }

  async setSessionModel(sessionId: string, model: string, reasoningEffort?: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.model = model;
    const [provider, modelId] = model.includes('/') ? model.split('/') : [DEFAULT_PROVIDER, model];
    try { await s.proc.request('set_model', { provider, modelId }); } catch { /* ignore */ }
    const thinking = effortToThinking(reasoningEffort);
    if (thinking) {
      s.thinking = thinking;
      try { await s.proc.request('set_thinking_level', { level: thinking }); } catch { /* ignore */ }
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.sessions.entries()].map(([id, s]) => ({
      id, state: s.proc.alive ? 'active' : 'idle', model: s.model, cwd: s.cwd,
    }));
  }

  async listModels(): Promise<string[]> {
    return ['github-copilot/claude-opus-4.8', 'github-copilot/claude-sonnet-4.5', 'github-copilot/claude-haiku-4.5'];
  }

  async listModelDetails(): Promise<ModelDetail[]> {
    const efforts: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
    return [
      { id: 'github-copilot/claude-opus-4.8', name: 'Claude Opus 4.8 (1M)', supportsReasoningEffort: true, supportedReasoningEfforts: efforts, defaultReasoningEffort: 'high', contextWindow: 1000000 },
      { id: 'github-copilot/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', supportsReasoningEffort: true, supportedReasoningEfforts: efforts, defaultReasoningEffort: 'medium', contextWindow: 200000 },
      { id: 'github-copilot/claude-haiku-4.5', name: 'Claude Haiku 4.5', supportsReasoningEffort: false, contextWindow: 200000 },
    ];
  }

  getSessionUsage(sessionId: string): SessionUsage | null {
    return this.sessions.get(sessionId)?.usage ?? null;
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.proc.alive && now - s.lastActivity > IDLE_TTL_MS) {
        logger.info({ id }, 'Evicting idle pi session');
        s.proc.kill();
        this.onSessionEvicted?.(id);
      }
    }
  }
}
