/**
 * Message Provider — unified interface for loading session messages.
 *
 * All message loading goes through this layer:
 * - requestLatest(sessionId, count): load latest N messages (called from session_list)
 * - requestBefore(sessionId, beforeSeq): load 100 older messages (called from GapMarker)
 *
 * Both check IndexedDB first, then fall back to tentacle.
 */

import { getStore } from './store-adapter';
import { createLogger } from './logger';

const logger = createLogger('msg-provider');

const PAGE_SIZE = 100;
const LATEST_SIZE = 50;

class MessageProvider {
  /** In-flight requests keyed by `${sessionId}:${afterSeq}` */
  private loading = new Set<string>();
  /** tentacle lastSeq per session (from session_list) */
  private tentacleLastSeq = new Map<string, number>();
  /** sessionId → tentacleDeviceId */
  private tentacleDeviceMap = new Map<string, string>();
  /** send function injected from ws-client */
  private sendFn: ((msg: Record<string, unknown>) => void) | null = null;

  /** Set the encrypted send function (called by ws-client on init). */
  setSend(fn: (msg: Record<string, unknown>) => void): void {
    this.sendFn = fn;
  }

  /** Update tentacle metadata from session_list. */
  setTentacleInfo(sessionId: string, lastSeq: number, deviceId: string): void {
    this.tentacleLastSeq.set(sessionId, lastSeq);
    this.tentacleDeviceMap.set(sessionId, deviceId);
  }

  /** Check if any request is in flight for a session. */
  isLoading(sessionId: string): boolean {
    for (const key of this.loading) {
      if (key.startsWith(`${sessionId}:`)) return true;
    }
    return false;
  }

  /** Check if any session has in-flight initial load. */
  get hasActiveLoads(): boolean {
    return this.loading.size > 0;
  }

  /**
   * Load latest N messages for a session.
   * Called for every session after session_list arrives.
   */
  async requestLatest(sessionId: string): Promise<void> {
    if (this.isLoading(sessionId)) {
      logger.info('requestLatest skipped (loading)', { sessionId, loadingKeys: [...this.loading] });
      return;
    }

    const totalLastSeq = this.tentacleLastSeq.get(sessionId) ?? 0;
    if (totalLastSeq === 0) return;

    logger.info('requestLatest', { sessionId, totalLastSeq });

    // Check IndexedDB first
    let dbLastSeq = 0;
    try {
      const db = await import('./message-db');
      const lastSeq = await db.getLastSeq(sessionId, totalLastSeq);
      dbLastSeq = lastSeq;

      if (lastSeq > 0) {
        // Load latest LATEST_SIZE from DB into store
        const allMsgs = await db.getMessages(sessionId);
        const latestFromDb = allMsgs.slice(-LATEST_SIZE);
        if (latestFromDb.length > 0) {
          getStore().prependMessages(sessionId, latestFromDb);
          logger.info('loaded from IndexedDB', { sessionId, count: latestFromDb.length, dbLastSeq: lastSeq });
        }
      }
    } catch {
      // IndexedDB unavailable
    }

    // If tentacle has newer messages, request the gap
    if (dbLastSeq < totalLastSeq) {
      const afterSeq = Math.max(dbLastSeq, totalLastSeq - LATEST_SIZE);
      if (afterSeq < totalLastSeq) {
        this.requestFromTentacle(sessionId, afterSeq);
      }
    }
  }

