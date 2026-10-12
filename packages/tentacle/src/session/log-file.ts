/** Reading a session's messages.jsonl: last seq, streaming lines, legacy rows. */

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import type { LoggedMessage } from './types.js';

/**
 * Spine rows store the full ProducerMessage envelope as `payload`. Sessions
 * imported before that was enforced stored only the inner payload
 * (`{"content": ...}`), which readers could not route. Wrap such rows into the
 * envelope shape on read.
 */
/** Seq of the last complete row of a messages.jsonl (0 if none). Reads
 *  backwards in chunks: rows with inline images can exceed a megabyte. */
export function lastLoggedSeq(logPath: string): number {
  if (!existsSync(logPath)) return 0;
  let fd: number | undefined;
  try {
    fd = openSync(logPath, 'r');
    const size = fstatSync(fd).size;
    const chunk = 256 * 1024;
    let end = size;
    let tail = Buffer.alloc(0);
    while (end > 0 && tail.length < 32 * 1024 * 1024) {
      const start = Math.max(0, end - chunk);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      tail = Buffer.concat([buf, tail]);
      end = start;
      const lines = tail.toString('utf8').split('\n');
      // Skip a trailing partial line (crash mid-write); the last complete row
      // is the last line followed by a newline that also has a full start.
      for (let i = lines.length - 2; i >= (end > 0 ? 1 : 0); i--) {
        if (!lines[i]) continue;
        try {
          const seq = (JSON.parse(lines[i]) as { seq?: unknown }).seq;
          if (typeof seq === 'number') return seq;
        } catch { /* corrupt row: keep looking */ }
      }
    }
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return 0;
}

export interface LogIndex {
  ino: number;
  /** Bytes of the file covered (always ends after a newline). */
  size: number;
  seqs: number[];
  offsets: number[];
  /** Seqs strictly increase in file order (binary search is valid). */
  ascending: boolean;
}

/**
 * Stream complete lines of `path` in [start, end) without reading the whole
 * file. `visit` gets each line and its byte offset; returning false stops.
 * Returns the offset just past the last complete line visited.
 */
export function forEachLogLine(
  path: string,
  start: number,
  end: number,
  visit: (line: string, offset: number) => boolean,
): number {
  let fd: number | undefined;
  let consumed = start;
  try {
    fd = openSync(path, 'r');
    const chunkSize = 1024 * 1024;
    let carry = Buffer.alloc(0);
    let carryOffset = start;
    let pos = start;
    while (pos < end) {
      const buf = Buffer.alloc(Math.min(chunkSize, end - pos));
      const read = readSync(fd, buf, 0, buf.length, pos);
      if (read <= 0) break;
      pos += read;
      let data = carry.length ? Buffer.concat([carry, buf.subarray(0, read)]) : buf.subarray(0, read);
      let lineStart = 0;
      for (let nl = data.indexOf(0x0a); nl !== -1; nl = data.indexOf(0x0a, lineStart)) {
        const lineOffset = carryOffset + lineStart;
        if (nl > lineStart && !visit(data.subarray(lineStart, nl).toString('utf8'), lineOffset)) {
          return lineOffset + (nl - lineStart) + 1;
        }
        lineStart = nl + 1;
        consumed = carryOffset + lineStart;
      }
      carry = Buffer.from(data.subarray(lineStart));
      carryOffset += lineStart;
      data = Buffer.alloc(0);
    }
  } catch {
    return consumed;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return consumed;
}

export function upgradeLegacyEntry(entry: LoggedMessage, sessionId: string): LoggedMessage {
  try {
    const parsed = JSON.parse(entry.payload) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') return entry;
    return {
      ...entry,
      payload: JSON.stringify({ type: entry.type, sessionId, timestamp: entry.ts, payload: parsed }),
    };
  } catch {
    return entry;
  }
}
