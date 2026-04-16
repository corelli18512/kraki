/**
 * Daemon process management for Kraki tentacle.
 *
 * The daemon runs as a background child process executing daemon-worker.js.
 * Its PID is tracked under the current Kraki home.
 *
 * On macOS, downloaded SEA binaries carry com.apple.provenance which
 * cannot be removed. macOS 26+ CSM 2 blocks direct fork()+execve() of
 * such binaries (SIGKILL with "Code Signature Invalid"). To work around
 * this, macOS SEA builds spawn the daemon through /bin/sh so a trusted
 * system binary performs the execve(). If that also fails, the caller
 * falls back to running the daemon worker in the current process.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { delimiter, join, dirname, resolve } from 'node:path';
import { isSea } from 'node:sea';

import {
  getLogsDir,
  getLogVerbosity,
  type KrakiConfig,
  saveDaemonPid,
  loadDaemonPid,
  clearDaemonPid,
} from './config.js';

const STARTUP_GRACE_MS = 1500;
export const INTERNAL_DAEMON_WORKER_COMMAND = '__daemon-worker';

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

export function resolveDaemonLaunch(
  cliEntryPath: string | undefined = process.argv[1],
  seaMode = isSea(),
): DaemonLaunchSpec {
  if (seaMode) {
    return {
      runtime: process.execPath,
      args: [INTERNAL_DAEMON_WORKER_COMMAND],
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
      },
      workerPath: process.execPath,
    };
  }

  if (!cliEntryPath) {
    throw new Error('Cannot resolve daemon launch without a CLI entry path');
  }

  const entryPath = resolve(cliEntryPath);
  const moduleDir = dirname(entryPath);
  const isTsSource = entryPath.endsWith('.ts');
  const packageRoot = resolve(moduleDir, '..');
  const workspaceRoot = resolve(packageRoot, '..', '..');

  const binPaths = isTsSource
    ? [join(workspaceRoot, 'node_modules', '.bin'), join(packageRoot, 'node_modules', '.bin')]
    : [join(packageRoot, 'node_modules', '.bin')];

  return {
    runtime: process.execPath,
    args: isTsSource
      ? ['--import', 'tsx', entryPath, INTERNAL_DAEMON_WORKER_COMMAND]
      : [entryPath, INTERNAL_DAEMON_WORKER_COMMAND],
    cwd: isTsSource ? workspaceRoot : packageRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PATH: [...binPaths, process.env.PATH ?? ''].filter(Boolean).join(delimiter),
    },
    workerPath: entryPath,
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

export class MacOSCodeSignatureError extends Error {
  constructor(bootstrapLogPath: string) {
    super(
      `macOS blocked the daemon process (code signature provenance). ` +
      `Falling back to in-process daemon. Check ${bootstrapLogPath}`,
    );
    this.name = 'MacOSCodeSignatureError';
  }
}

// ── Start / Stop ────────────────────────────────────────

export async function startDaemon(config: KrakiConfig, cliEntryPath?: string): Promise<number> {
  // Kill any existing daemon(s) before starting a new one
  stopDaemon();

  const launch = resolveDaemonLaunch(cliEntryPath);
  launch.env.LOG_LEVEL = getLogVerbosity(config) === 'verbose' ? 'debug' : 'info';
  const bootstrapLogPath = getDaemonBootstrapLogPath();
  mkdirSync(dirname(bootstrapLogPath), { recursive: true });
  const bootstrapFd = openSync(bootstrapLogPath, 'w');

  // On macOS, downloaded SEA binaries carry com.apple.provenance.
  // CSM 2 blocks a direct fork()+execve() of provenance-marked binaries
  // from a child of the same binary. Spawning through /bin/sh (a trusted
  // system binary) lets the shell perform the execve() instead.
  // If this still fails the caller gets MacOSCodeSignatureError and can
  // fall back to running the daemon worker in-process.
  const useMacOSShellSpawn = process.platform === 'darwin' && isSea();

  const child = useMacOSShellSpawn
    ? spawn(
        '/bin/sh',
        ['-c', `exec "${launch.runtime}" ${launch.args.map(a => `"${a}"`).join(' ')}`],
        { detached: true, stdio: ['ignore', bootstrapFd, bootstrapFd], cwd: launch.cwd, env: launch.env },
      )
    : spawn(launch.runtime, launch.args, {
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
    // On macOS, downloaded SEA binaries get SIGKILL'd by CSM 2 when
    // fork()+execve()'d due to com.apple.provenance. Signal the caller
    // to fall back to in-process daemon.
    if (
      process.platform === 'darwin' &&
      err instanceof Error &&
      err.message.includes('SIGKILL')
    ) {
      throw new MacOSCodeSignatureError(bootstrapLogPath);
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
