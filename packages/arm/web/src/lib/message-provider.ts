/**
 * Message Provider — transparent cache layer for session messages.
 *
 * fetchRange(sessionId, fromSeq, toSeq) plus observable retryable range status.
 * Checks IndexedDB first, falls back to tentacle for missing messages.
 * Callers don't know or care about the source.
 */

import { getStore } from './store-adapter';
import { createLogger } from './logger';
import { outbox } from './chat/outbox';
import { excludeInterval, missingIntervals } from './message-provider-range';
import type { ChatMessage } from '../types/store';

const logger = createLogger('msg-provider');

const BATCH_TIMEOUT_MS = 10_000;

// Rows written by older web clients before runtime/TRACE state was separated
// from the persistent conversation spine. They must never count toward cache
// range coverage, or a stale `active` row can hide a missing agent reply at the
// same session seq.
const NON_SPINE_CACHE_TYPES = new Set([
  'pending_input',
  'active',
  'compacting',
  'agent_message_delta',
  'card_action',
  'agent_narration',
  'tool_start',
  'tool_complete',
  'permission',
  'question',
  'answer',
  'permission_resolved',
  'question_resolved',
]);

export function isSpineMessage(message: ChatMessage): boolean { return isSpineCacheMessage(message); }

function isSpineCacheMessage(message: ChatMessage): boolean {
  const seq = 'seq' in message ? (message as { seq?: number }).seq : undefined;
  return typeof seq === 'number' && seq > 0 && Number.isInteger(seq) && !NON_SPINE_CACHE_TYPES.has(message.type);
}

export type RangeStatus =
  | { state: 'idle' | 'loading' | 'loaded' }
  | { state: 'incomplete'; remaining: Array<[number, number]> }
  | { state: 'error'; error: 'timeout' | 'unavailable' | 'no-progress' | 'page-limit' | 'failed' };
const IDLE: RangeStatus = { state: 'idle' };
interface RangeOperation { epoch: number; tail: boolean }
interface RangeBatch { messages: ChatMessage[]; truncated: boolean }
interface RetryRange { from: number; to: number; options?: { initial?: boolean; foreground?: boolean } }
interface PendingRequest {
  fromSeq: number;
  toSeq: number;
  retriedEmpty: boolean;
  send: () => void;
  resolve: (batch: RangeBatch) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}
class RangeFailure extends Error {
  constructor(readonly code: Extract<RangeStatus, { state: 'error' }>['error']) { super(code); }
}

class MessageProvider {
  /** tentacle lastSeq per session (from session_list) */
  private tentacleLastSeq = new Map<string, number>();
  /** sessionId → tentacleDeviceId */
  private tentacleDeviceMap = new Map<string, string>();
  /** send function injected from ws-client */
  private sendFn: ((msg: Record<string, unknown>) => void) | null = null;
  /** Pending tentacle range-fetch requests awaiting handleRangeBatch */
  private pendingRequests = new Map<string, PendingRequest>();
  /** The next empty answer after a timeout needs one confirmation. */
  private uncertainEmptySessions = new Set<string>();
  private epoch = 0;
  private operations = new Map<string, RangeOperation>();
  private rangeStatuses = new Map<string, RangeStatus>();
  /** Legacy seq holes confirmed by conclusive range responses; reset with authority. */
  private rangeTombstones = new Map<string, Array<[number, number]>>();
  private rangeListeners = new Set<() => void>();
  private retryRanges = new Map<string, RetryRange>();
  /** Older paging must not hide a failed newest-edge reconciliation. */
  private tailFailures = new Map<string, { status: RangeStatus; range: RetryRange }>();

