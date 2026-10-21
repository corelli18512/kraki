/** The pi CLI in RPC mode: one child process per session, JSON lines in and out, command timeouts. */

import { agentEnv } from '../agent-env.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cliSpawnArgs } from '../cli-launch.js';
import { readPiJsonLines } from './pi-jsonl.js';
import { createLogger } from '../logger.js';
import { summarizeCrash } from './pi-catalog.js';

export const rpcLogger = createLogger('pi-rpc');

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

export interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface RequestOptions {
  /** Omitted = normal bounded control-command timeout; null = wait until the
   *  response or process exit. Prompt ACKs use null because preflight may spend
   *  minutes compacting after the frame has already been delivered. */
  timeoutMs?: number | null;
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
  /** Thinking level: off|minimal|low|medium|high|xhigh|max — `max` is pi's own
   *  top rung, above xhigh, not an alias for it. */
  thinking?: string;
  /** Path to a pi extension loaded via `--extension`. Kraki always loads its
   *  tools extension (ask_user / show_image + permission gate). */
  extensionPath?: string;
  /** Extra environment for the child. Kraki sets `KRAKI_META_FILE` here so the
   *  extension's kraki_get_mode can read the live permission mode. */
  env?: NodeJS.ProcessEnv;
}

/** Bounds short control commands. Prompt acceptance has its own watchdog. */
export const CMD_TIMEOUT_MS = 30_000;
export class PiRpcProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopReading: (() => void) | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private intentionalExit = false;
  private lastStderr = '';
  /** Rolling tail of everything pi printed on stderr (for crash reasons). */
  private stderrTail = '';
  onEvent: ((e: PiRpcEvent) => void) | null = null;
  /** Fires only on UNEXPECTED exit (crash). Intentional kill() is silent. */
  onExit: ((code: number | null) => void) | null = null;

  constructor(private opts: PiRpcOptions) {}

  /** The most telling stderr line after a crash, e.g. "TypeError: …". */
  crashReason(): string | undefined {
    return summarizeCrash(this.stderrTail);
  }

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
    // Kraki tools extension (ask_user / show_image / show_report /
    // kraki_get_mode + permission gate), always loaded. rpc mode has no built-in
    // tool-approval round-trip, so the gate's ctx.ui.confirm surfaces as an
    // extension_ui_request the adapter maps to a Kraki permission card (or
    // silently auto-approves per its mode policy). Loading unconditionally means
    // a mode change never respawns pi — the policy is enforced by the adapter.
    if (this.opts.extensionPath) args.push('--extension', this.opts.extensionPath);

    this.child = spawn(...cliSpawnArgs(this.opts.cliPath, args), {
      windowsHide: true,
      cwd: this.opts.cwd ?? process.cwd(),
      env: this.opts.env ?? agentEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.stopReading = readPiJsonLines(this.child.stdout, line => this.handleLine(line));
    this.child.stderr.on('data', (d) => {
      const stderr = d.toString().trim();
      if (stderr) this.lastStderr = stderr;
      this.stderrTail = (this.stderrTail + '\n' + d.toString()).slice(-4000);
      rpcLogger.debug({ stderr }, 'pi stderr');
    });
    // A spawn failure (pi removed, nvm switched, EACCES) is emitted as an
    // 'error' event. Without a listener Node rethrows it as an uncaught
    // exception and the daemon shuts down every agent. Treat it as an exit.
    const child = this.child;
    let exited = false;
    child.once('exit', () => { exited = true; });
    child.on('error', (err) => {
      this.lastStderr = err.message;
      rpcLogger.warn({ err: err.message }, 'pi process error');
      // A process that never started emits no 'exit' of its own.
      setImmediate(() => { if (!exited && child.pid === undefined) child.emit('exit', null, null); });
    });
    this.child.stdin.on('error', (err) => rpcLogger.debug({ err: err.message }, 'pi stdin error'));
    this.child.on('exit', (code) => {
      const detail = this.lastStderr ? `: ${this.lastStderr}` : '';
      for (const p of this.pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error(`pi process exited${detail}`));
      }
      this.pending.clear();
      this.child = null;
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
        if (p.timer) clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.success) p.resolve(msg.data);
        else p.reject(new Error(String(msg.error ?? 'pi command failed')));
      }
      return;
    }
    this.onEvent?.(msg as PiRpcEvent);
  }

  /** Send a command and await its response. Short control commands are bounded;
   *  callers may disable the wall-clock timer for commands whose response is
   *  legitimately delayed after delivery (notably prompt preflight/compaction). */
  request<T = unknown>(
    type: string,
    payload: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<T> {
    const id = `c${++this.seq}`;
    const frame = JSON.stringify({ id, type, ...payload });
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs === undefined ? CMD_TIMEOUT_MS : options.timeoutMs;
      const timer = timeoutMs === null ? null : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi command '${type}' timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (d: unknown) => void, reject, timer });
      if (!this.child?.stdin.writable) {
        if (timer) clearTimeout(timer);
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
    this.stopReading?.();
    this.stopReading = null;
    const child = this.child;
    if (child && !child.killed) {
      child.kill('SIGTERM');
      // A pi stuck in a long operation (e.g. compaction) may ignore SIGTERM;
      // never leave it running as an orphan.
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2_000);
      force.unref?.();
      child.once('exit', () => clearTimeout(force));
    }
    this.child = null;
  }

  /** OS pid of the running pi child (for logs), if any. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  get alive(): boolean {
    return !!this.child
      && this.child.exitCode === null
      && this.child.signalCode === null
      && this.child.stdin.writable
      && !this.child.stdin.destroyed;
  }
}
