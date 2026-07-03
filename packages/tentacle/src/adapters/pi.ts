/**
 * PiAdapter — bridges Kraki's tentacle to the pi coding agent
 * (`@earendil-works/pi-coding-agent`) via its `--mode rpc` JSON protocol.
 *
 * Design (pi-first, no backward-compat constraints):
 *  - **process-per-session**: every Kraki session owns one `pi --mode rpc`
 *    child. True isolation — one crash never touches another. Memory is
 *    bounded by killing idle children; pi re-resumes from its jsonl on the
 *    next message (lazy resume).
 *  - **permission = per-call gating**: a bridge extension (loaded in ALL modes)
 *    intercepts every tool_call and asks the host to confirm. The adapter
 *    applies a copilot-aligned policy on that request — execute/delegate run
 *    everything; discuss gates only file writes (reads/shell run freely,
 *    plan.md is allowed); safe gates every tool. No respawn on mode change.
 *  - **capability tools**: the same extension registers kraki_get_mode /
 *    kraki_ask / kraki_show_image, bridged to the operator via the extension-UI
 *    channel and the shared attachment pipeline.
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
import type { ModelDetail, SessionUsage, ReasoningEffort, ToolArgs } from '@kraki/protocol';
import { createLogger } from '../logger.js';
import { getKrakiHome, getConfigDir } from '../config.js';
import { PI_BRIDGE_EXTENSION_SOURCE } from './pi-bridge-extension.js';
import type { AttachmentStore } from '../attachment-store.js';

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
  /** Path to a pi extension loaded via `--extension`. Kraki uses this to
   *  install the bridge extension (permission gate + kraki_* capability tools).
   *  Loaded in ALL modes — mode is enforced by adapter policy, not by presence. */
  extensionPath?: string;
  /** Absolute path to the adapter meta sidecar, exported to the child as
   *  `KRAKI_META_FILE` so the bridge extension's kraki_get_mode can read the
   *  live permission mode. */
  krakiMetaFile?: string;
}

/** Bounds short control commands; prompts run fire-and-forget. */
const CMD_TIMEOUT_MS = 30_000;

class PiRpcProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private intentionalExit = false;
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
    // Bridge extension (permission gate + kraki_* capability tools). Loaded in
    // ALL modes because rpc mode has no built-in tool-approval round-trip; its
    // ctx.ui.confirm surfaces as an extension_ui_request the adapter maps to a
    // Kraki permission card (and the adapter's policy decides silent-approve vs
    // card). Loading unconditionally means a mode change never respawns pi.
    if (this.opts.extensionPath) args.push('--extension', this.opts.extensionPath);

    // Export the meta sidecar path so the bridge extension's kraki_get_mode can
    // read the live permission mode (the adapter is the source of truth).
    const env = this.opts.krakiMetaFile
      ? { ...process.env, KRAKI_META_FILE: this.opts.krakiMetaFile }
      : process.env;

    this.child = spawn(this.opts.cliPath, args, {
      cwd: this.opts.cwd ?? process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (d) => rpcLogger.debug({ stderr: d.toString().trim() }, 'pi stderr'));
    this.child.on('exit', (code) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('pi process exited'));
      }
      this.pending.clear();
      if (!this.intentionalExit) this.onExit?.(code);
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

  /** Write a raw frame verbatim. Used to answer an unsolicited pi request
   *  (e.g. extension_ui_request) whose `id` must be echoed exactly, not a new
   *  client-generated one. */
  sendRaw(frame: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  kill(): void {
    this.intentionalExit = true;
    this.rl?.close();
    if (this.child && !this.child.killed) this.child.kill('SIGTERM');
    this.child = null;
  }

  get alive(): boolean {
    return !!this.child && !this.child.killed;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Section 2 — adapter: pools one PiRpcProcess per Kraki session
// ─────────────────────────────────────────────────────────────────────────────

export type Mode = 'safe' | 'discuss' | 'execute' | 'delegate';
const MUTATING_DEFAULT_MODE: Mode = 'discuss';

/** Files that may be written without approval in discuss mode (mirrors the
 *  copilot adapter's DISCUSS_MODE_WRITE_ALLOW_LIST). */
const DISCUSS_MODE_WRITE_ALLOW_LIST = ['plan.md'];

/** Coarse tool "kind" for the permission policy — only "write" is special
 *  (writes gate in discuss); everything else (shell/read/find/custom) is
 *  treated the same, matching copilot's kind-based gating. */
function isWriteTool(toolName: string): boolean {
  return toolName === 'write' || toolName === 'edit';
}

/** copilot-aligned permission policy (copilot.ts makePermissionHandler):
 *  execute/delegate → auto-approve all; discuss → auto-approve everything
 *  EXCEPT non-allowlisted file writes; safe → gate every tool. Returns true
 *  when the call should run silently (no card). */
export function shouldAutoApprove(mode: Mode, toolName: string, input: Record<string, unknown>): boolean {
  if (mode === 'execute' || mode === 'delegate') return true;
  if (mode === 'discuss') {
    if (!isWriteTool(toolName)) return true;
    const path = typeof input.path === 'string' ? input.path
      : typeof input.file_path === 'string' ? (input.file_path as string) : '';
    return DISCUSS_MODE_WRITE_ALLOW_LIST.some((f) => path.endsWith('/' + f) || path === f);
  }
  // safe → everything gates
  return false;
}

/** Map a pi tool name + JSON-encoded input (as delivered by the permission-gate
 *  extension's confirm request) into a Kraki permission card. Known pi tools are
 *  normalized to the shared ToolArgs shapes; anything else falls back to the
 *  raw name + args so the card still renders. */
export function parsePiPermission(toolName: string, inputJson: string): { toolArgs: ToolArgs; description: string } {
  let input: Record<string, unknown> = {};
  try {
    const parsed = inputJson ? JSON.parse(inputJson) : {};
    if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>;
  } catch {
    /* leave input empty on malformed JSON */
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  switch (toolName) {
    case 'bash': {
      const command = str(input.command);
      return { toolArgs: { toolName: 'shell', args: { command } }, description: command || 'Run a shell command' };
    }
    case 'write': {
      const path = str(input.path);
      return {
        toolArgs: { toolName: 'write_file', args: { path, content: str(input.content) } },
        description: path ? `Write ${path}` : 'Write a file',
      };
    }
    case 'edit': {
      const path = str(input.path);
      return { toolArgs: { toolName, args: input }, description: path ? `Edit ${path}` : 'Edit a file' };
    }
    default:
      return { toolArgs: { toolName, args: input }, description: toolName };
  }
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
  /** Outstanding per-call permission requests (permissionId → pi's UI request
   *  id). Cleared when answered or when the child dies so the arm's card doesn't
   *  dangle. */
  pendingPerms: Map<string, string>;
  /** Outstanding kraki_ask question requests (the pi extension_ui_request id).
   *  Answered via respondToQuestion → extension_ui_response{value}. */
  pendingQuestions: Set<string>;
}

const DEFAULT_PROVIDER = 'github-copilot';
const DEFAULT_MODEL = 'github-copilot/claude-opus-4.8';
const EVICTION_INTERVAL_MS = 5 * 60_000;
const IDLE_TTL_MS = 30 * 60_000;

export class PiAdapter extends AgentAdapter {
  private cliPath: string;
  private attachmentStore?: AttachmentStore;
  private sessions = new Map<string, PiSession>();
  private evictTimer: ReturnType<typeof setInterval> | null = null;
  /** Lazily-materialized path to the bridge extension. */
  private bridgeExtPath: string | null = null;
  /** Edge-triggered mode-change signals, held at the ADAPTER level (survives
   *  idle-eviction, which replaces the PiSession object). Prepended once to the
   *  next user message, then cleared — mirrors the claude adapter. */
  private pendingModeSignals = new Map<string, Mode>();

  constructor(opts: { cliPath: string; attachmentStore?: AttachmentStore }) {
    super();
    this.cliPath = opts.cliPath;
    this.attachmentStore = opts.attachmentStore;
  }

  /** Write the embedded bridge extension to a stable on-disk path and return it.
   *  The source is inlined in the tentacle SEA bundle, so it can't be referenced
   *  from a repo path at runtime — we materialize it once (rewriting on every
   *  daemon start so upgrades ship the current source). */
  private ensureBridgeExtension(): string {
    if (this.bridgeExtPath) return this.bridgeExtPath;
    const dir = join(getConfigDir(), 'pi-extensions');
    const path = join(dir, 'kraki-bridge-extension.ts');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, PI_BRIDGE_EXTENSION_SOURCE, 'utf8');
      this.bridgeExtPath = path;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'failed to materialize pi bridge extension');
    }
    return path;
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
      sessionFile,
      thinking,
      // Bridge extension is loaded in EVERY mode (mode is enforced by adapter
      // policy on the confirm request, not by the extension's presence).
      extensionPath: this.ensureBridgeExtension(),
      krakiMetaFile: this.sidecarPath(sessionId),
    });
    const sess: PiSession = { proc, cwd, model, mode, thinking, sessionFile, usage: this.blankUsage(), lastActivity: Date.now(), pendingPerms: new Map(), pendingQuestions: new Set() };
    proc.onEvent = (e) => this.handleEvent(sessionId, e);
    proc.onExit = () => {
      // Process gone (crash/kill) → no agent_end will arrive. Clear the active
      // spinner so the session doesn't hang "active" forever, then evict.
      this.clearPending(sessionId);
      this.onIdle?.(sessionId);
      this.onSessionEvicted?.(sessionId);
    };
    proc.start();
    this.sessions.set(sessionId, sess);
    return sess;
  }

  /** Drop any outstanding permission cards AND question cards for a session
   *  (child died / evicted) so the arm doesn't wait on a decision that can never
   *  reach pi. */
  private clearPending(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    for (const permId of s.pendingPerms.keys()) {
      this.onPermissionAutoResolved?.(sessionId, permId, 'cancelled');
    }
    s.pendingPerms.clear();
    for (const qId of s.pendingQuestions) {
      this.onQuestionAutoResolved?.(sessionId, qId);
    }
    s.pendingQuestions.clear();
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
      case 'tool_execution_end': {
        const toolName = String(e.toolName ?? 'tool');
        const toolCallId = e.toolCallId as string | undefined;
        let attachments: import('@kraki/protocol').Attachment[] | undefined;
        let result: string;

        if (toolName === 'kraki_show_image') {
          // The bridge extension returned an AgentToolResult { content:[...] }
          // with an ImageContent block. Extract the image into the shared
          // attachment pipeline (mirrors copilot show_image) and keep a compact
          // text result out of the transcript instead of dumping base64.
          const { refs, caption } = this.extractShowImage(sessionId, e.result);
          if (refs.length > 0) attachments = refs;
          result = caption ?? (refs.length > 0 ? 'Displayed image to operator.' : 'kraki_show_image produced no image.');
        } else {
          result = typeof e.result === 'string' ? e.result : JSON.stringify(e.result ?? '');
        }

        this.onToolComplete?.(sessionId, {
          toolName,
          result,
          toolCallId,
          success: e.isError !== true,
          attachments,
        });

        // After tool_complete, fire the bytes broadcast so RelayClient can stream
        // attachment_data chunks to all connected devices.
        if (attachments && attachments.length > 0) {
          const refs = attachments.filter(
            (a): a is import('@kraki/protocol').ContentRef => a.type === 'content_ref',
          );
          if (refs.length > 0) this.onAttachmentBytes?.(sessionId, { refs });
        }
        break;
      }
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
      case 'extension_ui_request': {
        // The bridge extension drives three UI methods over this channel:
        //  - confirm: the permission gate before each tool. Apply the copilot
        //    policy on our in-memory mode → auto-approve silently OR raise a card.
        //  - select / input: a kraki_ask question → a Kraki question card.
        // Other methods (notify/status/…) are unused and need no reply.
        if (typeof e.id !== 'string') break;
        const s = this.sessions.get(sessionId);
        if (!s) break;
        const reqId = e.id;

        if (e.method === 'confirm') {
          const toolName = String(e.title ?? 'tool');
          const inputJson = typeof e.message === 'string' ? e.message : '';
          let input: Record<string, unknown> = {};
          try {
            const parsed = inputJson ? JSON.parse(inputJson) : {};
            if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>;
          } catch { /* leave empty */ }

          if (shouldAutoApprove(s.mode, toolName, input)) {
            // Silent approve — no card. Respond immediately so the tool runs.
            s.proc.sendRaw({ type: 'extension_ui_response', id: reqId, confirmed: true });
            logger.debug({ sessionId, toolName, mode: s.mode }, 'pi tool auto-approved');
            break;
          }
          s.pendingPerms.set(reqId, reqId);
          const { toolArgs, description } = parsePiPermission(toolName, inputJson);
          logger.debug({ sessionId, permId: reqId, toolName: toolArgs.toolName }, 'pi permission requested');
          this.onPermissionRequest?.(sessionId, { id: reqId, toolArgs, description });
          break;
        }

        if (e.method === 'select' || e.method === 'input') {
          s.pendingQuestions.add(reqId);
          const choices = e.method === 'select' && Array.isArray(e.options)
            ? (e.options as string[]) : undefined;
          logger.debug({ sessionId, questionId: reqId, method: e.method }, 'pi question requested');
          this.onQuestionRequest?.(sessionId, {
            id: reqId,
            question: String(e.title ?? ''),
            choices,
            allowFreeform: true,
          });
          break;
        }
        break;
      }
      default:
        break;
    }
  }

  /** Pull ImageContent blocks out of a kraki_show_image tool result and store
   *  them in the attachment pipeline, returning content refs + any caption. The
   *  pi result is an AgentToolResult: { content: [{type:'image',data,mimeType}],
   *  details: { caption } }. */
  private extractShowImage(sessionId: string, rawResult: unknown): {
    refs: import('@kraki/protocol').ContentRef[];
    caption?: string;
  } {
    const refs: import('@kraki/protocol').ContentRef[] = [];
    if (!this.attachmentStore || !rawResult || typeof rawResult !== 'object') return { refs };
    const r = rawResult as { content?: unknown; details?: unknown };
    const details = (r.details && typeof r.details === 'object') ? r.details as Record<string, unknown> : {};
    const caption = typeof details.caption === 'string' && details.caption.trim() ? details.caption.trim() : undefined;
    const name = typeof details.path === 'string' ? details.path.split('/').pop() : undefined;
    if (!Array.isArray(r.content)) return { refs, caption };
    for (const block of r.content as Array<Record<string, unknown>>) {
      if (block && block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
        try {
          const bytes = Buffer.from(block.data, 'base64');
          const ref = this.attachmentStore.put(sessionId, bytes, block.mimeType, {
            ...(name && { name }),
            ...(caption && { caption }),
          });
          refs.push(ref);
        } catch (err) {
          logger.warn({ err: (err as Error).message, sessionId }, 'failed to store show_image attachment');
        }
      }
    }
    return { refs, caption };
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
    const s = this.sessions.get(sessionId) ?? (await this.resumeSession(sessionId), this.sessions.get(sessionId));
    if (!s) throw new Error(`pi session ${sessionId} not found`);
    this.touch(sessionId);
    // Edge-triggered mode signal: if the mode changed since the last message,
    // prepend a one-shot marker so the model knows its new permission envelope
    // (mirrors the claude adapter). The meta file (kraki_get_mode) stays the
    // source of truth; this is just an inline heads-up.
    const pendingMode = this.pendingModeSignals.get(sessionId);
    if (pendingMode) {
      this.pendingModeSignals.delete(sessionId);
      text = `[kraki: mode changed to ${pendingMode}]\n\n${text}`;
    }
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

  async respondToPermission(sessionId: string, permissionId: string, decision: PermissionDecision): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) { logger.warn({ sessionId }, 'respondToPermission: session not found'); return; }
    if (!s.pendingPerms.delete(permissionId)) {
      logger.warn({ sessionId, permissionId }, 'respondToPermission: no pending permission');
      return;
    }
    // 'approve' and 'always_allow' both run the tool this time. Per-session
    // "always allow" persistence is a future enhancement — for now it behaves
    // like a one-off approve.
    const confirmed = decision !== 'deny';
    s.proc.sendRaw({ type: 'extension_ui_response', id: permissionId, confirmed });
    logger.debug({ sessionId, permissionId, confirmed }, 'pi permission answered');
  }

  async respondToQuestion(sessionId: string, questionId: string, answer: string, _wasFreeform: boolean): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) { logger.warn({ sessionId }, 'respondToQuestion: session not found'); return; }
    if (!s.pendingQuestions.delete(questionId)) {
      logger.warn({ sessionId, questionId }, 'respondToQuestion: no pending question');
      return;
    }
    // Answer the extension's ctx.ui.select / ctx.ui.input — its promise resolves
    // with this value, which kraki_ask returns to the model as the tool result.
    s.proc.sendRaw({ type: 'extension_ui_response', id: questionId, value: answer });
    logger.debug({ sessionId, questionId }, 'pi question answered');
  }

  async killSession(sessionId: string): Promise<void> {
    this.clearPending(sessionId);
    this.pendingModeSignals.delete(sessionId);
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
    // Persist the new mode so it survives a daemon restart AND so the bridge
    // extension's kraki_get_mode (which reads KRAKI_META_FILE) sees it live.
    this.persistMeta(sessionId, s);
    // Edge-triggered: prepend a one-shot marker to the next user message.
    this.pendingModeSignals.set(sessionId, mode);
    // If a turn is streaming/compacting right now, also nudge the model mid-run
    // via steer so it doesn't act on a stale envelope before the next message.
    // The nudge is MODE-AGNOSTIC: pi's steer queue is one-at-a-time, so a
    // concrete value could go stale; kraki_get_mode reads the live truth.
    void this.steerModeNudge(sessionId);
    logger.debug({ sessionId, mode }, 'pi session mode changed');
  }

  /** Steer a mode-agnostic nudge into an active turn so the model re-checks its
   *  permission envelope. No-op when the session is idle (the prepend on the
   *  next message covers that). Active state is read from pi's get_state
   *  (isStreaming/isCompacting) rather than a hand-tracked flag, because pi's
   *  auto-retry and compaction continuations run AFTER agent_end. */
  private async steerModeNudge(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s?.proc.alive) return;
    try {
      const state = await s.proc.request<{ isStreaming?: boolean; isCompacting?: boolean }>('get_state');
      if (state.isStreaming || state.isCompacting) {
        s.proc.send('steer', { message: '[kraki: permission mode changed — call kraki_get_mode before acting]' });
        logger.debug({ sessionId }, 'pi mode-change steer nudge sent');
      }
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'steer mode nudge failed');
    }
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