  /** Stable snapshot for useSyncExternalStore; timeout is not authoritative empty. */
  getRangeStatus = (sessionId: string): RangeStatus => {
    const status = this.rangeStatuses.get(sessionId) ?? IDLE;
    if (status.state === 'loading' && this.operations.get(sessionId)?.tail) return status;
    return this.tailFailures.get(sessionId)?.status ?? status;
  };
  subscribeRangeStatus = (listener: () => void): (() => void) => {
    this.rangeListeners.add(listener);
    return () => { this.rangeListeners.delete(listener); };
  };
  private setRangeStatus(sessionId: string, status: RangeStatus): void {
    this.rangeStatuses.set(sessionId, status);
    for (const listener of this.rangeListeners) listener();
  }
  /** Explicit retry/continue only; no unattended history download. */
  retryRange(sessionId: string): void {
    const range = this.tailFailures.get(sessionId)?.range ?? this.retryRanges.get(sessionId);
    if (range) void this.fetchRange(sessionId, range.from, range.to, range.options);
  }
  private owns(sessionId: string, operation: RangeOperation): boolean {
    return operation.epoch === this.epoch && this.operations.get(sessionId) === operation;
  }
  /** Call before session deletion. Already-started store/DB writes need consumer cancellation too. */
  invalidateSession(sessionId: string): void {
    this.operations.delete(sessionId);
    const pending = this.pendingRequests.get(sessionId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(sessionId);
      pending.reject(new Error('invalidated'));
    }
    this.loadingSessions.delete(sessionId);
    this.loadingThroughSeq.delete(sessionId);
    this.loadingForeground.delete(sessionId);
    this.pendingTailReconciles.delete(sessionId);
    this.tentacleLastSeq.delete(sessionId);
    this.tentacleDeviceMap.delete(sessionId);
    this.retryRanges.delete(sessionId);
    this.rangeStatuses.delete(sessionId);
    this.rangeTombstones.delete(sessionId);
    this.tailFailures.delete(sessionId);
    this.uncertainEmptySessions.delete(sessionId);
    getStore().setSessionLoading(sessionId, false);
    for (const listener of this.rangeListeners) listener();
  }
  /** Sessions currently loading */
  private loadingSessions = new Set<string>();
  /** Highest seq covered by each in-flight fetch. */
  private loadingThroughSeq = new Map<string, number>();
  /** Fetches started by a foreground tail reconciliation. */
  private loadingForeground = new Set<string>();
  /** Latest tail reconciliation requested beyond an in-flight range. */
  private pendingTailReconciles = new Map<string, number>();
  /** Turn-trace pulls already completed or scheduled, keyed
   *  `${sessionId}:${bubbleSeq}`. */
  private tracePulled = new Set<string>();
  private traceLoaded = new Set<string>();
  private traceListeners = new Set<() => void>();

  /** A received trace (including an empty trace) is distinct from an outstanding pull. */
  isTurnTraceLoaded(sessionId: string, bubbleSeq: number): boolean {
    return this.traceLoaded.has(`${sessionId}:${bubbleSeq}`);
  }

  subscribeTurnTraces = (listener: () => void): (() => void) => {
    this.traceListeners.add(listener);
    return () => { this.traceListeners.delete(listener); };
  };

  /** Only one potentially-large trace response may be in flight globally.
   *  This prevents reconnect-time cross-bubble pulls from flooding Tentacle
   *  encryption and the Head WebSocket before stream 1 can apply backpressure. */
  private traceInFlight: string | null = null;
  private traceQueue: Array<{ sessionId: string; bubbleSeq: number }> = [];
  private traceQueued = new Set<string>();
  /** Invalidations that arrived while the same key was in flight collapse into
   *  one authoritative refresh after its response. */
  private traceRefresh = new Set<string>();
  private traceTimeout: ReturnType<typeof setTimeout> | null = null;
  private cardRequested = new Set<string>();

  setSend(fn: (msg: Record<string, unknown>) => void): void {
    this.sendFn = fn;
  }

  setTentacleInfo(sessionId: string, lastSeq: number, deviceId: string): void {
    const currentLastSeq = this.tentacleLastSeq.get(sessionId) ?? 0;
    this.tentacleLastSeq.set(sessionId, Math.max(currentLastSeq, lastSeq));
    this.tentacleDeviceMap.set(sessionId, deviceId);
  }

