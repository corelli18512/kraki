/**
 * Daemon run record — `<KRAKI_HOME>/daemon-run.json`.
 *
 * One record per worker run: written at start, refreshed every minute while
 * the worker runs, closed with the exit reason on a graceful shutdown. The next
 * start reads it, so a run that ended without closing its record (SIGKILL,
 * power loss, panic, a signal before the handlers existed) is reported as an
 * unclean exit with the last time it was seen alive. Before this record the
 * 2026-10-20 01:22 death of a daemon left no trace in any log (log audit
 * 2026-10-22).
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { getConfigDir, getKrakiHome } from './config.js';

export interface DaemonRunRecord {
  pid: number;
  version: string;
  startedAt: string;
  /** Last heartbeat of the run (refreshed every minute). */
  lastSeenAt: string;
  /** Set by a graceful shutdown; absent means the run is live or died. */
  endedAt?: string;
  exitReason?: string;
  /** Full Disk Access as last observed by the run (macOS). */
  fda?: 'granted' | 'denied' | 'missing';
}

export interface RunStart {
  previous: DaemonRunRecord | null;
  /** The previous run never closed its record. */
  previousUnclean: boolean;
  /** Why this worker is starting, as far as the record can tell. */
  startReason: 'first-run' | 'after-unclean-exit' | 'after-update' | 'after-clean-exit';
  /** The machine booted after the previous run was last seen. */
  bootedSincePrevious: boolean;
}

export const RUN_HEARTBEAT_MS = 60_000;

function recordPath(): string {
  return join(getKrakiHome(), 'daemon-run.json');
}

let current: DaemonRunRecord | null = null;

function write(record: DaemonRunRecord): void {
  try {
    getConfigDir();
    const path = recordPath();
    writeFileSync(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  } catch { /* best effort: diagnostics only */ }
}

export function readRunRecord(): DaemonRunRecord | null {
  try {
    const raw = JSON.parse(readFileSync(recordPath(), 'utf8')) as Partial<DaemonRunRecord>;
    if (typeof raw.pid !== 'number' || typeof raw.startedAt !== 'string') return null;
    return raw as DaemonRunRecord;
  } catch {
    return null;
  }
}

/** Read the previous run's record and open this run's. */
export function beginRun(version: string, now = Date.now()): RunStart {
  const previous = readRunRecord();
  const previousUnclean = previous !== null && !previous.endedAt;
  const lastSeen = previous ? Date.parse(previous.endedAt ?? previous.lastSeenAt) : NaN;
  const bootedAt = now - uptime() * 1000;
  const startReason: RunStart['startReason'] = !previous ? 'first-run'
    : previousUnclean ? 'after-unclean-exit'
      : previous.version !== version ? 'after-update'
        : 'after-clean-exit';
  const iso = new Date(now).toISOString();
  current = { pid: process.pid, version, startedAt: iso, lastSeenAt: iso, ...(previous?.fda && { fda: previous.fda }) };
  write(current);
  return { previous, previousUnclean, startReason, bootedSincePrevious: Number.isFinite(lastSeen) && bootedAt > lastSeen };
}

/** Heartbeat: the run is alive now. */
export function touchRun(now = Date.now()): void {
  if (!current || current.endedAt) return;
  current = { ...current, lastSeenAt: new Date(now).toISOString() };
  write(current);
}

export function noteRunFda(fda: NonNullable<DaemonRunRecord['fda']>): void {
  if (!current || current.endedAt || current.fda === fda) return;
  current = { ...current, fda };
  write(current);
}

/** Close the record: this run ended gracefully for `reason`. */
export function endRun(reason: string, now = Date.now()): void {
  if (!current || current.endedAt) return;
  const iso = new Date(now).toISOString();
  current = { ...current, lastSeenAt: iso, endedAt: iso, exitReason: reason };
  write(current);
}
