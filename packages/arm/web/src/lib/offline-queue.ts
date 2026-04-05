/**
 * Offline message queue for arm/web.
 *
 * Holds consumer messages destined for offline tentacles and drains them
 * when the target device reconnects. Only safe, idempotent message types
 * are eligible — see QUEUEABLE_TYPES.
 *
 * Messages are deduped by (sessionId, type) so repeated mode changes or
 * read markers collapse to the latest value. Entries older than MAX_AGE_MS
 * are dropped on drain.
 */

import { createLogger } from './logger';

const logger = createLogger('offline-queue');

const STORAGE_KEY = 'kraki-offline-queue';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Message types eligible for offline queuing. */
const QUEUEABLE_TYPES = new Set([
  'mark_read',
  'set_session_mode',
  'delete_session',
]);

export interface QueuedMessage {
  msg: Record<string, unknown>;
  targetDeviceId: string;
  addedAt: string;
}

/** Dedup key: (sessionId, type) — latest entry wins. */
function dedupKey(msg: Record<string, unknown>): string {
  return `${msg.sessionId}:${msg.type}`;
}

export class OfflineQueue {
  private queue: QueuedMessage[] = [];

  constructor() {
    this.load();
  }

  /** Check if a message type is eligible for offline queuing. */
  static isQueueable(type: string): boolean {
    return QUEUEABLE_TYPES.has(type);
  }

  /**
   * Enqueue a message for an offline device.
   * Deduplicates by (sessionId, type) — replaces any existing entry.
   * When enqueuing a delete_session, removes other queued messages for that session.
   */
  enqueue(msg: Record<string, unknown>, targetDeviceId: string): void {
    const type = msg.type as string;
    if (!OfflineQueue.isQueueable(type)) {
      logger.error('Attempted to queue non-queueable message type', { type });
      return;
    }

    const sessionId = msg.sessionId as string | undefined;

    // delete_session supersedes any other queued messages for this session
    if (type === 'delete_session' && sessionId) {
      this.queue = this.queue.filter(
        (q) => (q.msg.sessionId as string | undefined) !== sessionId,
      );
    }

    // Dedup: remove existing entry with same key
    const key = dedupKey(msg);
    this.queue = this.queue.filter((q) => dedupKey(q.msg) !== key);

    this.queue.push({ msg, targetDeviceId, addedAt: new Date().toISOString() });
    this.save();

    logger.info('enqueued', { type, sessionId, targetDeviceId, queueSize: this.queue.length });
  }

  /**
   * Drain all queued messages for a specific device.
   * Drops expired entries. Returns messages to send.
   */
  drain(targetDeviceId: string): Record<string, unknown>[] {
    const now = Date.now();
    const toSend: Record<string, unknown>[] = [];
    const remaining: QueuedMessage[] = [];

    for (const entry of this.queue) {
      if (entry.targetDeviceId !== targetDeviceId) {
        remaining.push(entry);
        continue;
      }

      const age = now - new Date(entry.addedAt).getTime();
      if (age > MAX_AGE_MS) {
        logger.info('dropping expired entry', {
          type: entry.msg.type,
          sessionId: entry.msg.sessionId,
          ageHours: Math.round(age / 3600000),
        });
        continue;
      }

      // Inject targetDeviceId so encryption layer can route correctly
      // (the session may have been removed from the store)
      const msg = { ...entry.msg };
      if (!msg.payload || typeof msg.payload !== 'object') {
        msg.payload = {};
      }
      (msg.payload as Record<string, unknown>).targetDeviceId = targetDeviceId;

      toSend.push(msg);
    }

    this.queue = remaining;
    this.save();

    if (toSend.length > 0) {
      logger.info('drained', { targetDeviceId, count: toSend.length, remaining: remaining.length });
    }

    return toSend;
  }

  /** Number of queued messages. */
  get size(): number {
    return this.queue.length;
  }

  /** Clear all queued messages (used on logout/reset). */
  clear(): void {
    this.queue = [];
    this.save();
  }

  // ── Persistence ──────────────────────────────────────

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.queue));
    } catch {
      // localStorage full or unavailable — queue is in-memory only
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        this.queue = JSON.parse(raw);
      }
    } catch {
      this.queue = [];
    }
  }
}