  /** Check if a session has an in-flight request. */
  isLoading(sessionId: string): boolean {
    return this.loadingSessions.has(sessionId);
  }

  /**
   * Ensure a session's latest messages are loaded — called when user opens a
   * session. Existing in-memory messages do not prove that the tail is complete:
   * a client can receive the closing idle while missing the agent message just
   * before it. Always reconcile the authoritative last-50 window from the
   * session digest (IDB first, then tentacle).
   */
  ensureLoaded(sessionId: string): void {
    const lastSeq = this.tentacleLastSeq.get(sessionId);
    if (!lastSeq || lastSeq <= 0) return;

    this.reconcileTail(sessionId, lastSeq);
  }

  /**
   * Reconcile the latest persistent spine window against an authoritative
   * session seq. Used both on session open and when a closing idle arrives.
   */
  reconcileTail(sessionId: string, lastSeq: number): void {
    if (lastSeq <= 0) return;

    const authoritativeLastSeq = Math.max(this.tentacleLastSeq.get(sessionId) ?? 0, lastSeq);
    this.tentacleLastSeq.set(sessionId, authoritativeLastSeq);

    if (this.loadingSessions.has(sessionId)) {
      const loadingThrough = this.loadingThroughSeq.get(sessionId) ?? 0;
      const loadingIsForeground = this.loadingForeground.has(sessionId);
      // A foreground tail reconciliation must not be swallowed by a background
      // warm-up that started first. Queue one authoritative recheck even when
      // both requests end at the same seq; the warm-up may have started before
      // the digest arrived or may complete without the missing rows. Once a
      // foreground reconciliation is already in flight, equal-or-older
      // notifications are redundant, while a newer authoritative tail still
      // needs a follow-up.
      if (!loadingIsForeground || authoritativeLastSeq > loadingThrough) {
        const pending = this.pendingTailReconciles.get(sessionId) ?? 0;
        this.pendingTailReconciles.set(sessionId, Math.max(pending, authoritativeLastSeq));
      }
      return;
    }

    const fromSeq = Math.max(1, authoritativeLastSeq - 49);
    logger.info('reconcileTail: checking authoritative tail', {
      sessionId,
      fromSeq,
      lastSeq: authoritativeLastSeq,
    });
    void this.fetchRange(sessionId, fromSeq, authoritativeLastSeq, { initial: true, foreground: true });
  }

