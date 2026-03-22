/**
 * Daemon process management for Kraki tentacle.
 *
 * The daemon runs as a detached child process executing daemon-worker.js.
 * Its PID is tracked in ~/.kraki/daemon.pid.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getLogVerbosity,
  type KrakiConfig,
  saveDaemonPid,
  loadDaemonPid,
  clearDaemonPid,
} from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STARTUP_GRACE_MS = 1500;
const BOOTSTRAP_LOG_PATH = join(homedir(), '.kraki', 'logs', 'daemon-bootstrap.log');

export interface DaemonLaunchSpec {
  runtime: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  workerPath: string;
}

export function getDaemonBootstrapLogPath(): string {
  return BOOTSTRAP_LOG_PATH;
}

export function resolveDaemonLaunch(currentUrl: string = import.meta.url): DaemonLaunchSpec {
  const moduleDir = dirname(fileURLToPath(currentUrl));
  const isTsSource = currentUrl.endsWith('.ts');
  const packageRoot = resolve(moduleDir, '..');
  const workspaceRoot = resolve(packageRoot, '..', '..');
  const workerFile = isTsSource ? 'daemon-worker.ts' : 'daemon-worker.js';
  const workerPath = join(moduleDir, workerFile);

  const binPaths = isTsSource
    ? [join(workspaceRoot, 'node_modules', '.bin'), join(packageRoot, 'node_modules', '.bin')]
    : [join(packageRoot, 'node_modules', '.bin')];

  return {
    runtime: process.execPath,
    args: isTsSource ? ['--import', 'tsx', workerPath] : [workerPath],
    cwd: isTsSource ? workspaceRoot : packageRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PATH: [...binPaths, process.env.PATH ?? ''].filter(Boolean).join(':'),
    },
    workerPath,
  };
}

function waitForDaemonBootstrap(child: ChildProcess, timeoutMs = STARTUP_GRACE_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
    };

    const onError = (err: Error) => {
      cleanup();
      reject(new Error(`Kraki failed to start: ${err.message}. Check ${getDaemonBootstrapLogPath()}`));
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Kraki exited during startup (code ${code ?? 'null'}, signal ${signal ?? 'none'}). Check ${getDaemonBootstrapLogPath()}`,
        ),
      );
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    child.once('error', onError);
    child.once('exit', onExit);
  });
}

// ── Status ──────────────────────────────────────────────

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
}

export function isDaemonRunning(): boolean {
  const pid = loadDaemonPid();
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist — stale PID file
    clearDaemonPid();
    return false;
  }
}

export function getDaemonStatus(): DaemonStatus {
  const pid = loadDaemonPid();
  if (pid === null) return { running: false, pid: null };

  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    clearDaemonPid();
    return { running: false, pid: null };
  }
}

// ── Start / Stop ────────────────────────────────────────

export async function startDaemon(config: KrakiConfig): Promise<number> {
  // Kill any existing daemon(s) before starting a new one
  stopDaemon();

  const launch = resolveDaemonLaunch();
  launch.env.LOG_LEVEL = getLogVerbosity(config) === 'verbose' ? 'debug' : 'info';
  mkdirSync(dirname(BOOTSTRAP_LOG_PATH), { recursive: true });
  const bootstrapFd = openSync(BOOTSTRAP_LOG_PATH, 'w');

  const child = spawn(launch.runtime, launch.args, {
    detached: true,
    stdio: ['ignore', bootstrapFd, bootstrapFd],
    cwd: launch.cwd,
    env: launch.env,
  });

  closeSync(bootstrapFd);

  if (!child.pid) {
    throw new Error(`Kraki failed to start: no daemon PID returned. Check ${getDaemonBootstrapLogPath()}`);
  }

  try {
    await waitForDaemonBootstrap(child);
  } catch (err) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      // Child may already be gone
    }
    throw err;
  }

  child.unref();
  saveDaemonPid(child.pid);
  return child.pid;
}

export function stopDaemon(): boolean {
  const pid = loadDaemonPid();
  if (pid !== null) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process already gone
    }
    clearDaemonPid();
  }

  // Kill any orphaned daemon-worker processes (missed by PID tracking)
  killOrphanedWorkers();

  return pid !== null;
}

/**
 * Find and kill any daemon-worker processes not tracked by the PID file.
 */
function killOrphanedWorkers(): void {
  try {
    const output = execSync('ps -eo pid,command', { encoding: 'utf8' });
    for (const line of output.split('\n')) {
      if (line.includes('daemon-worker') && !line.includes('grep')) {
        const pidStr = line.trim().split(/\s+/)[0];
        const orphanPid = parseInt(pidStr, 10);
        if (orphanPid && orphanPid !== process.pid) {
          try { process.kill(orphanPid, 'SIGTERM'); } catch { /* already gone */ }
        }
      }
    }
  } catch {
    // ps not available — skip orphan cleanup
  }
}
