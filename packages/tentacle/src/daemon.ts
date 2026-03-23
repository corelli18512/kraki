/**
 * Daemon process management for Kraki tentacle.
 *
 * The daemon runs as a detached child process executing daemon-worker.js.
 * Its PID is tracked under the current Kraki home.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getLogsDir,
  getLogVerbosity,
  type KrakiConfig,
  saveDaemonPid,
  loadDaemonPid,
  clearDaemonPid,
} from './config.js';

const STARTUP_GRACE_MS = 1500;

export interface DaemonLaunchSpec {
  runtime: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  workerPath: string;
}

export function getDaemonBootstrapLogPath(): string {
  return join(getLogsDir(), 'daemon-bootstrap.log');
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

function waitForDaemonBootstrap(
  child: ChildProcess,
  bootstrapLogPath: string,
  timeoutMs = STARTUP_GRACE_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
    };

    const onError = (err: Error) => {
      cleanup();
      reject(new Error(`Kraki failed to start: ${err.message}. Check ${bootstrapLogPath}`));
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Kraki exited during startup (code ${code ?? 'null'}, signal ${signal ?? 'none'}). Check ${bootstrapLogPath}`,
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
  const bootstrapLogPath = getDaemonBootstrapLogPath();
  mkdirSync(dirname(bootstrapLogPath), { recursive: true });
  const bootstrapFd = openSync(bootstrapLogPath, 'w');

  const child = spawn(launch.runtime, launch.args, {
    detached: true,
    stdio: ['ignore', bootstrapFd, bootstrapFd],
    cwd: launch.cwd,
    env: launch.env,
  });

  closeSync(bootstrapFd);

  if (!child.pid) {
    throw new Error(`Kraki failed to start: no daemon PID returned. Check ${bootstrapLogPath}`);
  }

  try {
    await waitForDaemonBootstrap(child, bootstrapLogPath);
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

  return pid !== null;
}