  /**
   * Fetch messages in a seq range. Checks IDB first, falls back to tentacle.
   * Delivers cached rows and authoritative pages as coverage advances.
   * True means the requested range completed (including authoritative holes);
   * false must not advance an older paging cursor.
   */
  async fetchRange(sessionId: string, fromSeq: number, toSeq: number, options?: { initial?: boolean; foreground?: boolean }): Promise<boolean> {
    if (this.loadingSessions.has(sessionId)) {
      logger.info('fetchRange skipped (loading)', { sessionId, fromSeq, toSeq });
      return false;
    }

    const clampedFrom = Math.max(1, fromSeq);
    if (clampedFrom > toSeq) return false;

    logger.info('fetchRange', { sessionId, fromSeq: clampedFrom, toSeq, initial: options?.initial });

    const coversHead = options?.foreground || toSeq >= (this.tentacleLastSeq.get(sessionId) ?? Infinity);
    const operation: RangeOperation = { epoch: this.epoch, tail: coversHead };
    this.operations.set(sessionId, operation);
    this.retryRanges.set(sessionId, { from: clampedFrom, to: toSeq, options });
    this.loadingSessions.add(sessionId);
    this.loadingThroughSeq.set(sessionId, toSeq);
    if (options?.foreground) this.loadingForeground.add(sessionId);
    if (options?.initial) getStore().setSessionLoading(sessionId, true);
    this.setRangeStatus(sessionId, { state: 'loading' });

    try {
      const completed = await this.loadRange(sessionId, clampedFrom, toSeq, operation);
      if (!this.owns(sessionId, operation) || !completed) return false;
      // A completed tail response is coverage even if sparse or empty (legacy
      // transient rows are filtered by Tentacle), never a timeout.
      if (coversHead) {
        this.tailFailures.delete(sessionId);
        this.finishTailCatchUp(sessionId, toSeq, true);
      }
      // Tail first. Repair at most 50 bridge seqs per explicit reconciliation,
      // never below the displayed minimum, and yield to a newer foreground tail.
      if (options?.foreground && !this.pendingTailReconciles.has(sessionId)) {
        const gaps = this.bridgeGaps(sessionId, clampedFrom);
        if (gaps.length) {
          const [from, end] = gaps[0];
          const repaired = await this.loadRange(sessionId, from, Math.min(end, from + 49), operation);
          if (!this.owns(sessionId, operation) || !repaired) return false;
        }
      }
      const remaining = options?.foreground ? this.bridgeGaps(sessionId, clampedFrom) : [];
      this.setRangeStatus(sessionId, remaining.length ? { state: 'incomplete', remaining } : { state: 'loaded' });
      return true;
    } catch (err) {
      if (!this.owns(sessionId, operation)) return false;
      if (coversHead) this.finishTailCatchUp(sessionId, toSeq, false);
      logger.error('fetchRange failed', { sessionId, error: (err as Error).message });
      const status: RangeStatus = { state: 'error', error: err instanceof RangeFailure ? err.code : 'failed' };
      if (coversHead) this.tailFailures.set(sessionId, {
        status, range: { from: clampedFrom, to: toSeq, options },
      });
      this.setRangeStatus(sessionId, status);
      return false;
    } finally {
      // An old continuation must not clear a new operation's loading/timer state.
      if (this.owns(sessionId, operation)) {
        this.operations.delete(sessionId);
        this.loadingSessions.delete(sessionId);
        this.loadingThroughSeq.delete(sessionId);
        this.loadingForeground.delete(sessionId);
        getStore().setSessionLoading(sessionId, false);
        const pendingLastSeq = this.pendingTailReconciles.get(sessionId);
        if (pendingLastSeq !== undefined) {
          this.pendingTailReconciles.delete(sessionId);
          this.reconcileTail(sessionId, pendingLastSeq);
        }
      }
    }
  }

  private bridgeGaps(sessionId: string, tailFrom: number): Array<[number, number]> {
    const messages = (getStore().messages.get(sessionId) ?? []).filter(isSpineCacheMessage);
    const minimum = messages.reduce((min, message) => Math.min(min, (message as { seq: number }).seq), tailFrom);
    return (this.rangeTombstones.get(sessionId) ?? []).reduce(
      (gaps, [from, to]) => excludeInterval(gaps, from, to),
      missingIntervals(messages, minimum, tailFrom - 1),
    );
  }

  private recordRangeTombstones(sessionId: string, messages: ChatMessage[], from: number, to: number): void {
    const ranges = [...(this.rangeTombstones.get(sessionId) ?? []), ...missingIntervals(messages, from, to)]
      .sort(([a], [b]) => a - b);
    const merged: Array<[number, number]> = [];
    for (const [lo, hi] of ranges) {
      const previous = merged.at(-1);
      if (previous && lo <= previous[1] + 1) previous[1] = Math.max(previous[1], hi);
      else merged.push([lo, hi]);
    }
    this.rangeTombstones.set(sessionId, merged);
  }

