/**
 * Structured logging for Kraki tentacle.
 *
 * - Development: pretty-prints to stdout
 * - Production: writes to log files under the current Kraki home
 *
 * Normal verbosity rotates every file (10 MB × 5 kept), on every install
 * method. Verbose (`kraki config log verbose`, i.e. LOG_LEVEL=debug) is the
 * developer mode and keeps one growing file per logger, unrotated.
 */

import pino from 'pino';
import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isSea } from 'node:sea';
import { getLogsDir } from './config.js';

export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
export const LOG_ROTATE_KEEP = 5;
const ROTATE_CHECK_MS = 60_000;

/** Shift `file` → `file.1` → … → `file.<keep>` when it exceeds `maxBytes`.
 *  Returns true when a rotation happened. Exported for tests. */
export function rotateLogFile(file: string, maxBytes = LOG_ROTATE_BYTES, keep = LOG_ROTATE_KEEP): boolean {
  let size = 0;
  try { size = statSync(file).size; } catch { return false; }
  if (size < maxBytes) return false;
  try { unlinkSync(`${file}.${keep}`); } catch { /* none yet */ }
  for (let i = keep - 1; i >= 1; i--) {
    if (existsSync(`${file}.${i}`)) {
      try { renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* best effort */ }
    }
  }
  try { renameSync(file, `${file}.1`); } catch { return false; }
  return true;
}

export function createLogger(name: string): pino.Logger {
  const level = process.env.LOG_LEVEL ?? 'info';
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    return pino({ name, level });
  }

  const logDir = getLogsDir();
  const file = join(logDir, `${name}.log`);
  const verbose = level === 'debug' || level === 'trace';

  if (!isSea() && !verbose) {
    // npm install: pino-roll rotates in a worker thread.
    const transport = pino.transport({
      target: 'pino-roll',
      options: { file, size: '10m', limit: { count: LOG_ROTATE_KEEP } },
    });
    return pino({ name, level }, transport);
  }

  // Single-executable builds cannot load pino-roll's worker, and verbose mode
  // must not rotate: write directly, rotating by hand in normal mode.
  if (!verbose) rotateLogFile(file);
  const destination = pino.destination({ dest: file, mkdir: true, sync: false });
  if (!verbose) {
    const timer = setInterval(() => {
      if (rotateLogFile(file)) destination.reopen();
    }, ROTATE_CHECK_MS);
    timer.unref();
  }
  return pino({ name, level }, destination);
}
