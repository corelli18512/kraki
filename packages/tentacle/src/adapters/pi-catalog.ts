/** Pi's model catalog: `pi --list-models`, thinking levels → Kraki efforts, default model. */

import { spawn } from 'node:child_process';
import { cliSpawnArgs } from '../cli-launch.js';
import { readPiJsonLines } from './pi-jsonl.js';
import type { ReasoningEffort } from '@kraki/protocol';

/** Kraki ReasoningEffort → pi ThinkingLevel. The names line up 1:1 — pi's ladder
 *  is off|minimal|low|medium|high|xhigh|max, so `max` is a rung of its own and
 *  must not be folded into xhigh. On Anthropic's adaptive-thinking models each
 *  rung becomes an effort value and only `max` reaches the top one. */
export function effortToThinking(effort?: string): string | undefined {
  switch (effort) {
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh': return 'xhigh';
    case 'max': return 'max';
    default: return undefined;
  }
}

// ── Dynamic model discovery via `pi --list-models` ────────────────

export interface PiModelRow {
  provider: string;
  model: string;
  contextWindow: number;
  reasoning: boolean;
}

/** Parse the human-readable table output of `pi --list-models`. */
export function parsePiListModels(stdout: string): PiModelRow[] {
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

export function parseContext(s: string): number {
  s = s.trim().toUpperCase();
  if (s.endsWith('K')) return parseInt(s, 10) * 1000;
  if (s.endsWith('M')) return parseInt(s, 10) * 1_000_000;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 200_000;
}

/** A cold pi start right after login can exceed this; the adapter retries. */
export const PI_LIST_MODELS_TIMEOUT_MS = 15_000;
/** Backoff for retrying a failed `--list-models`; the last delay repeats. */
export const PI_LIST_MODELS_RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 300_000];

export interface PiListModelsError extends Error {
  timedOut?: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdoutTail?: string;
  stderrTail?: string;
}

/** Pick the line that explains a crash from a stderr tail: the last
 *  "SomethingError: …" line, else the last line that isn't Node's version
 *  banner or a stack frame. */
export function summarizeCrash(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((l) => /^(?:[A-Z]\w*)?Error\b[^:]*:/.test(l));
  const pick = errorLine ?? [...lines].reverse().find((l) => !/^Node\.js v/.test(l) && !/^at\s/.test(l) && !/^\^+$/.test(l));
  return pick?.slice(0, 300);
}

/** Run `pi --list-models` asynchronously. On failure the error carries the
 *  elapsed outcome and the tail of whatever pi printed, so a slow or stuck
 *  start is diagnosable instead of a bare `ETIMEDOUT`. */
export function runPiListModels(cliPath: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(...cliSpawnArgs(cliPath, ['--list-models']), { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const tail = (text: string) => text.slice(-600).trim() || undefined;
    const fail = (message: string, extra: Partial<PiListModelsError>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = new Error(message) as PiListModelsError;
      Object.assign(err, extra, { stdoutTail: tail(stdout), stderrTail: tail(stderr) });
      reject(err);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      fail(`pi --list-models timed out after ${timeoutMs}ms`, { timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e) => fail(`pi --list-models failed to start: ${e.message}`, {}));
    child.on('close', (code, signal) => {
      if (timedOut || settled) return;
      if (code !== 0) {
        fail(`pi --list-models exited with ${code ?? signal}`, { exitCode: code, signal });
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(stdout);
    });
  });
}

export function resolveDefaultModel(models: PiModelRow[]): string {
  if (models.length === 0) return 'deepseek/deepseek-v4-pro';
  // Prefer a pro/large model as default, then the first model
  const preferred = models.find(m => m.model.includes('pro') || m.model.includes('opus')) ?? models[0];
  return `${preferred.provider}/${preferred.model}`;
}

// ── Per-model thinking levels via the `get_available_models` RPC ───

/** The slice of a pi catalog entry we need. `--list-models` reports thinking as
 *  a bare yes/no, so the thinkingLevelMap — the thing that says which rungs a
 *  model actually has — is only reachable over RPC. */
export interface PiCatalogModel {
  id: string;
  provider: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

/** pi's ladder, weakest first. Kraki has no `off`/`minimal` rung. */
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const KRAKI_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Ladder to fall back on when the catalog is unreachable: what the adapter
 *  offered for every reasoning model before it could ask per model. */
export const FALLBACK_EFFORTS: ReasoningEffort[] = ['high', 'xhigh'];

/** Mirrors pi-ai's `getSupportedThinkingLevels`. off/minimal/low/medium/high are
 *  available unless the model's map nulls them out; xhigh and max are opt-in —
 *  a model only has them if its map declares them. Anything else would advertise
 *  rungs pi then silently clamps away. */
export function piThinkingLevelsFor(model: PiCatalogModel): ReasoningEffort[] {
  if (!model.reasoning) return [];
  return PI_THINKING_LEVELS.filter(level => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  }).filter((level): level is ReasoningEffort =>
    (KRAKI_EFFORTS as readonly string[]).includes(level));
}

/** `high` when the model has it, else the strongest rung below it — the same
 *  direction pi's own clamp walks. */
export function defaultEffortFor(efforts: ReasoningEffort[]): ReasoningEffort | undefined {
  for (let i = KRAKI_EFFORTS.indexOf('high'); i >= 0; i--) {
    if (efforts.includes(KRAKI_EFFORTS[i])) return KRAKI_EFFORTS[i];
  }
  return efforts[0];
}

export function queryPiCatalog(cliPath: string, timeoutMs = 15_000): Promise<PiCatalogModel[]> {
  return new Promise((resolve, reject) => {
    // --no-session: this process only answers one question, it must not leave a
    // session file behind next to the user's real ones.
    const child = spawn(...cliSpawnArgs(cliPath, ['--mode', 'rpc', '--no-session']), {
      windowsHide: true,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stopReading = () => {};
    let settled = false;
    let lastStderr = '';
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopReading();
      child.kill();
      fn();
    };
    const fail = (reason: string) =>
      finish(() => reject(new Error(lastStderr ? `${reason}: ${lastStderr}` : reason)));
    const timer = setTimeout(() => fail('pi catalog query timed out'), timeoutMs);

    stopReading = readPiJsonLines(child.stdout, line => {
      let msg: { type?: string; command?: string; success?: boolean; error?: string; data?: { models?: PiCatalogModel[] } };
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type !== 'response' || msg.command !== 'get_available_models') return;
      if (msg.success === false) {
        fail(msg.error || 'pi catalog query failed');
        return;
      }
      finish(() => resolve(msg.data?.models ?? []));
    });
    // Drain stderr rather than leaving it piped and unread: a full pipe buffer
    // would block pi mid-write and stall the query until the timeout. Keeping
    // the last chunk also gives the rejection something to say.
    child.stderr.on('data', d => { lastStderr = String(d).trim().slice(-200) || lastStderr; });
    child.on('error', err => finish(() => reject(err)));
    child.on('exit', () => fail('pi exited before answering'));
    // An unhandled 'error' on stdin is a process-level crash, and this stream
    // breaks whenever pi dies early — a degraded ladder is the acceptable
    // outcome here, taking the daemon down with it is not.
    child.stdin.on('error', () => fail('pi stdin closed before the query was sent'));
    if (child.stdin.writable) {
      child.stdin.write(`${JSON.stringify({ id: 'models', type: 'get_available_models' })}\n`);
    }
  });
}