  private async loadRange(sessionId: string, from: number, to: number, operation: RangeOperation): Promise<boolean> {
    let cached: ChatMessage[] = [];
    try {
      const db = await import('./message-db');
      if (!this.owns(sessionId, operation)) return false;
      cached = await db.getMessagesInRange(sessionId, from, to);
    } catch { /* An unavailable cache may still be recovered from Tentacle. */ }
    if (!this.owns(sessionId, operation)) return false;
    const valid = (message: ChatMessage) => isSpineCacheMessage(message)
      && 'sessionId' in message && message.sessionId === sessionId
      && (message as { seq: number }).seq >= from && (message as { seq: number }).seq <= to;
    const bySeq = new Map<number, ChatMessage>();
    // Store delivery precedes its asynchronous IDB write. Preserve that real
    // coverage for immediate retry/follow-up, and never replace newer memory
    // with a lagging disk row. Incoming server pages still win below.
    const memory = getStore().messages.get(sessionId) ?? [];
    for (const message of [...cached, ...memory].filter(valid)) bySeq.set((message as { seq: number }).seq, message);
    this.deliverMessages(sessionId, [...bySeq.values()]);
    let missing = missingIntervals([...bySeq.values()], from, to);
    // The first request refreshes through the target's end, preserving server
    // authority over cached rows after the first hole. Continuations request
    // actual missing intervals: Tentacle's 500-row cap keeps the newer suffix.
    let request: [number, number] | undefined = missing.length ? [missing[0][0], to] : undefined;
    for (let page = 0; request; page++) {
      if (page === 50) throw new RangeFailure('page-limit');
      const [requestFrom, requestTo] = request;
      const batch = await this.requestFromTentacle(sessionId, requestFrom - 1, requestTo - requestFrom + 1);
      if (!this.owns(sessionId, operation)) return false;
      const incoming = batch.messages.filter(message => valid(message)
        && (message as { seq: number }).seq >= requestFrom && (message as { seq: number }).seq <= requestTo);
      // A suffix or middle page is progress if it fills any still-missing seq,
      // not only when it advances the contiguous prefix. Duplicates cannot.
      const previousCount = bySeq.size;
      for (const message of incoming) bySeq.set((message as { seq: number }).seq, message);
      this.deliverMessages(sessionId, [...bySeq.values()].sort((a, b) => (a as { seq: number }).seq - (b as { seq: number }).seq));
      if (batch.truncated) {
        if (bySeq.size === previousCount) throw new RangeFailure('no-progress');
        missing = missing.flatMap(([lo, hi]) => missingIntervals(incoming, lo, hi));
      } else {
        // Authoritative empty settles only this request; other holes left by
        // an earlier truncated middle page still require their own answer.
        missing = excludeInterval(missing, requestFrom, requestTo);
        // Like PendingTailBuffer's legacy tombstones, absence is authoritative
        // coverage too. Keep it across bridge calculations and explicit retries.
        this.recordRangeTombstones(sessionId, incoming, requestFrom, requestTo);
      }
      if (this.pendingTailReconciles.has(sessionId)) return false; // Newest foreground tail takes precedence.
      request = missing[0];
    }
    return true;
  }

  /**
   * Handle the range-batch response (`session_messages_range_batch`).
   * Resolves the pending range request and feeds the messages into the
   * normal delivery pipeline.
   */
  handleRangeBatch(
    sessionId: string,
    messages: unknown[],
    firstSeq: number,
    lastSeq: number,
    truncated: boolean,
  ): void {
    const count = (messages ?? []).length;
    logger.info('handleRangeBatch received', { sessionId, count, firstSeq, lastSeq, truncated });
    if (truncated) {
      logger.debug('range batch truncated; continuing only with coverage progress', {
        sessionId, firstSeq, lastSeq, count,
      });
    }
    this.deliverPending(sessionId, (messages ?? []) as ChatMessage[], firstSeq, lastSeq, truncated);
  }

