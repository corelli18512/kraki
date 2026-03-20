/**
 * Daemon process management for Kraki tentacle.
 *
 * The daemon runs as a detached child process executing daemon-worker.js.
 * Its PID is tracked in ~/.kraki/daemon.pid.
 */

import { spawn, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type KrakiConfig,
  saveDaemonPid,
  loadDaemonPid,
  clearDaemonPid,
} from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

export function startDaemon(_config: KrakiConfig): number {
  // Kill any existing daemon(s) before starting a new one
  stopDaemon();
  // Detect if running from source (.ts) or built (.js)
  const currentUrl = import.meta.url;
  const isTsSource = currentUrl.endsWith('.ts');
  const workerFile = isTsSource ? 'daemon-worker.ts' : 'daemon-worker.js';
  const workerPath = join(__dirname, workerFile);

  let runtime: string;
  let args: string[];
  if (isTsSource) {
    // In dev: use node with --import tsx for ESM TypeScript support
    runtime = process.execPath; // full path to node
    args = ['--import', 'tsx', workerPath];
  } else {
    runtime = process.execPath;
    args = [workerPath];
  }

  // Ensure node_modules/.bin is in PATH for tsx resolution
  const projectRoot = join(__dirname, '..', '..');
  const binPath = join(projectRoot, 'node_modules', '.bin');
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    NODE_PATH: join(projectRoot, 'node_modules'),
    PATH: `${binPath}:${process.env.PATH ?? ''}`,
  };

  const child = spawn(runtime, args, {
    detached: true,
    stdio: 'ignore',
    cwd: projectRoot,
    env,
  });

  child.unref();

  const pid = child.pid!;
  saveDaemonPid(pid);
  return pid;
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
