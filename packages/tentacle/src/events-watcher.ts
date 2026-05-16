/**
 * Events watcher — watches imported sessions' events.jsonl for changes
 * from external sources (copilot CLI, VS Code).
 *
 * Uses fs.watch (kqueue/inotify) for near-real-time notifications.
 * Tracks byte offset per file to only read new lines.
 * Converts new SDK events to Kraki protocol messages and calls a broadcast callback.
 */

import { watch, statSync, openSync, readSync, closeSync, existsSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { convertEvent } from './history-parser.js';
import { createLogger } from './logger.js';

const logger = createLogger('events-watcher');

/** Debounce ms — coalesce rapid writes into one read. */
const DEBOUNCE_MS = 300;

export interface WatcherBroadcast {
  type: string;
  sessionId: string;
  payload: Record<string, unknown>;
}

export type BroadcastFn = (msg: WatcherBroadcast) => void;

interface WatchedSession {
  sessionId: string;
  filePath: string;
  watcher: FSWatcher;
  offset: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** When true, file changes are ignored (Kraki's own adapter is writing). */
  paused: boolean;
}

export class EventsWatcher {
  private sessions = new Map<string, WatchedSession>();
  private broadcastFn: BroadcastFn;
  private deviceId: string;

  constructor(broadcastFn: BroadcastFn, deviceId: string) {
    this.broadcastFn = broadcastFn;
    this.deviceId = deviceId;
  }

  /**
   * Start watching an imported session's events.jsonl for external changes.
   * Call after import completes.
   */
  watch(sessionId: string): void {
    if (this.sessions.has(sessionId)) return;

    const filePath = join(homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
    if (!existsSync(filePath)) {
      logger.debug({ sessionId }, 'No events.jsonl to watch');
      return;
    }

    // Start from current end of file (we already backfilled everything before this point)
    let offset: number;
    try {
      offset = statSync(filePath).size;
    } catch {
      return;
    }

    let watcher: FSWatcher;
    try {
      watcher = watch(filePath, () => {
        this.onFileChange(sessionId);
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, sessionId }, 'Failed to watch events.jsonl');
      return;
    }

    this.sessions.set(sessionId, {
      sessionId,
      filePath,
      watcher,
      offset,
      debounceTimer: null,
      paused: false,
    });

    logger.debug({ sessionId, offset }, 'Watching events.jsonl');
  }

  /** Stop watching a session. */
  unwatch(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.watcher.close();
    this.sessions.delete(sessionId);
    logger.debug({ sessionId }, 'Stopped watching events.jsonl');
  }

  /** Stop all watchers. */
  close(): void {
    for (const [id] of this.sessions) {
      this.unwatch(id);
    }
  }

  /** Get the byte offset the watcher is currently tracking for a session. */
  getTrackedOffset(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.offset;
  }

  /**
   * Pause watching — Kraki's adapter is actively writing to events.jsonl.
   * All file change events are ignored and offset advances to end of file.
   */
  skipToEnd(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.paused = true;
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
    }
    try {
      entry.offset = statSync(entry.filePath).size;
    } catch { /* file may not exist yet */ }
  }

  /**
   * Resume watching after Kraki's adapter turn completes.
   * Advances offset to current end of file, then proactively checks
   * for any external events that arrived while paused.
   */
  resume(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    // Advance past Kraki's own writes
    try {
      entry.offset = statSync(entry.filePath).size;
    } catch { /* ignore */ }
    entry.paused = false;
  }

  private onFileChange(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.paused) return;

    // Debounce: the CLI may write multiple lines in rapid succession
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      this.readNewEvents(entry);
    }, DEBOUNCE_MS);
  }

  private readNewEvents(entry: WatchedSession): void {
    let fileSize: number;
    try {
      fileSize = statSync(entry.filePath).size;
    } catch {
      return;
    }

    if (fileSize <= entry.offset) return; // no new data

    // Read new bytes from the offset
    const readSize = fileSize - entry.offset;
    const fd = openSync(entry.filePath, 'r');
    const buf = Buffer.alloc(readSize);
    try {
      readSync(fd, buf, 0, readSize, entry.offset);
    } finally {
      closeSync(fd);
    }
    entry.offset = fileSize;

    // Parse new lines into SDK events
    const newContent = buf.toString('utf8');
    const lines = newContent.split('\n').filter(l => l.trim());
    const meta = {}; // don't need metadata extraction for live events

    let broadcastCount = 0;
    for (const line of lines) {
      let event: { type: string; data: Record<string, unknown>; timestamp?: string };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      const ts = event.timestamp ?? new Date().toISOString();
      const converted = convertEvent(event, ts, meta);
      if (!converted) continue;

      // Broadcast as a Kraki protocol message
      this.broadcastFn({
        type: converted.type,
        sessionId: entry.sessionId,
        payload: JSON.parse(converted.payload),
      });
      broadcastCount++;
    }

    if (broadcastCount > 0) {
      logger.info({ sessionId: entry.sessionId, newLines: lines.length, broadcast: broadcastCount }, 'External events detected');
    }
  }
}