  /**
   * Shared delivery path for range batches. Resolves any pending in-flight
   * request; otherwise falls back to a direct store write so messages aren't
   * lost on unsolicited batches.
   */
  private deliverPending(sessionId: string, messages: ChatMessage[], firstSeq: number, lastSeq: number, truncated: boolean): void {
    const pending = this.pendingRequests.get(sessionId);
    if (pending) {
      // The wire has actual row extrema, not request IDs. Reject a late
      // different range, including batches whose rows contradict metadata.
      // Overlapping subsets cannot be disambiguated without a wire change.
      const matches = messages.length === 0
        ? firstSeq === 0 && lastSeq === 0
        : firstSeq >= pending.fromSeq && lastSeq <= pending.toSeq && firstSeq <= lastSeq
          && messages.every((message) => {
            const seq = 'seq' in message ? message.seq : undefined;
            return typeof seq === 'number' && Number.isInteger(seq)
              && seq >= pending.fromSeq && seq <= pending.toSeq
              && 'sessionId' in message && message.sessionId === sessionId;
          });
      if (!matches) {
        logger.warn('range batch does not match pending bounds', {
          sessionId, firstSeq, lastSeq, fromSeq: pending.fromSeq, toSeq: pending.toSeq,
        });
        if (getStore().sessions.has(sessionId)) this.deliverMessages(sessionId, messages);
        return;
      }
      if (messages.length === 0 && this.uncertainEmptySessions.has(sessionId) && !pending.retriedEmpty) {
        pending.retriedEmpty = true;
        pending.send();
        return;
      }
      if (messages.length === 0) this.uncertainEmptySessions.delete(sessionId);
      clearTimeout(pending.timer);
      this.pendingRequests.delete(sessionId);
      pending.resolve({ messages, truncated });
      return;
    }
    // Untagged network responses cannot be attributed to an old request on
    // this wire. Do not let unsolicited delivery clear an IDB operation's loading.
    if (getStore().sessions.has(sessionId)) this.deliverMessages(sessionId, messages);
  }

  /** Record coverage only for an actual response/cache hit, never a timeout.
   *  Terminal failure must not strand a waiting permission behind the hold. */
  private finishTailCatchUp(sessionId: string, throughSeq: number, covered: boolean): void {
    const store = getStore();
    if (covered) store.markHistoryCaughtUp(sessionId, throughSeq);
    else if ((store.cardHoldUntil.get(sessionId) ?? Infinity) <= throughSeq) store.holdCard(sessionId, 0);
  }

  /** Clear provider-owned work (on disconnect). Does not cancel store-owned writes. */
  clear(): void {
    for (const [sessionId, throughSeq] of this.loadingThroughSeq) this.finishTailCatchUp(sessionId, throughSeq, false);
    this.epoch++;
    for (const sessionId of [...this.loadingSessions]) this.invalidateSession(sessionId);
    this.operations.clear();
    this.pendingRequests.clear();
    this.tentacleLastSeq.clear();
    this.tentacleDeviceMap.clear();
    this.retryRanges.clear();
    this.rangeStatuses.clear();
    this.rangeTombstones.clear();
    this.tailFailures.clear();
    this.uncertainEmptySessions.clear();
    for (const listener of this.rangeListeners) listener();
    this.tracePulled.clear();
    this.traceLoaded.clear();
    for (const listener of this.traceListeners) listener();
    this.traceInFlight = null;
    this.traceQueue = [];
    this.traceQueued.clear();
    this.traceRefresh.clear();
    if (this.traceTimeout) clearTimeout(this.traceTimeout);
    this.traceTimeout = null;
    this.cardRequested.clear();
  }

  requestCard(sessionId: string, force = false): void {
    if (force) this.cardRequested.delete(sessionId);
    if (this.cardRequested.has(sessionId)) return;
    const store = getStore();
    if (store.status !== 'connected') return;
    // Prefer the live session_list mapping, but fall back to the store's session
    // record (hydrated from IDB on reload before session_list lands) so a
    // mid-turn reconnect can still pull the card snapshot.
    const tentacleDeviceId =
      this.tentacleDeviceMap.get(sessionId) ?? store.sessions.get(sessionId)?.deviceId;
    if (!tentacleDeviceId || !this.sendFn) return;
    const targetDev = store.devices.get(tentacleDeviceId);
    if (!(targetDev?.encryptionKey ?? targetDev?.publicKey)) return;
    this.cardRequested.add(sessionId);
    this.sendFn({
      type: 'request_card',
      deviceId: store.deviceId ?? '',
      payload: { sessionId, targetDeviceId: tentacleDeviceId },
    });
    logger.info('requested card snapshot', { sessionId });
  }

