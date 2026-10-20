/**
 * Supervisor for the daemon worker: restarts it after a crash.
 *
 * Used by Kraki for Mac's and Kraki for Windows' jobs, and by `kraki start`
 * on every platform except the macOS binary (which runs under launchd). The
 * Mac story below is why it exists at all:
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
import { appendFileSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SUPERVISED_ENV = 'KRAKI_SUPERVISED';

/** Set by `kraki start` on the worker it launches: run under a supervisor. */
export const SUPERVISE_ENV = 'KRAKI_SUPERVISE';

/** A worker exit code meaning "restarting won't help" (no config): the
 *  supervisor stops instead of retrying forever. EX_CONFIG from sysexits.h. */
export const PERMANENT_EXIT_CODE = 78;

/** Supervisor exit code when its own executable was replaced or deleted
 *  (EX_TEMPFAIL): launchd's KeepAlive starts the job again from the new file. */
export const BINARY_REPLACED_EXIT_CODE = 75;

/** How often the supervisor checks whether its executable was replaced. */
export const BINARY_CHECK_INTERVAL_MS = 30_000;

/** Identity of the file at `path` (device + inode), or null when it is gone. */
export function executableIdentity(path: string): string | null {
  try {
    const s = statSync(path);
    return `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
}

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
  /** Record this supervisor's PID here while it runs (`kraki stop` reads it). */
  pidFile?: string;
  /**
   * Exit with BINARY_REPLACED_EXIT_CODE once this file is replaced or deleted.
   *
   * Why: macOS TCC attributes the worker's (and every agent's) file access to
   * this launchd-spawned process. When an app update (Sparkle) swaps the
   * bundle while we run, our executable no longer exists on disk; once TCC's
   * cached decisions expire, tccd fails to build the attribution chain
   * ("proc_pidpath_audittoken() failed … No such file or directory") and
   * denies Documents/Desktop/Full Disk Access even though access is granted.
   * Sparkle puts the new file at the same path, so compare the inode, not
   * just existence. Two consecutive mismatches are required so a check that
   * lands mid-swap does not trigger a restart.
   */
  watchExecutable?: string;
  /** For tests: binary check interval. */
  binaryCheckMs?: number;
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
  let binaryTimer: NodeJS.Timeout | null = null;
  let stopCode = 0;

  if (opts.pidFile) {
    try { mkdirSync(dirname(opts.pidFile), { recursive: true }); writeFileSync(opts.pidFile, String(process.pid)); } catch { /* best effort */ }
  }
  return new Promise((resolve) => {
    const finish = (code: number) => {
      if (binaryTimer) { clearInterval(binaryTimer); binaryTimer = null; }
      for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.removeListener(s, onSignal);
      if (opts.pidFile) {
        try { if (readFileSync(opts.pidFile, 'utf8').trim() === String(process.pid)) unlinkSync(opts.pidFile); } catch { /* gone */ }
      }
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

    const watched = opts.watchExecutable;
    const initialIdentity = watched ? executableIdentity(watched) : null;
    if (watched && initialIdentity) {
      let mismatches = 0;
      binaryTimer = setInterval(() => {
        if (stopping) return;
        const now = executableIdentity(watched);
        mismatches = now === initialIdentity ? 0 : mismatches + 1;
        if (mismatches < 2) return;
        stopping = true;
        stopCode = BINARY_REPLACED_EXIT_CODE;
        if (timer) { clearTimeout(timer); timer = null; }
        log(`executable ${now ? 'replaced' : 'deleted'} (${watched}); stopping worker so launchd restarts the new one`);
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        else finish(stopCode);
      }, opts.binaryCheckMs ?? BINARY_CHECK_INTERVAL_MS);
      binaryTimer.unref();
    }

    const start = () => {
      timer = null;
      if (stopping) { finish(stopCode); return; }
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
          finish(stopCode);
          return;
        }
        if (code === PERMANENT_EXIT_CODE) {
          log(`worker exited with code ${code} (restarting won't help); stopping`);
          finish(code);
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
