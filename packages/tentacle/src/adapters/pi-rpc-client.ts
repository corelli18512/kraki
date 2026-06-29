/**
 * Thin wrapper around one `pi --mode rpc` child process.
 *
 * pi speaks newline-delimited JSON on stdin/stdout:
 *   - commands in  → `{ id, type, ... }`
 *   - responses out → `{ id, type: "response", command, success, data|error }`
 *   - events out    → session.subscribe stream, e.g. `{ type: "text", text }`,
 *                     `{ type: "tool_execution_start", ... }`, `{ type: "agent_end" }`
 *
 * One process = one pi session (process-per-session isolation). The PiAdapter
 * pools these and evicts idle ones to bound memory.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { createLogger } from '../logger.js';

const logger = createLogger('pi-rpc');

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
  /** Absolute path to the `pi` CLI binary. */
  cliPath: string;
  /** Working directory for the session. */
  cwd?: string;
  /** provider/model to launch with. */
  provider?: string;
  model?: string;
  /** Restrict the tool set (read-only mode = ['read','grep','find','ls']). */
  tools?: string[];
  /** Resume an existing on-disk session file. */
  sessionFile?: string;
  /** Extra system prompt appended to pi's default. */
  appendSystemPrompt?: string;
  /** Thinking level: off|minimal|low|medium|high|xhigh (xhigh = max). */
  thinking?: string;
}

/** Default command timeout. Prompts run async (fire-and-forget), so this only
 *  bounds short control commands. */
const CMD_TIMEOUT_MS = 30_000;

export class PiRpcProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private buffer = '';
  /** Listener for unsolicited events (everything that isn't a response). */
  onEvent: ((e: PiRpcEvent) => void) | null = null;
  onExit: ((code: number | null) => void) | null = null;

  constructor(private opts: PiRpcOptions) {}

  start(): void {
    const args = ['--mode', 'rpc'];
    if (this.opts.provider) args.push('--provider', this.opts.provider);
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.tools?.length) args.push('--tools', this.opts.tools.join(','));
    if (this.opts.thinking) args.push('--thinking', this.opts.thinking);
    if (this.opts.sessionFile) args.push('--continue');
    if (this.opts.appendSystemPrompt) args.push('--append-system-prompt', this.opts.appendSystemPrompt);

    this.child = spawn(this.opts.cliPath, args, {
      cwd: this.opts.cwd ?? process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (d) => logger.debug({ stderr: d.toString().trim() }, 'pi stderr'));
    this.child.on('exit', (code) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('pi process exited'));
      }
      this.pending.clear();
      this.onExit?.(code);
    });
  }

  private handleLine(line: string): void {
    const t = line.trim();
    if (!t) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(t);
    } catch {
      logger.debug({ line: t }, 'non-JSON pi line');
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
    this.rl?.close();
    if (this.child && !this.child.killed) this.child.kill('SIGTERM');
    this.child = null;
  }

  get alive(): boolean {
    return !!this.child && !this.child.killed;
  }
}