  /**
   * Pull the TRACE (tool_start/tool_complete detail) for the turn concluding at
   * `bubbleSeq`. Fire-and-forget: the tentacle answers with a `turn_trace_batch`
   * routed back into `handleTurnTraceBatch`, which injects the steps via
   * `store.setTurnSteps`. Deduped per `${sessionId}:${bubbleSeq}` so a concluded
   * turn is only pulled once (a live turn already has its steps from broadcasts;
   * an `idle` clears the key so the authoritative list is pulled once).
   */
  requestTurnTrace(sessionId: string, bubbleSeq: number): void {
    const key = `${sessionId}:${bubbleSeq}`;
    if (this.tracePulled.has(key)) return;
    if (!this.canPullTurnTrace(sessionId, bubbleSeq)) return;

    this.tracePulled.add(key);
    if (this.traceInFlight === null) {
      this.dispatchTurnTrace(sessionId, bubbleSeq);
    } else if (!this.traceQueued.has(key)) {
      this.traceQueued.add(key);
      this.traceQueue.push({ sessionId, bubbleSeq });
    }
  }

  private canPullTurnTrace(sessionId: string, bubbleSeq: number): boolean {
    const tentacleDeviceId = this.tentacleDeviceMap.get(sessionId);
    if (!tentacleDeviceId || !this.sendFn) {
      logger.warn('cannot request turn trace', {
        sessionId, bubbleSeq, hasSend: !!this.sendFn, hasDevice: !!tentacleDeviceId,
      });
      return false;
    }
    const targetDev = getStore().devices.get(tentacleDeviceId);
    if (!(targetDev?.encryptionKey ?? targetDev?.publicKey)) {
      logger.debug('skip turn trace pull — tentacle not encryptable yet', {
        sessionId, bubbleSeq, tentacleDeviceId,
      });
      return false;
    }
    return true;
  }

  private dispatchTurnTrace(sessionId: string, bubbleSeq: number): void {
    const key = `${sessionId}:${bubbleSeq}`;
    const tentacleDeviceId = this.tentacleDeviceMap.get(sessionId);
    if (!tentacleDeviceId || !this.sendFn || !this.canPullTurnTrace(sessionId, bubbleSeq)) {
      this.tracePulled.delete(key);
      this.dispatchNextTurnTrace();
      return;
    }
    this.traceInFlight = key;
    this.sendFn({
      type: 'request_turn_trace',
      deviceId: getStore().deviceId ?? '',
      payload: { sessionId, bubbleSeq, targetDeviceId: tentacleDeviceId },
    });
    if (this.traceTimeout) clearTimeout(this.traceTimeout);
    this.traceTimeout = setTimeout(() => {
      if (this.traceInFlight !== key) return;
      logger.warn('turn trace pull timed out', { sessionId, bubbleSeq });
      this.traceInFlight = null;
      this.traceTimeout = null;
      this.tracePulled.delete(key);
      this.traceRefresh.delete(key);
      this.dispatchNextTurnTrace();
    }, 15_000);
    logger.info('requested turn trace', { sessionId, bubbleSeq });
  }

  private dispatchNextTurnTrace(): void {
    if (this.traceInFlight !== null) return;
    const next = this.traceQueue.shift();
    if (!next) return;
    const key = `${next.sessionId}:${next.bubbleSeq}`;
    this.traceQueued.delete(key);
    this.dispatchTurnTrace(next.sessionId, next.bubbleSeq);
  }

  /**
   * Force a re-pull of a turn's trace on the next `requestTurnTrace` (e.g. on
   * `idle`, to reconcile the live-broadcast steps against the authoritative
   * persisted list).
   */
  invalidateTurnTrace(sessionId: string, bubbleSeq: number): void {
    const key = `${sessionId}:${bubbleSeq}`;
    if (this.traceInFlight === key) {
      this.traceRefresh.add(key);
      return;
    }
    // A queued request has not been sent yet, so it already observes the newest
    // persisted trace and needs no duplicate queue entry.
    if (this.traceQueued.has(key)) return;
    this.tracePulled.delete(key);
  }

