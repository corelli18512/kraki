/**
 * In-job supervisor for the daemon started by Kraki for Mac.
 *
 * Kraki for Mac's launchd job has KeepAlive, but launchd only honours it while
 * the user's launchd domain is in its normal mode. After an interrupted
 * restart/logout (e.g. macOS's scheduled-update restart blocked by an app)
 * the domain can stay in "on-demand-only" mode until the next reboot: a crashed
 * daemon is then never restarted ("pending spawn, domain in on-demand-only
 * mode"), and the Mac shows as offline everywhere.
 *
 * So the job's process is a tiny supervisor that runs the real worker as a
 * child and restarts it itself after an abnormal exit — no launchd involvement.
 * A clean exit (code 0, e.g. after SIGTERM) ends the supervisor too, so stop,
 * disable and update keep their normal launchd semantics. Signals sent to the
 * job reach the supervisor and are forwarded to the worker; the worker also
 * exits on its own if the supervisor disappears, so a worker can never be
 * orphaned next to a newly started one.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SUPERVISED_ENV = 'KRAKI_SUPERVISED';

/** Restart delay after the n-th consecutive quick failure (1s, 2s, 4s … 60s). */
export function restartDelayMs(consecutiveFailures: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, consecutiveFailures - 1));
}

/** A worker that ran this long counts as healthy: the backoff starts over. */
export const HEALTHY_UPTIME_MS = 60_000;

export function isCleanExit(code: number | null, signal: NodeJS.Signals | null): boolean {
  return code === 0 && signal === null;
}

export interface SupervisorOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  logFile?: string;
  /** For tests: stop after this many worker starts. */
  maxStarts?: number;
  delay?: (n: number) => number;
}

export function runSupervisor(opts: SupervisorOptions): Promise<number> {
  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] supervisor pid=${process.pid}: ${msg}\n`;
    if (!opts.logFile) { process.stderr.write(line); return; }
    try { mkdirSync(dirname(opts.logFile), { recursive: true }); appendFileSync(opts.logFile, line); } catch { /* best effort */ }
  };
  const delay = opts.delay ?? restartDelayMs;
  let child: ChildProcess | null = null;
  let stopping = false;
  let failures = 0;
  let starts = 0;
  let timer: NodeJS.Timeout | null = null;

  return new Promise((resolve) => {
    const finish = (code: number) => {
      for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.removeListener(s, onSignal);
      resolve(code);
    };

    const onSignal = (signal: NodeJS.Signals) => {
      if (signal === 'SIGHUP') return; // terminal hangup: not a stop request
      stopping = true;
      if (timer) { clearTimeout(timer); timer = null; }
      log(`${signal}: stopping worker`);
      if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
      else finish(0);
    };
    for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(s, onSignal);

    const start = () => {
      timer = null;
      if (stopping) { finish(0); return; }
      starts++;
      const startedAt = Date.now();
      child = spawn(opts.command, opts.args, {
        stdio: 'inherit',
        env: { ...(opts.env ?? process.env), [SUPERVISED_ENV]: String(process.pid) },
      });
      log(`started worker pid=${child.pid}`);
      child.on('error', (err) => log(`spawn error: ${err.message}`));
      child.on('exit', (code, signal) => {
        child = null;
        if (stopping || isCleanExit(code, signal)) {
          log(`worker exited cleanly (code=${code} signal=${signal})`);
          finish(0);
          return;
        }
        failures = Date.now() - startedAt >= HEALTHY_UPTIME_MS ? 1 : failures + 1;
        if (opts.maxStarts !== undefined && starts >= opts.maxStarts) { finish(1); return; }
        const wait = delay(failures);
        log(`worker died (code=${code} signal=${signal}); restarting in ${wait}ms`);
        timer = setTimeout(start, wait);
      });
    };
    start();
  });
}

/**
 * In the worker: exit if the supervisor that started us is gone, so a
 * SIGKILLed job can never leave an old worker running beside a new one.
 */
export function watchSupervisor(onOrphaned: () => void, intervalMs = 2000): NodeJS.Timeout | null {
  const parent = Number(process.env[SUPERVISED_ENV]);
  if (!parent) return null;
  const timer = setInterval(() => {
    let alive = process.ppid === parent;
    if (alive) {
      try { process.kill(parent, 0); } catch { alive = false; }
    }
    if (!alive) { clearInterval(timer); onOrphaned(); }
  }, intervalMs);
  timer.unref();
  return timer;
}