  /**
   * Load 100 older messages before a given seq.
   * Called when a GapMarker scrolls into view.
   */
  async requestBefore(sessionId: string, beforeSeq: number): Promise<void> {
    if (this.isLoading(sessionId)) {
      logger.info('requestBefore skipped (loading)', { sessionId, beforeSeq, loadingKeys: [...this.loading] });
      return;
    }

    const loadKey = `${sessionId}:${beforeSeq}`;
    this.loading.add(loadKey);
    logger.info('requestBefore start', { sessionId, beforeSeq, loadKey });

    // Check IndexedDB: take up to 100 messages immediately before beforeSeq
    try {
      const db = await import('./message-db');
      const allMsgs = await db.getMessages(sessionId);
      const older = allMsgs
        .filter(m => {
          const seq = 'seq' in m ? (m as { seq?: number }).seq : undefined;
          return typeof seq === 'number' && seq > 0 && seq < beforeSeq;
        })
        .slice(-PAGE_SIZE);
      if (older.length > 0) {
        // Check if these messages are actually new (not already in store)
        const storeMessages = getStore().messages.get(sessionId) ?? [];
        const storeSeqs = new Set<number>();
        for (const m of storeMessages) {
          const s = 'seq' in m ? (m as { seq?: number }).seq : undefined;
          if (typeof s === 'number') storeSeqs.add(s);
        }
        const newMessages = older.filter(m => {
          const s = 'seq' in m ? (m as { seq?: number }).seq : undefined;
          return typeof s === 'number' && !storeSeqs.has(s);
        });
        if (newMessages.length > 0) {
          getStore().prependMessages(sessionId, older);
          logger.info('gap filled from IndexedDB', { sessionId, beforeSeq, count: older.length, newCount: newMessages.length });
          this.loading.delete(loadKey);
          return;
        }
        // All messages already in store — gap is real (not in IndexedDB), fall through to tentacle
        logger.info('IndexedDB messages already in store, falling through to tentacle', { sessionId, beforeSeq });
      }
    } catch {
      // IndexedDB unavailable
    }

    // Request from tentacle — keep loadKey active until batch arrives
    const tentacleDeviceId = this.tentacleDeviceMap.get(sessionId);
    if (!tentacleDeviceId || !this.sendFn) {
      this.loading.delete(loadKey);
      return;
    }

    const afterSeq = Math.max(0, beforeSeq - PAGE_SIZE - 1);
    const store = getStore();
    this.sendFn({
      type: 'request_session_replay',
      deviceId: store.deviceId ?? '',
      payload: { sessionId, afterSeq, limit: PAGE_SIZE, targetDeviceId: tentacleDeviceId },
    });

    logger.info('requested from tentacle', { sessionId, afterSeq, limit: PAGE_SIZE });

    // Safety timeout
    setTimeout(() => {
      this.loading.delete(loadKey);
    }, 10_000);
  }

  /**
   * Handle a replay batch from tentacle — insert into store + clear loading.
   */
  handleBatch(sessionId: string, messages: unknown[], _lastSeq: number, _totalLastSeq: number): void {
    logger.info('handleBatch received', { sessionId, count: messages?.length ?? 0 });

    if (messages && messages.length > 0) {
      getStore().prependMessages(sessionId, messages as Parameters<ReturnType<typeof getStore>['prependMessages']>[1]);
    }

    // Clear internal loading keys for this session
    for (const key of [...this.loading]) {
      if (key.startsWith(`${sessionId}:`)) {
        this.loading.delete(key);
      }
    }
    logger.info('handleBatch done', { sessionId });
  }

  /** Clear all tracking (on disconnect). */
  clear(): void {
    this.loading.clear();
    this.tentacleLastSeq.clear();
    this.tentacleDeviceMap.clear();
  }

  private requestFromTentacle(sessionId: string, afterSeq: number, limit?: number): void {
    const tentacleDeviceId = this.tentacleDeviceMap.get(sessionId);
    if (!tentacleDeviceId || !this.sendFn) {
      logger.warn('cannot request from tentacle', { sessionId, hasSend: !!this.sendFn, hasDevice: !!tentacleDeviceId });
      return;
    }

    // Track in internal loading set (for isLoading check).
    const loadKey = `${sessionId}:${afterSeq}`;
    this.loading.add(loadKey);

    const store = getStore();
    this.sendFn({
      type: 'request_session_replay',
      deviceId: store.deviceId ?? '',
      payload: { sessionId, afterSeq, ...(limit ? { limit } : {}), targetDeviceId: tentacleDeviceId },
    });

    logger.info('requested from tentacle', { sessionId, afterSeq, limit });

    // Safety timeout
    setTimeout(() => {
      this.loading.delete(loadKey);
    }, 10_000);
  }
}

export const messageProvider = new MessageProvider();
