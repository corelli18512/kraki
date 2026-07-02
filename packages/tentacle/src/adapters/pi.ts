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
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentAdapter,
  type CreateSessionConfig,
  type SessionInfo,
  type PermissionDecision,
} from './base.js';
import type { SessionContext } from '../session-manager.js';
import type { ModelDetail, SessionUsage, ReasoningEffort } from '@kraki/protocol';
import { createLogger } from '../logger.js';
import { getKrakiHome, getConfigDir } from '../config.js';

const logger = createLogger('pi-adapter');
const rpcLogger = createLogger('pi-rpc');

// ─────────────────────────────────────────────────────────────────────────────
//  Section 1 — transport: one `pi --mode rpc` child process
//
//  pi speaks newline-delimited JSON on stdin/stdout:
//    - commands in  → { id, type, ... }
//    - responses out → { id, type: "response", command, success, data|error }
//    - events out    → session.subscribe stream (text_delta, tool_*, agent_end…)
//  One process = one pi session (process-per-session isolation).
// ─────────────────────────────────────────────────────────────────────────────

export interface PiRpcEvent {
  type: string;
  [k: string]: unknown;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PiRpcOptions {
  cliPath: string;
  cwd?: string;
  provider?: string;
  model?: string;
  /** Restrict the tool set (read-only mode = ['read','grep','find','ls']). */
  tools?: string[];
  /** Resume an existing on-disk session file. */
  sessionFile?: string;
  appendSystemPrompt?: string;
  /** Thinking level: off|minimal|low|medium|high|xhigh (xhigh = max). */
  thinking?: string;
}

/** Bounds short control commands; prompts run fire-and-forget. */
const CMD_TIMEOUT_MS = 30_000;

class PiRpcProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private intentionalExit = false;
  // Real OS-exit tracking, independent of `child` (which kill() nulls). Lets
  // killAfterExit distinguish "kill was requested" from "process has actually
  // exited" so a replacement never opens the --session jsonl while the old
  // process is still finalizing writes to it.
  private exited = false;
  private exitWaiters: Array<() => void> = [];
  onEvent: ((e: PiRpcEvent) => void) | null = null;
  /** Fires only on UNEXPECTED exit (crash). Intentional kill() is silent. */
  onExit: ((code: number | null) => void) | null = null;

  constructor(private opts: PiRpcOptions) {}

  start(): void {
    const args = ['--mode', 'rpc'];
    if (this.opts.provider) args.push('--provider', this.opts.provider);
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.tools?.length) args.push('--tools', this.opts.tools.join(','));
    if (this.opts.thinking) args.push('--thinking', this.opts.thinking);
    // Continue an existing on-disk conversation by EXACT file path. We avoid
    // `--continue` (which resumes whatever session was modified most recently in
    // the cwd — ambiguous and wrong when several sessions share a cwd) and pin
    // the precise jsonl instead. The absolute path also survives a cwd change.
    if (this.opts.sessionFile) args.push('--session', this.opts.sessionFile);
    if (this.opts.appendSystemPrompt) args.push('--append-system-prompt', this.opts.appendSystemPrompt);

