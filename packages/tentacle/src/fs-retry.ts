import { renameSync, writeFileSync } from 'node:fs';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * renameSync that retries briefly when the target is momentarily held open.
 * On Windows an antivirus scanner or indexer opening the file makes a
 * replace-by-rename fail with EPERM/EBUSY for a few milliseconds.
 */
export function renameWithRetry(from: string, to: string, rename: typeof renameSync = renameSync, attempts = 4): void {
  for (let i = 1; ; i++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (i >= attempts || !RETRYABLE.has(code)) throw err;
      sleep(25 * i);
    }
  }
}

/** Write via a temp file and rename, retrying a briefly locked target. */
export function atomicWriteFile(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameWithRetry(tmp, path);
}
