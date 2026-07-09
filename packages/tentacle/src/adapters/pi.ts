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
import { spawn, type ChildProcessWithoutNullStreams, execSync } from 'node:child_process';
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
import { PI_KRAKI_TOOLS_SOURCE } from './pi-kraki-tools.js';
import { fitToMaxDimension } from '../image-resize.js';

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
  /** Path to a pi extension loaded via `--extension`. Kraki always loads its
   *  tools extension (finalize_reply / ask_user + permission gate). */
  extensionPath?: string;
  /** Extra environment for the child. Kraki sets `KRAKI_META_FILE` here so the
   *  extension's kraki_get_mode can read the live permission mode. */
  env?: NodeJS.ProcessEnv;
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
    // Kraki tools extension (finalize_reply / ask_user / show_image /
    // kraki_get_mode + permission gate), always loaded. rpc mode has no built-in
    // tool-approval round-trip, so the gate's ctx.ui.confirm surfaces as an
    // extension_ui_request the adapter maps to a Kraki permission card (or
    // silently auto-approves per its mode policy). Loading unconditionally means
    // a mode change never respawns pi — the policy is enforced by the adapter.
    if (this.opts.extensionPath) args.push('--extension', this.opts.extensionPath);

    this.child = spawn(this.opts.cliPath, args, {
      cwd: this.opts.cwd ?? process.cwd(),
      env: this.opts.env ?? process.env,
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

type Mode = 'safe' | 'discuss' | 'execute' | 'delegate';
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

function toolsForMode(_mode: Mode): string[] | undefined {
  // Full tool set in every mode (undefined = pi default set). Mutating calls in
  // discuss/safe are gated per-call by the permission-gate extension instead of
  // being stripped, so pi can still write/bash after the user approves.
  return undefined;
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
   *  id). Cleared when answered or when the child is killed/respawned so the
   *  arm's card doesn't dangle. */
  pendingPerms: Map<string, string>;
  /** Outstanding ask_user questions (questionId → pi's UI request id). Mirrors
   *  pendingPerms — cleared on answer / kill / respawn. */
  pendingQuestions: Map<string, string>;
  /** Number of narration segments (non-empty assistant prose at message_end)
   *  produced since the current user message. Drives the skip-finalize rule:
   *  a turn with exactly ONE narration segment and no tool after it is already a
   *  clean trailing reply, so no finalize round is needed. */
  narrationSegments: number;
  /** True once a real tool ran AFTER the most recent narration segment (reset to
   *  false whenever a narration finalizes). If the turn ends on a tool, the last
   *  narration isn't a trailing reply → finalize. */
  toolSinceLastNarration: boolean;
  /** The most recent narration segment's finalized prose — the kept "draft" text
   *  (keep-last). Seeds the finalize prompt and is the fallback reply. */
  lastNarration: string;
  /** The most recent narration segment whose TRACE mirror is still DEFERRED —
   *  not yet emitted as an `agent_narration` step because it might still
   *  graduate verbatim into the concluding bubble (skip-finalize / finalize
   *  keep-last / fallback). It is FLUSHED to the trace (a confirmed intermediate
   *  step) when superseded by a newer narration or by a following tool, and
   *  DISCARDED (never traced) when it becomes the bubble — so the trailing reply
   *  never shows twice (last Step + bubble). Empty when nothing is pending. */
  pendingNarration: string;
  /** True while the injected finalize round is in flight (between sending the
   *  finalize prompt and the following agent_end). During it, ordinary narration
   *  is suppressed so the draft stays frozen at `lastNarration`. */
  finalizing: boolean;
  /** True once finalize_reply was called in the finalize round (so agent_end
   *  doesn't fall back to a generated reply). */
  finalizeResolved: boolean;
  /** Fallback prose captured during the finalize round (the model's message_end
   *  text) in case it ends the round without calling finalize_reply. */
  finalizeNarration: string;
  /** Live-streaming state for a finalize_reply.text (resummarize): the tool-call
   *  id currently streaming and how many chars of its `text` arg we've emitted as
   *  onFinalizeDelta deltas, so the resummarize streams into the draft bubble. */
  finalizeStreamId?: string;
  finalizeStreamLen: number;
}

// ── Dynamic model discovery via `pi --list-models` ────────────────

interface PiModelRow {
  provider: string;
  model: string;
  contextWindow: number;
  reasoning: boolean;
}

/** Parse the human-readable table output of `pi --list-models`. */
function parsePiListModels(stdout: string): PiModelRow[] {
  const lines = stdout.split('\n').filter(l => l.trim().length > 0);
  const header = lines[0];
  if (!header?.includes('provider')) return [];

  // Locate column boundaries from the header
  const cols = ['provider', 'model', 'context', 'max-out', 'thinking', 'images'];
  const boundaries: number[] = [];
  let searchFrom = 0;
  for (const col of cols) {
    const idx = header.indexOf(col, searchFrom);
    if (idx === -1) return [];
    boundaries.push(idx);
    searchFrom = idx + col.length;
  }

  const rows: PiModelRow[] = [];
  for (const line of lines.slice(1)) {
    const parts: string[] = [];
    for (let i = 0; i < boundaries.length; i++) {
      const start = boundaries[i];
      const end = i + 1 < boundaries.length ? boundaries[i + 1] : undefined;
      parts.push((end ? line.slice(start, end) : line.slice(start)).trim());
    }
    const [provider, model, ctxStr, , thinking] = parts;
    if (!provider || !model) continue;

    rows.push({
      provider: provider.trim(),
      model: model.trim(),
      contextWindow: parseContext(ctxStr),
      reasoning: thinking?.trim().toLowerCase() === 'yes',
    });
  }
  return rows;
}

function parseContext(s: string): number {
  s = s.trim().toUpperCase();
  if (s.endsWith('K')) return parseInt(s, 10) * 1000;
  if (s.endsWith('M')) return parseInt(s, 10) * 1_000_000;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 200_000;
}

function resolveDefaultModel(models: PiModelRow[]): string {
  if (models.length === 0) return 'deepseek/deepseek-v4-pro';
  // Prefer a pro/large model as default, then the first model
  const preferred = models.find(m => m.model.includes('pro') || m.model.includes('opus')) ?? models[0];
  return `${preferred.provider}/${preferred.model}`;
}

/** Minimal shape of pi's streamed `assistantMessageEvent` (message_update RPC).
 *  `partial` carries the accumulating AssistantMessage; for a streaming tool
 *  call, pi incrementally parses `arguments` so `content[contentIndex]` exposes
 *  the tool name + partially-parsed args (e.g. finalize_reply's `text`). */
interface AssistantStreamEvent {
  type: string;
  delta?: string;
  contentIndex?: number;
  partial?: {
    content?: Array<{
      type?: string;
      id?: string;
      name?: string;
      arguments?: { text?: unknown };
    }>;
  };
}
const EVICTION_INTERVAL_MS = 5 * 60_000;
const IDLE_TTL_MS = 30 * 60_000;

/** Describes the Kraki UI to the model so it narrates naturally instead of
 *  tagging its own messages. Appended to pi's system prompt on every spawn. */
const KRAKI_SYSTEM_PROMPT =
  'You are operating inside Kraki, a remote-control harness. Communicate with the ' +
  'human by writing ordinary assistant prose — it IS your reply and is shown to ' +
  'them directly. You do NOT need any special tool to "send" a message; just ' +
  'write. Narrate preamble, thinking, and progress as prose while you work, and ' +
  'end your turn with a short, self-contained final answer. Kraki takes care of ' +
  'settling that final message into the chat, so you never manage bubbles ' +
  'yourself. To get a decision or missing information from the human, call the ' +
  'ask_user tool (it blocks and returns their answer). To visually show the human ' +
  'an image (a screenshot, diagram, chart, or generated graphic they cannot ' +
  'already see), call the show_image tool with the file path. Do NOT call ' +
  'finalize_reply on your own — Kraki will ask you to when it needs you to ' +
  'conclude a turn.';

/** Injected at the end of a turn whose intermediate narration was dropped, so
 *  the model settles a clean final reply. Seeded with the kept draft line. */
function finalizePrompt(draft: string): string {
  const quoted = draft.trim()
    ? `Your current draft closing line is:\n\n"""${draft.trim()}"""\n\n`
    : 'You have no drafted closing line yet.\n\n';
  return (
    '[Kraki] Your turn is ending. Settle the final message shown to the human by ' +
    'calling finalize_reply exactly once. ' +
    quoted +
    'If that line is already a good, self-contained final answer, call ' +
    'finalize_reply({ resummarize: false }). Otherwise call finalize_reply({ ' +
    'resummarize: true, text: "<a short, self-contained, plain-text final ' +
    'message>" }). Do not run any other tool or add prose — just call finalize_reply.'
  );
}

export class PiAdapter extends AgentAdapter {
  private cliPath: string;
  private readonly attachmentStore?: import('../attachment-store.js').AttachmentStore;
  private sessions = new Map<string, PiSession>();
  private evictTimer: ReturnType<typeof setInterval> | null = null;
  /** Lazily-materialized path to the always-loaded Kraki tools extension. */
  private toolsExtPath: string | null = null;
  /** Edge-triggered mode-change signals, held at the ADAPTER level so they
   *  survive across turns: prepended as a one-shot marker to the next user
   *  message (the meta sidecar / kraki_get_mode stays the source of truth). */
  private pendingModeSignals = new Map<string, Mode>();

  constructor(opts: { cliPath: string; attachmentStore?: import('../attachment-store.js').AttachmentStore }) {
    super();
    this.cliPath = opts.cliPath;
    this.attachmentStore = opts.attachmentStore;
  }

  /** Write the embedded Kraki tools extension to a stable on-disk path and
   *  return it. The source is inlined in the tentacle SEA bundle, so it can't be
   *  referenced from a repo path at runtime — we materialize it once (rewriting
   *  on every daemon start so upgrades ship the current source). */
  private ensureToolsExtension(): string {
    if (this.toolsExtPath) return this.toolsExtPath;
    const dir = join(getConfigDir(), 'pi-extensions');
    const path = join(dir, 'kraki-tools.ts');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, PI_KRAKI_TOOLS_SOURCE, 'utf8');
      this.toolsExtPath = path;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'failed to materialize pi tools extension');
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
    const [provider, modelId] = model.includes('/') ? model.split('/') : [this.getDefaultModel().split('/')[0], model];
    // Export the meta sidecar path so the extension's kraki_get_mode reads the
    // live permission mode (the adapter, via persistMeta, is the source of truth).
    // The gate itself is loaded in every mode; the adapter decides silent-approve
    // vs card per shouldAutoApprove, so a mode change never respawns pi.
    const env = { ...process.env, KRAKI_META_FILE: this.sidecarPath(sessionId) };
    const proc = new PiRpcProcess({
      cliPath: this.cliPath,
      cwd,
      provider,
      model: modelId,
      tools: toolsForMode(mode),
      sessionFile,
      thinking,
      appendSystemPrompt: KRAKI_SYSTEM_PROMPT,
      extensionPath: this.ensureToolsExtension(),
      env,
    });
    const sess: PiSession = { proc, cwd, model, mode, thinking, sessionFile, usage: this.blankUsage(), lastActivity: Date.now(), pendingPerms: new Map(), pendingQuestions: new Map(), narrationSegments: 0, toolSinceLastNarration: false, lastNarration: '', pendingNarration: '', finalizing: false, finalizeResolved: false, finalizeNarration: '', finalizeStreamLen: 0 };
    proc.onEvent = (e) => this.handleEvent(sessionId, e);
    proc.onExit = () => {
      // Process gone (crash/kill) → no agent_end will arrive. Clear the active
      // spinner so the session doesn't hang "active" forever, then evict.
      this.clearPendingPerms(sessionId);
      this.clearPendingQuestions(sessionId);
      this.pendingModeSignals.delete(sessionId);
      this.onIdle?.(sessionId);
      this.onSessionEvicted?.(sessionId);
    };
    proc.start();
    this.sessions.set(sessionId, sess);
    // Write the meta sidecar up front so KRAKI_META_FILE points at a real file
    // (kraki_get_mode reads it) before the first turn runs.
    this.persistMeta(sessionId, sess);
    return sess;
  }

  /** Drop any outstanding permission cards for a session (child died / respawn)
   *  so the arm doesn't wait on a decision that can never reach pi. */
  private clearPendingPerms(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.pendingPerms.size === 0) return;
    for (const permId of s.pendingPerms.keys()) {
      this.onPermissionAutoResolved?.(sessionId, permId, 'cancelled');
    }
    s.pendingPerms.clear();
  }

  /** Drop any outstanding ask_user questions (child died / respawn) so the arm's
   *  question card doesn't dangle on a pi that can never answer it. */
  private clearPendingQuestions(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.pendingQuestions.size === 0) return;
    for (const questionId of s.pendingQuestions.keys()) {
      this.onQuestionAutoResolved?.(sessionId, questionId);
    }
    s.pendingQuestions.clear();
  }

  private touch(id: string) {
    const s = this.sessions.get(id);
    if (s) s.lastActivity = Date.now();
  }

  /** Emit the DEFERRED narration segment (if any) to the TRACE axis — it is now
   *  a confirmed intermediate step (superseded by a newer narration or a tool),
   *  so it can never be the graduating reply. Clears the pending slot. */
  private flushPendingNarration(sessionId: string, s: PiSession): void {
    if (s.pendingNarration) {
      this.onNarrationTrace?.(sessionId, { content: s.pendingNarration });
      s.pendingNarration = '';
    }
  }

  // ── Event mapping: pi session.subscribe → Kraki callbacks ──
  private async handleEvent(sessionId: string, e: { type: string; [k: string]: unknown }): Promise<void> {
    this.touch(sessionId);
    switch (e.type) {
      case 'agent_start':
      case 'agent_start':
        break;
      case 'message_update': {
        const s = this.sessions.get(sessionId);
        const am = (e as { assistantMessageEvent?: AssistantStreamEvent }).assistantMessageEvent;
        if (am?.type === 'text_delta' && typeof am.delta === 'string') {
          // During the injected finalize round the draft bubble must stay FROZEN
          // at the kept closing line (lastNarration) — any pre-thinking prose the
          // model emits before calling finalize_reply is suppressed so the draft
          // doesn't churn. Outside the finalize round, narration streams normally.
          if (!s?.finalizing) this.onMessageDelta?.(sessionId, { content: am.delta });
          break;
        }
        // finalize_reply streams its `text` arg like prose: pi parses the partial
        // tool args incrementally (arguments.text grows as a prefix), so we diff
        // against what we've already emitted and forward the new suffix as an
        // onFinalizeDelta. This streams the resummarized closing line live into
        // the draft bubble (replacing the frozen narration) so it morphs
        // seamlessly into the final reply instead of popping in whole.
        if (am?.type === 'toolcall_delta' || am?.type === 'toolcall_start') {
          const ci = am.contentIndex;
          const tc = typeof ci === 'number' ? am.partial?.content?.[ci] : undefined;
          if (tc && tc.type === 'toolCall' && tc.name === 'finalize_reply' && s) {
            if (s.finalizeStreamId !== tc.id) {
              s.finalizeStreamId = tc.id;
              s.finalizeStreamLen = 0;
            }
            const txt = typeof tc.arguments?.text === 'string' ? tc.arguments.text : '';
            if (txt.length > s.finalizeStreamLen) {
              const suffix = txt.slice(s.finalizeStreamLen);
              s.finalizeStreamLen = txt.length;
              this.onFinalizeDelta?.(sessionId, { content: suffix });
            }
          }
        }
        break;
      }
      case 'message_end': {
        const m = (e as { message?: { role?: string; content?: Array<{ type: string; text?: string }>; stopReason?: string; errorMessage?: string } }).message;
        if (m?.role === 'assistant') {
          const s = this.sessions.get(sessionId);
          // A backend failure (bad model, 400, quota, rate-limit) surfaces here
          // as stopReason:'error' with an empty content[] and an errorMessage.
          // Without this the session would just go idle with no response — the
          // exact silent-failure bug we guard against. agent_end still fires
          // afterwards, so idle clears normally.
          if (m.stopReason === 'error' && m.errorMessage) {
            this.onError?.(sessionId, { message: m.errorMessage });
          }
          const prose = (m.content ?? [])
            .filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text as string)
            .join('')
            .trim();
          if (m.stopReason !== 'error' && prose) {
            if (s?.finalizing) {
              // In the finalize round: keep the model's prose ONLY as a fallback
              // reply (used if it ends the round without calling finalize_reply).
              // Do NOT trace it or reset the draft — the draft is frozen.
              s.finalizeNarration = prose;
            } else if (s) {
              // Ordinary NARRATION: streams live to the draft bubble (see
              // message_update). RECONCILE the live draft NOW on every segment
              // (onNarration → card.onNarrationFinal) so the throttled draft is
              // squared with the finalized prose before the bubble lands — no
              // draft→spine size-jump. But DEFER the TRACE mirror: this segment
              // might still graduate verbatim into the concluding bubble, so we
              // hold it as `pendingNarration` and only trace it once it is
              // confirmed intermediate (a newer narration or a tool follows) —
              // never the trailing reply. Flush the PREVIOUS pending here (a new
              // segment supersedes it). Tracked for the skip-finalize rule.
              this.onNarration?.(sessionId, { content: prose });
              this.flushPendingNarration(sessionId, s);
              s.pendingNarration = prose;
              s.narrationSegments += 1;
              s.lastNarration = prose;
              s.toolSinceLastNarration = false;
            }
          }
          void this.refreshUsage(sessionId);
        }
        break;
      }
      case 'tool_execution_start': {
        const toolName = String(e.toolName ?? 'tool');
        if (toolName === 'finalize_reply') {
          // The turn-conclusion tool — never a TRACE step. Only meaningful during
          // the injected finalize round; crystallize the settled final reply here.
          const s = this.sessions.get(sessionId);
          if (s?.finalizing) {
            const args = (e.args as { resummarize?: unknown; text?: unknown }) ?? {};
            const resummarize = args.resummarize === true;
            const text = typeof args.text === 'string' ? args.text.trim() : '';
            s.finalizeResolved = true;
            const useResummarized = resummarize && text.length > 0;
            const reply = useResummarized ? text : s.lastNarration.trim();
            if (useResummarized) {
              // The reply is a fresh summary distinct from the drafted narration,
              // so that last narration IS a genuine step — flush it to the trace.
              this.flushPendingNarration(sessionId, s);
            } else {
              // keep-last: the pending narration graduates verbatim into the
              // bubble — DISCARD it so it isn't ALSO traced as the last Step.
              s.pendingNarration = '';
            }
            if (reply) {
              // For resummarize the streamed text already replaced the draft; for
              // keep (resummarize:false) the draft is still the frozen narration.
              // onMessage clears the draft and lands the permanent bubble in place.
              this.onMessage?.(sessionId, { content: reply });
            } else {
              this.onSystemMessage?.(sessionId, { kind: 'no_reply' });
            }
          }
          break;
        }
        // ask_user surfaces via extension_ui_request (→ question card), not as a
        // TRACE step — swallow its tool_* so it doesn't leak into the trace.
        if (toolName === 'ask_user') break;
        // A real tool ran — mark that the current narration (if any) is no longer
        // the trailing reply, so the skip-finalize rule requires a finalize round.
        // The pending narration is now confirmed intermediate (a tool follows it),
        // so FLUSH it to the trace BEFORE the tool step to keep chronological order.
        const s = this.sessions.get(sessionId);
        if (s) {
          this.flushPendingNarration(sessionId, s);
          s.toolSinceLastNarration = true;
        }
        this.onToolStart?.(sessionId, {
          toolName,
          args: (e.args as Record<string, unknown>) ?? {},
          toolCallId: e.toolCallId as string | undefined,
        });
        break;
      }
      case 'tool_execution_end': {
        const toolName = String(e.toolName ?? 'tool');
        // finalize_reply / ask_user are human-interaction tools, not TRACE.
        if (toolName === 'finalize_reply' || toolName === 'ask_user') break;
        // pi tool results are `{ content: [TextContent|ImageContent], details }`.
        // Extract text for the trace and externalize any image blocks (e.g. from
        // the show_image tool) into the attachment store so their bytes reach
        // connected devices — mirrors the claude/copilot outbound image path.
        const imageAttachments: import('@kraki/protocol').Attachment[] = [];
        let resultText: string;
        const raw = e.result as unknown;
        const blocks =
          raw && typeof raw === 'object' && Array.isArray((raw as { content?: unknown }).content)
            ? ((raw as { content: Array<Record<string, unknown>> }).content)
            : null;
        if (blocks) {
          resultText = blocks
            .filter(c => c.type === 'text' && typeof c.text === 'string')
            .map(c => c.text as string)
            .join('\n');
          if (this.attachmentStore) {
            for (const c of blocks) {
              if (c.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string') {
                try {
                  const bytes = Buffer.from(c.data, 'base64');
                  const mime = c.mimeType;
                  const { bytes: resized, mimeType: outMime } = await fitToMaxDimension(bytes, mime).catch(() => ({ bytes, mimeType: mime }));
                  const ref = this.attachmentStore.put(sessionId, resized, outMime, {});
                  imageAttachments.push(ref);
                } catch (err) {
                  logger.warn({ err, sessionId }, 'failed to store pi image attachment');
                }
              }
            }
          }
        } else {
          resultText = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
        }
        if (imageAttachments.length > 0 && !resultText) resultText = 'Displayed image.';
        this.onToolComplete?.(sessionId, {
          toolName,
          result: resultText,
          toolCallId: e.toolCallId as string | undefined,
          success: e.isError !== true,
          ...(imageAttachments.length > 0 && { attachments: imageAttachments }),
        });
        if (imageAttachments.length > 0) {
          const refs = imageAttachments.filter(
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
        const s = this.sessions.get(sessionId);
        if (!s) {
          this.onIdle?.(sessionId);
          break;
        }
        if (s.finalizing) {
          // The injected finalize round just ended. If the model called
          // finalize_reply, the reply was already crystallized. Otherwise fall
          // back to its finalize-round prose, then the kept draft, then a notice.
          if (!s.finalizeResolved) {
            // Prefer the finalize-round's own prose; if the model produced none,
            // fall back to the kept draft. When the fallback is the finalize
            // prose (distinct from the draft), the pending narration is a genuine
            // step → flush it; when it IS the kept draft, that draft graduates
            // into the bubble → discard so it isn't ALSO traced.
            const finalizeProse = s.finalizeNarration.trim();
            if (finalizeProse) {
              this.flushPendingNarration(sessionId, s);
              this.onMessage?.(sessionId, { content: finalizeProse });
            } else {
              s.pendingNarration = '';
              const draft = s.lastNarration.trim();
              if (draft) this.onMessage?.(sessionId, { content: draft });
              else this.onSystemMessage?.(sessionId, { kind: 'no_reply' });
            }
          }
          s.finalizing = false;
          this.onIdle?.(sessionId);
          break;
        }
        // Skip-finalize rule: a turn with EXACTLY ONE narration segment and no
        // tool after it is already a clean trailing reply (e.g. "ran git → one
        // explanation", or a pure one-line chat) — graduate that draft directly,
        // no finalize round. Any other shape (multi-segment where keep-last
        // dropped earlier prose, ends-on-tool, or zero narration) needs the model
        // to settle a single clean closing message via finalize_reply.
        const skip = s.narrationSegments === 1 && !s.toolSinceLastNarration;
        if (skip) {
          // The single trailing narration graduates verbatim into the bubble —
          // discard the deferred trace so it isn't ALSO shown as the last Step.
          s.pendingNarration = '';
          const reply = s.lastNarration.trim();
          if (reply) this.onMessage?.(sessionId, { content: reply });
          this.onIdle?.(sessionId);
          break;
        }
        if (s.proc.alive) {
          s.finalizing = true;
          s.finalizeResolved = false;
          s.finalizeNarration = '';
          s.finalizeStreamId = undefined;
          s.finalizeStreamLen = 0;
          logger.debug({ sessionId, segments: s.narrationSegments }, 'injecting finalize round');
          s.proc.send('prompt', { message: finalizePrompt(s.lastNarration) });
          break;
        }
        // Process gone before we could finalize — best-effort crystallize the
        // kept draft, which graduates into the bubble → discard its deferred trace.
        s.pendingNarration = '';
        const fallback = s.lastNarration.trim();
        if (fallback) this.onMessage?.(sessionId, { content: fallback });
        this.onIdle?.(sessionId);
        break;
      }
      case 'session_shutdown':
        this.onSessionEnded?.(sessionId, { reason: 'pi shutdown' });
        break;
      case 'extension_ui_request': {
        if (typeof e.id !== 'string') break;
        const s = this.sessions.get(sessionId);
        if (!s) break;
        // ask_user surfaces via ctx.ui.select (choices) / ctx.ui.input (free-form)
        // → a Kraki question card. The arm's answer returns via respondToQuestion
        // → the matching extension_ui_response.
        if (e.method === 'select' || e.method === 'input') {
          const qid = e.id;
          s.pendingQuestions.set(qid, qid);
          const choices = Array.isArray(e.options) ? (e.options as string[]) : undefined;
          this.onQuestionRequest?.(sessionId, {
            id: qid,
            question: String(e.title ?? 'The agent has a question'),
            choices,
            allowFreeform: e.method === 'input',
          });
          break;
        }
        // The permission-gate extension asks ctx.ui.confirm(toolName, inputJson)
        // before every non-capability tool → the adapter applies its mode policy:
        // auto-approve silently (no card) OR raise a Kraki permission card whose
        // decision returns via respondToPermission → extension_ui_response. Other
        // UI methods (notify/status/…) are unused and need no reply.
        if (e.method !== 'confirm') break;
        const permId = e.id;
        const toolName = String(e.title ?? 'tool');
        const inputJson = typeof e.message === 'string' ? e.message : '';
        let input: Record<string, unknown> = {};
        try {
          const parsed = inputJson ? JSON.parse(inputJson) : {};
          if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>;
        } catch { /* leave input empty on malformed JSON */ }
        if (shouldAutoApprove(s.mode, toolName, input)) {
          // Silent approve — no card. Respond immediately so the tool runs.
          s.proc.sendRaw({ type: 'extension_ui_response', id: permId, confirmed: true });
          logger.debug({ sessionId, toolName, mode: s.mode }, 'pi tool auto-approved');
          break;
        }
        s.pendingPerms.set(permId, permId);
        const { toolArgs, description } = parsePiPermission(toolName, inputJson);
        logger.debug({ sessionId, permId, toolName: toolArgs.toolName }, 'pi permission requested');
        this.onPermissionRequest?.(sessionId, { id: permId, toolArgs, description });
        break;
      }
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
    const model = config.model ?? this.getDefaultModel();
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
    // A fresh spawn adopts the persisted mode, so drop any stale mode signal.
    this.pendingModeSignals.delete(sessionId);
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
      meta?.model ?? this.getDefaultModel(),
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

  async sendMessage(sessionId: string, text: string, attachments?: import('@kraki/protocol').Attachment[]): Promise<void> {
    const s = this.sessions.get(sessionId) ?? (await this.resumeSession(sessionId), this.sessions.get(sessionId));
    if (!s) throw new Error(`pi session ${sessionId} not found`);
    this.touch(sessionId);
    // Edge-triggered mode signal: if the mode changed since the last message,
    // prepend a one-shot marker so the model knows its new permission envelope.
    // The meta sidecar (kraki_get_mode) stays the source of truth; this is just
    // an inline heads-up (mirrors the claude/copilot adapters).
    const pendingMode = this.pendingModeSignals.get(sessionId);
    if (pendingMode) {
      this.pendingModeSignals.delete(sessionId);
      text = `[kraki: mode changed to ${pendingMode}]\n\n${text}`;
    }
    // A new user message opens a fresh logical turn: reset the finalize/skip
    // tracking so the skip-finalize rule and finalize round apply per user message.
    s.narrationSegments = 0;
    s.toolSinceLastNarration = false;
    s.lastNarration = '';
    s.pendingNarration = '';
    s.finalizing = false;
    s.finalizeResolved = false;
    s.finalizeNarration = '';
    s.finalizeStreamId = undefined;
    s.finalizeStreamLen = 0;
    // The `prompt` RPC resolves as soon as pi accepts the run (it streams
    // asynchronously and ends with agent_end); backend failures surface
    // in-stream as message_end{stopReason:'error'} -> onError. The await here
    // is the transport-level safety net: if the request itself is rejected
    // (stdin closed, process gone, command timeout) there will be no agent_end,
    // so emit error + idle to avoid hanging the session "active" forever.
    try {
      // pi's RPC `prompt` natively accepts image attachments as ImageContent
      // blocks ({type:'image', data:base64, mimeType}) — a 1:1 match with
      // Kraki's ImageAttachment. Non-image attachments (ContentRef handles)
      // can't be inlined into a prompt, so they're dropped.
      const images = (attachments ?? [])
        .filter((a): a is import('@kraki/protocol').ImageAttachment => a.type === 'image')
        .map(a => ({ type: 'image' as const, data: a.data, mimeType: a.mimeType }));
      await s.proc.request('prompt', { message: text, ...(images.length > 0 && { images }) });
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
    // Echo the pi UI request id verbatim; `value` resolves ctx.ui.select/input in
    // the ask_user tool, which returns the answer to the model as the tool result.
    s.proc.sendRaw({ type: 'extension_ui_response', id: questionId, value: answer });
    logger.debug({ sessionId, questionId }, 'pi question answered');
  }

  async killSession(sessionId: string): Promise<void> {
    this.clearPendingPerms(sessionId);
    this.clearPendingQuestions(sessionId);
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
    const next = this.spawn(newSessionId, src?.cwd ?? process.cwd(), src?.model ?? this.getDefaultModel(), src?.mode ?? MUTATING_DEFAULT_MODE, forkFile, src?.thinking);
    this.persistMeta(newSessionId, next);
    return { sessionId: newSessionId };
  }

  setSessionMode(sessionId: string, mode: Mode): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.mode === mode) return;
    s.mode = mode;
    // No respawn: the gate is loaded in every mode and the adapter applies the
    // policy per-call, so the mode change takes effect immediately WITHOUT
    // killing the in-flight turn. Persist the new mode so it survives a daemon
    // restart AND so the extension's kraki_get_mode (KRAKI_META_FILE) reads it live.
    this.persistMeta(sessionId, s);
    // Edge-triggered: prepend a one-shot marker to the next user message.
    this.pendingModeSignals.set(sessionId, mode);
    // If a turn is streaming right now, also nudge the model mid-run via steer so
    // it re-checks its permission envelope before acting on a stale one.
    void this.steerModeNudge(sessionId);
    logger.debug({ sessionId, mode }, 'pi session mode changed');
  }

  /** Steer a mode-agnostic nudge into an active turn so the model re-checks its
   *  permission envelope. No-op when the session is idle (the prepend on the next
   *  message covers that). Active state is read from pi's get_state
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
    const [provider, modelId] = model.includes('/') ? model.split('/') : [this.getDefaultModel().split('/')[0], model];
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

  private cachedModels: PiModelRow[] | null = null;

  private fetchModels(): PiModelRow[] {
    if (this.cachedModels) return this.cachedModels;
    try {
      const stdout = execSync(`"${this.cliPath}" --list-models`, {
        encoding: 'utf-8',
        timeout: 15_000,
        env: process.env,
      });
      this.cachedModels = parsePiListModels(stdout);
      logger.info({ count: this.cachedModels.length }, 'Fetched pi model list');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Could not fetch pi model list, using empty list');
      this.cachedModels = [];
    }
    return this.cachedModels;
  }

  private getDefaultModel(): string {
    return resolveDefaultModel(this.fetchModels());
  }

  async listModels(): Promise<string[]> {
    return this.fetchModels().map(m => `${m.provider}/${m.model}`);
  }

  async listModelDetails(): Promise<ModelDetail[]> {
    const efforts: ReasoningEffort[] = ['high', 'xhigh'];
    return this.fetchModels().map(m => ({
      id: `${m.provider}/${m.model}`,
      name: `${m.provider.charAt(0).toUpperCase() + m.provider.slice(1)} ${m.model}`,
      supportsReasoningEffort: m.reasoning,
      supportedReasoningEfforts: m.reasoning ? efforts : undefined,
      defaultReasoningEffort: m.reasoning ? 'high' as const : undefined,
      contextWindow: m.contextWindow,
    }));
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