    this.child = spawn(this.opts.cliPath, args, {
      cwd: this.opts.cwd ?? process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (d) => rpcLogger.debug({ stderr: d.toString().trim() }, 'pi stderr'));
    this.child.on('exit', (code) => {
      this.exited = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('pi process exited'));
      }
      this.pending.clear();
      if (!this.intentionalExit) this.onExit?.(code);
      // Fire any killAfterExit callbacks now that the process has truly exited.
      for (const w of this.exitWaiters.splice(0)) w();
    });
  }

  private handleLine(line: string): void {
    const t = line.trim();
    if (!t) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(t);
    } catch {
      rpcLogger.debug({ line: t }, 'non-JSON pi line');
      return;
    }
    if (msg.type === 'response' && typeof msg.id === 'string') {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.success) p.resolve(msg.data);
        else p.reject(new Error(String(msg.error ?? 'pi command failed')));
      }
      return;
    }
    this.onEvent?.(msg as PiRpcEvent);
  }

  /** Send a command and await its response. */
  request<T = unknown>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    const id = `c${++this.seq}`;
    const frame = JSON.stringify({ id, type, ...payload });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi command '${type}' timed out`));
      }, CMD_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (d: unknown) => void, reject, timer });
      if (!this.child?.stdin.writable) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('pi stdin not writable'));
        return;
      }
      this.child.stdin.write(`${frame}\n`);
    });
  }

  /** Fire a command without waiting for its response (e.g. prompt). */
  send(type: string, payload: Record<string, unknown> = {}): void {
    const id = `c${++this.seq}`;
    this.child?.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
  }

  kill(): void {
    this.intentionalExit = true;
    this.rl?.close();
    if (this.child && !this.child.killed) this.child.kill('SIGTERM');
    this.child = null;
  }

  /** Kill the child and run `after` once it has ACTUALLY exited, so a
   *  replacement process can safely reuse the same `--session` jsonl (only one
   *  writer at a time). Gates on the real OS exit — NOT on `this.child`, which
   *  kill() nulls — so a second concurrent mode change during the SIGTERM
   *  window still waits for the first process to fully exit instead of racing
   *  a respawn on top of it. If already exited, runs `after` next microtask. */
  killAfterExit(after: () => void): void {
    if (this.exited) {
      queueMicrotask(after);
      return;
    }
    this.exitWaiters.push(after);
    this.kill();
  }

  get alive(): boolean {
    return !!this.child && !this.child.killed;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Section 2 — adapter: pools one PiRpcProcess per Kraki session
// ─────────────────────────────────────────────────────────────────────────────

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
  /** Set while a mode-change respawn is in flight (old child exiting, new one
   *  not yet spawned). sendMessage awaits it so it never prompts a dead proc. */
  respawn?: Promise<void>;
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

  /** Co-located storage: pi's private transcript and the adapter recovery
   *  sidecar both live inside the Kraki session dir (sessions/<id>/), so the
   *  session is self-contained — nothing leaks into a global scratch area and a
   *  daemon restart can resume by convention instead of a separate pointer. */
  private storeDir(sessionId: string): string {
    return join(getConfigDir(), 'sessions', sessionId);
  }
  /** pi's private LLM-context store (pi writes it natively via `--session`). */
  private transcriptPath(sessionId: string): string {
    return join(this.storeDir(sessionId), 'pi.jsonl');
  }
  /** Adapter recovery sidecar: cwd (pi is project-scoped), model/mode/thinking,
   *  transcript path — the durable bits needed to re-spawn after a restart. */
  private sidecarPath(sessionId: string): string {
    return join(this.storeDir(sessionId), '.pi-adapter.json');
  }
  /** Pre-co-location sidecar location (global scratch dir). Read-only fallback
   *  so sessions created before this change still resume. */
  private legacySidecarPath(sessionId: string): string {
    return join(getKrakiHome(), 'pi-adapter', `${sessionId}.json`);
  }

  /** Persist the durable bits needed to re-spawn this session after a daemon
   *  restart, alongside pi's transcript in the session dir. */
  private persistMeta(sessionId: string, s: PiSession): void {
    try {
      mkdirSync(this.storeDir(sessionId), { recursive: true });
      writeFileSync(
        this.sidecarPath(sessionId),
        JSON.stringify({ cwd: s.cwd, model: s.model, mode: s.mode, thinking: s.thinking, sessionFile: s.sessionFile }),
        'utf8',
      );
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'persistMeta failed');
    }
  }

  private loadMeta(sessionId: string): Partial<Pick<PiSession, 'cwd' | 'model' | 'mode' | 'thinking' | 'sessionFile'>> | null {
    for (const p of [this.sidecarPath(sessionId), this.legacySidecarPath(sessionId)]) {
      if (!existsSync(p)) continue;
      try {
        return JSON.parse(readFileSync(p, 'utf8'));
      } catch {
        /* try next */
      }
    }
    return null;
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
    proc.onExit = () => {
      // Process gone (crash/kill) → no agent_end will arrive. Clear the active
      // spinner so the session doesn't hang "active" forever, then evict.
      this.onIdle?.(sessionId);
      this.onSessionEvicted?.(sessionId);
    };
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
        const m = (e as { message?: { role?: string; content?: Array<{ type: string; text?: string }>; stopReason?: string; errorMessage?: string } }).message;
        if (m?.role === 'assistant') {
          // A backend failure (bad model, 400, quota, rate-limit) surfaces here
          // as stopReason:'error' with an empty content[] and an errorMessage.
          // Without this the session would just go idle with no response — the
          // exact silent-failure bug we guard against. agent_end still fires
          // afterwards, so idle clears normally.
          if (m.stopReason === 'error' && m.errorMessage) {
            this.onError?.(sessionId, { message: m.errorMessage });
          }
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
        // One agentic run = many turns (one per LLM round). Refresh usage but
        // DON'T signal idle here, so the arm groups all rounds (text + tools)
        // into a single turn. Idle is only the run boundary (agent_end).
        void this.refreshUsage(sessionId);
        break;
      case 'agent_end': {
        void this.refreshUsage(sessionId);
        // pi fires agent_end again after an auto-retry/compaction continuation;
        // willRetry === true means "not actually done" — skip the premature idle.
        if (e.willRetry === true) break;
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
    // Co-locate pi's transcript inside the Kraki session dir. Passing the exact
    // path via `--session` makes pi write there natively (verified: pi reports
    // it as sessionFile and writes lazily on the first turn).
    const transcript = this.transcriptPath(sessionId);
    mkdirSync(this.storeDir(sessionId), { recursive: true });
    const sess = this.spawn(sessionId, config.cwd ?? process.cwd(), model, MUTATING_DEFAULT_MODE, transcript, thinking);
    this.persistMeta(sessionId, sess);
    this.onSessionCreated?.({ sessionId, agent: 'pi', model });
    return { sessionId };
  }

  async resumeSession(sessionId: string, _ctx?: SessionContext): Promise<{ sessionId: string }> {
    const existing = this.sessions.get(sessionId);
    if (existing?.proc.alive) return { sessionId };
    // In-memory entry survives idle-eviction (sweepIdle keeps the map entry),
    // but a daemon restart wipes the map. Fall back to the on-disk sidecar so
    // the conversation (cwd + jsonl) is restored instead of starting blank.
    const meta = existing ?? this.loadMeta(sessionId);
    // Prefer the co-located transcript (new sessions). For sessions created
    // before co-location, the sidecar's recorded sessionFile (under ~/.pi)
    // still points at the original jsonl — keep using it so history survives.
    const coLocated = this.transcriptPath(sessionId);
    const sessionFile = existsSync(coLocated) ? coLocated : (meta?.sessionFile ?? coLocated);
    const sess = this.spawn(
      sessionId,
      meta?.cwd ?? process.cwd(),
      meta?.model ?? DEFAULT_MODEL,
      meta?.mode ?? MUTATING_DEFAULT_MODE,
      sessionFile,
      meta?.thinking,
    );
    // Await get_state so the prompt that follows isn't fired before pi has
    // replayed the on-disk conversation into the live context (otherwise the
    // model answers with no memory). Also refreshes the live jsonl path.
    try {
      const state = await sess.proc.request<{ sessionFile?: string }>('get_state');
      if (state.sessionFile) sess.sessionFile = state.sessionFile;
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'get_state failed at resume');
    }
    // Re-persist (refreshes the sidecar if it was just reconstructed from disk).
    this.persistMeta(sessionId, sess);
    return { sessionId };
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    let s = this.sessions.get(sessionId) ?? (await this.resumeSession(sessionId), this.sessions.get(sessionId));
    if (!s) throw new Error(`pi session ${sessionId} not found`);
    // A mode-change respawn may be in flight (old child exiting, new one not
    // yet up). Wait for the fresh child so we don't prompt a dead stdin.
    if (s.respawn) {
      await s.respawn;
      s = this.sessions.get(sessionId) ?? s;
    }
    this.touch(sessionId);
    // The `prompt` RPC resolves as soon as pi accepts the run (it streams
    // asynchronously and ends with agent_end); backend failures surface
    // in-stream as message_end{stopReason:'error'} -> onError. The await here
    // is the transport-level safety net: if the request itself is rejected
    // (stdin closed, process gone, command timeout) there will be no agent_end,
    // so emit error + idle to avoid hanging the session "active" forever.
    try {
      await s.proc.request('prompt', { message: text });
    } catch (err) {
      const message = (err as Error).message;
      logger.warn({ sessionId, err: message }, 'pi prompt request failed');
      this.onError?.(sessionId, { message });
      this.onIdle?.(sessionId);
    }
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
    // Remove the adapter recovery sidecar (both co-located and legacy). pi's
    // transcript lives in the session dir and is reaped with it by the manager.
    try { rmSync(this.sidecarPath(sessionId), { force: true }); } catch { /* ignore */ }
    try { rmSync(this.legacySidecarPath(sessionId), { force: true }); } catch { /* ignore */ }
    this.onSessionEnded?.(sessionId, { reason: 'killed' });
  }

  async forkSession(sourceSessionId: string, newSessionId: string): Promise<{ sessionId: string }> {
    const src = this.sessions.get(sourceSessionId) ?? this.loadMeta(sourceSessionId);
    // A fork must diverge: give it its own co-located transcript seeded with the
    // source history, so the two sessions don't append to the same jsonl.
    const srcFile = (this.sessions.get(sourceSessionId)?.sessionFile)
      ?? (existsSync(this.transcriptPath(sourceSessionId)) ? this.transcriptPath(sourceSessionId) : (src as { sessionFile?: string })?.sessionFile);
    const forkFile = this.transcriptPath(newSessionId);
    mkdirSync(this.storeDir(newSessionId), { recursive: true });
    if (srcFile && existsSync(srcFile)) {
      try { copyFileSync(srcFile, forkFile); } catch (err) { logger.debug({ err: (err as Error).message }, 'fork copy failed'); }
    }
    const next = this.spawn(newSessionId, src?.cwd ?? process.cwd(), src?.model ?? DEFAULT_MODEL, src?.mode ?? MUTATING_DEFAULT_MODE, forkFile, src?.thinking);
    this.persistMeta(newSessionId, next);
    return { sessionId: newSessionId };
  }

  setSessionMode(sessionId: string, mode: Mode): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.mode === mode) return;
    s.mode = mode;
    // A turn may be streaming when the mode changes. Killing the child is an
    // intentional exit, which suppresses onExit → onIdle would never fire and
    // the session would hang "active" forever. Clear the in-flight spinner
    // explicitly — the running turn is discarded by the respawn.
    this.onIdle?.(sessionId);
    // Tool gating is spawn-time, so respawn to apply the new tool set. Wait for
    // the old child to FULLY exit before opening a new pi on the SAME
    // `--session` jsonl, so the two never interleave writes to the transcript.
    const dying = s.proc;
    s.respawn = new Promise<void>((resolve) => {
      dying.killAfterExit(() => {
        try {
          // Skip if the session was killed, or already respawned by a later
          // mode change (proc identity differs) — avoids a double writer.
          const cur = this.sessions.get(sessionId);
          if (!cur || cur.proc !== dying) return;
          const next = this.spawn(sessionId, cur.cwd, cur.model, cur.mode, cur.sessionFile, cur.thinking);
          this.persistMeta(sessionId, next);
        } finally {
          resolve();
        }
      });
    });
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
    this.persistMeta(sessionId, s);
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