  /**
   * Handle a `turn_trace_batch` from the tentacle: inject the pulled steps into
   * the concluding turn. If the turn is still running (`complete === false`),
   * allow a later re-pull so the final list can be reconciled.
   */
  handleTurnTraceBatch(
    sessionId: string,
    bubbleSeq: number,
    entries: unknown[],
    complete: boolean,
  ): void {
    const list = (entries ?? []) as ChatMessage[];
    logger.info('handleTurnTraceBatch received', {
      sessionId, bubbleSeq, count: list.length, complete,
    });
    getStore().setTurnSteps(sessionId, bubbleSeq, list);
    const key = `${sessionId}:${bubbleSeq}`;
    if (complete) this.traceLoaded.add(key);
    else this.traceLoaded.delete(key);
    for (const listener of this.traceListeners) listener();
    const refresh = this.traceRefresh.delete(key);
    if (!complete || refresh) this.tracePulled.delete(key);

    if (this.traceInFlight === key) {
      this.traceInFlight = null;
      if (this.traceTimeout) clearTimeout(this.traceTimeout);
      this.traceTimeout = null;
      if (refresh && this.canPullTurnTrace(sessionId, bubbleSeq)) {
        this.tracePulled.add(key);
        this.traceQueued.add(key);
        this.traceQueue.push({ sessionId, bubbleSeq });
      }
      this.dispatchNextTurnTrace();
    }
  }

  /**
   * Request messages from tentacle for an exact seq range and await the response.
   * `afterSeq` is the EXCLUSIVE lower bound (matches the existing fetchRange
   * semantics where `idbMessages` already cover up to and including `afterSeq`).
   * `limit` is the number of messages we want past `afterSeq`.
   */
  private requestFromTentacle(sessionId: string, afterSeq: number, limit: number): Promise<RangeBatch> {
    const tentacleDeviceId = this.tentacleDeviceMap.get(sessionId);
    if (!tentacleDeviceId || !this.sendFn) return Promise.reject(new RangeFailure('unavailable'));
    const fromSeq = afterSeq + 1;
    const toSeq = afterSeq + limit;
    return new Promise<RangeBatch>((resolve, reject) => {
      const pending: PendingRequest = {
        fromSeq, toSeq, resolve, reject, retriedEmpty: false,
        timer: undefined,
        send: () => {
          clearTimeout(pending.timer);
          pending.timer = setTimeout(() => {
            if (this.pendingRequests.get(sessionId) !== pending) return;
            this.pendingRequests.delete(sessionId);
            this.uncertainEmptySessions.add(sessionId);
            reject(new RangeFailure('timeout'));
          }, BATCH_TIMEOUT_MS);
          try {
            this.sendFn!({
              type: 'request_session_messages_range', deviceId: getStore().deviceId ?? '',
              payload: { sessionId, fromSeq, toSeq, targetDeviceId: tentacleDeviceId },
            });
          } catch (error) {
            clearTimeout(pending.timer);
            if (this.pendingRequests.get(sessionId) === pending) this.pendingRequests.delete(sessionId);
            reject(error);
          }
        },
      };
      this.pendingRequests.set(sessionId, pending);
      pending.send();
    });
  }

  /**
   * Put complete message set into the store and run side effects.
   */
  private deliverMessages(sessionId: string, messages: ChatMessage[]): void {
    const valid = messages.filter(message => isSpineCacheMessage(message)
      && 'sessionId' in message && message.sessionId === sessionId);
    if (valid.length > 0) {
      getStore().prependMessages(sessionId, valid);
      for (const message of valid) {
        if (message.type !== 'user_message') continue;
        const clientId = message.payload.clientId;
        // confirm's clientId lookup is global: validate session first and never
        // infer replay acceptance from text (which could confirm another retry).
        if (clientId && outbox.forSession(sessionId).some(entry => entry.clientId === clientId)) {
          outbox.confirm(sessionId, clientId, undefined);
        }
      }
    }
    logger.info('delivered', { sessionId, count: valid.length });
  }
}

export const messageProvider = new MessageProvider();
