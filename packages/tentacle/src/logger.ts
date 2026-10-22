/**
 * Structured logging for Kraki tentacle.
 *
 * - Development: pretty-prints to stdout
 * - Production: writes to log files under the current Kraki home
 *
 * Normal verbosity rotates every file — at 10 MB, or once its oldest entry is
 * a week old — and keeps 5 archives named `<name>.log.1` … `.5`, on every
 * install method. Verbose (`kraki config log verbose`, i.e. LOG_LEVEL=debug)
 * is the developer mode and keeps one growing file per logger, unrotated.
 *
 * Before the age limit a quiet log (daemon.log) was never rotated and kept six
 * months of history, and npm installs rotated through pino-roll into a second
 * naming scheme (`<name>.N.log`); log audit 2026-10-22.
 */

import pino from 'pino';
import { closeSync, existsSync, openSync, readSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getLogsDir } from './config.js';

export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
export const LOG_ROTATE_KEEP = 5;
export const LOG_ROTATE_MAX_AGE_MS = 7 * 24 * 3600_000;
const ROTATE_CHECK_MS = 60_000;

/** Time of the file's first entry (pino's epoch-ms `time`), else its birth
 *  time when the platform records one. */
function oldestEntryMs(file: string, birthtimeMs: number): number | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.subarray(0, n).toString('utf8').split('\n', 1)[0];
    const time = (JSON.parse(firstLine) as { time?: unknown }).time;
    if (typeof time === 'number' && Number.isFinite(time)) return time;
  } catch { /* not a pino line: fall back to the birth time */ } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return birthtimeMs > 0 ? birthtimeMs : null;
}

/** Shift `file` → `file.1` → … → `file.<keep>` when it exceeds `maxBytes` or
 *  its oldest entry is older than `maxAgeMs`. Returns true when a rotation
 *  happened. Exported for tests. */
export function rotateLogFile(
  file: string,
  maxBytes = LOG_ROTATE_BYTES,
  keep = LOG_ROTATE_KEEP,
  maxAgeMs = LOG_ROTATE_MAX_AGE_MS,
  now = Date.now(),
): boolean {
  let size = 0;
  let birthtimeMs = 0;
  try { ({ size, birthtimeMs } = statSync(file)); } catch { return false; }
  if (size === 0) return false;
  if (size < maxBytes) {
    const oldest = oldestEntryMs(file, birthtimeMs);
    if (oldest === null || now - oldest < maxAgeMs) return false;
  }
  try { unlinkSync(`${file}.${keep}`); } catch { /* none yet */ }
  for (let i = keep - 1; i >= 1; i--) {
    if (existsSync(`${file}.${i}`)) {
      try { renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* best effort */ }
    }
  }
  try { renameSync(file, `${file}.1`); } catch { return false; }
  return true;
}

export interface LoggerOptions {
  /** Write each line synchronously: for low-volume lifecycle logs whose last
   *  lines must survive a hard exit. */
  sync?: boolean;
}

export function createLogger(name: string, options: LoggerOptions = {}): pino.Logger {
  const level = process.env.LOG_LEVEL ?? 'info';
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    return pino({ name, level });
  }

  const logDir = getLogsDir();
  const file = join(logDir, `${name}.log`);
  const verbose = level === 'debug' || level === 'trace';

  // Written directly (single-executable builds cannot load a transport
  // worker anyway); normal mode rotates by hand, verbose mode never.
  if (!verbose) rotateLogFile(file);
  const destination = pino.destination({ dest: file, mkdir: true, sync: options.sync === true });
  if (!verbose) {
    const timer = setInterval(() => {
      if (rotateLogFile(file)) destination.reopen();
    }, ROTATE_CHECK_MS);
    timer.unref();
  }
  return pino({ name, level }, destination);
}
