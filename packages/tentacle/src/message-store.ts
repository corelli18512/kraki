/**
 * Tentacle message buffer — append-only JSONL file with in-memory index.
 *
 * Zero external dependencies. Buffers outgoing messages so tentacle can
 * replay them to reconnecting apps. Each line is a self-contained JSON object:
 *   {"seq":1,"sessionId":"...","type":"agent_message","payload":{...},"ts":"..."}
 *
 * The in-memory index maps seq → file offset for fast getAfterSeq lookups.
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface BufferedMessage {
  seq: number;
  sessionId?: string;
  type: string;
  payload: string;
  ts: string;
}

interface IndexEntry {
  seq: number;
  offset: number;
  length: number;
}

export class MessageStore {
  private filePath: string;
  private index: IndexEntry[] = [];
  private fileSize = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.rebuildIndex();
  }

  /**
   * Append a message to the buffer.
   */
  append(seq: number, sessionId: string | undefined, type: string, payload: string): void {
    const entry: BufferedMessage = {
      seq,
      sessionId,
      type,
      payload,
      ts: new Date().toISOString(),
    };
    const line = JSON.stringify(entry) + '\n';
    const lineBytes = Buffer.byteLength(line, 'utf8');

    this.index.push({ seq, offset: this.fileSize, length: lineBytes });
    this.fileSize += lineBytes;
    appendFileSync(this.filePath, line, 'utf8');
  }

  /**
   * Get all messages with seq > afterSeq, optionally limited.
   */
  getAfterSeq(afterSeq: number, limit?: number): BufferedMessage[] {
    // Binary search for the first index entry with seq > afterSeq
    let lo = 0;
    let hi = this.index.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.index[mid].seq <= afterSeq) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    if (lo >= this.index.length) return [];

    const entries = limit ? this.index.slice(lo, lo + limit) : this.index.slice(lo);
    if (entries.length === 0) return [];

    // Read the file region spanning all needed entries
    const firstEntry = entries[0];
    const lastEntry = entries[entries.length - 1];
    const regionStart = firstEntry.offset;
    const regionEnd = lastEntry.offset + lastEntry.length;

    let regionBuf: Buffer;
    try {
      regionBuf = Buffer.alloc(regionEnd - regionStart);
      const fd = openSync(this.filePath, 'r');
      try {
        readSync(fd, regionBuf, 0, regionBuf.length, regionStart);
      } finally {
        closeSync(fd);
      }
    } catch {
      return [];
    }

    const messages: BufferedMessage[] = [];
    for (const entry of entries) {
      const localOffset = entry.offset - regionStart;
      const lineBuf = regionBuf.subarray(localOffset, localOffset + entry.length);
      const line = lineBuf.toString('utf8').trimEnd();
      try {
        messages.push(JSON.parse(line));
      } catch {
        // Skip corrupted lines
      }
    }

    return messages;
  }

  /**
   * Get the highest seq in the buffer, or 0 if empty.
   */
  getLastSeq(): number {
    if (this.index.length === 0) return 0;
    return this.index[this.index.length - 1].seq;
  }

  /**
   * Get total message count in the buffer.
   */
  count(): number {
    return this.index.length;
  }

  /**
   * Prune messages from the buffer.
   *
   * @param options.maxAge  - Remove messages older than this many milliseconds
   * @param options.maxCount - Keep at most this many messages (newest)
   * @param options.sessionId - Remove only messages for this session
   */
  prune(options: { maxAge?: number; maxCount?: number; sessionId?: string } = {}): number {
    if (this.index.length === 0) return 0;

    const allMessages = this.readAllMessages();
    const now = Date.now();

    const kept = allMessages.filter((msg) => {
      if (options.sessionId != null) {
        // Session-scoped prune: remove only messages matching this session
        return msg.sessionId !== options.sessionId;
      }
      if (options.maxAge != null && (now - new Date(msg.ts).getTime()) >= options.maxAge) return false;
      return true;
    });

    // Apply maxCount (keep newest) — only if no sessionId filter
    let final = kept;
    if (options.maxCount && !options.sessionId && final.length > options.maxCount) {
      final = final.slice(final.length - options.maxCount);
    }

    const pruned = allMessages.length - final.length;
    if (pruned > 0) {
      this.rewriteFile(final);
    }
    return pruned;
  }

  /**
   * Delete all messages for a specific session.
   */
  deleteSession(sessionId: string): number {
    return this.prune({ sessionId });
  }

  // ── Internal ───────────────────────────────────────────

  private rebuildIndex(): void {
    this.index = [];
    this.fileSize = 0;

    if (!existsSync(this.filePath)) return;

    let content: string;
    try {
      content = readFileSync(this.filePath, 'utf8');
    } catch {
      return;
    }

    if (!content) return;

    this.fileSize = Buffer.byteLength(content, 'utf8');

    let offset = 0;
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line) {
        // Account for empty trailing newlines
        offset += 1;
        continue;
      }
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for newline
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.seq === 'number') {
          this.index.push({ seq: parsed.seq, offset, length: lineBytes });
        }
      } catch {
        // Skip corrupted lines
      }
      offset += lineBytes;
    }
  }

  private readAllMessages(): BufferedMessage[] {
    if (!existsSync(this.filePath)) return [];
    let content: string;
    try {
      content = readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }

    const messages: BufferedMessage[] = [];
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        // Skip corrupted lines
      }
    }
    return messages;
  }

  private rewriteFile(messages: BufferedMessage[]): void {
    const content = messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length > 0 ? '\n' : '');
    const tmp = this.filePath + '.tmp';
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, this.filePath);
    this.rebuildIndex();
  }
}
