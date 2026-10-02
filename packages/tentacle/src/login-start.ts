/** Helpers for `kraki start --login` (Windows login autostart). */

import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { uptime } from 'node:os';
import { clearDaemonPid, clearDaemonReady, clearDaemonIdentity, getDaemonPidPath, getLogsDir } from './config.js';

/** True if daemon.pid was written before the machine last booted. */
export function pidFileIsFromBeforeBoot(pidPath = getDaemonPidPath(), now = Date.now(), upSeconds = uptime()): boolean {
  let mtime: number;
  try { mtime = statSync(pidPath).mtimeMs; } catch { return false; }
  const bootedAt = now - upSeconds * 1000;
  return mtime < bootedAt;
}

export function clearPidFromBeforeBoot(): boolean {
  if (!pidFileIsFromBeforeBoot()) return false;
  clearDaemonPid();
  clearDaemonReady();
  clearDaemonIdentity();
  return true;
}

/** Login starts are silent; leave a trace of what happened. */
export function appendLoginLog(msg: string): void {
  try {
    const dir = getLogsDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'login-start.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* best effort */ }
}
