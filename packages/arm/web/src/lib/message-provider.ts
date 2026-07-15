/**
 * Message Provider — transparent cache layer for session messages.
 *
 * Exposes a single method: fetchRange(sessionId, fromSeq, toSeq).
 * Checks IndexedDB first, falls back to tentacle for missing messages.
 * Callers don't know or care about the source.
 */

import { getStore } from './store-adapter';
import { createLogger } from './logger';
import type { ChatMessage, SessionPreview } from '../types/store';

const logger = createLogger('msg-provider');

const PREVIEW_MAX = 80;
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
  'permission_resolved',
  'question_resolved',
]);

function isSpineCacheMessage(message: ChatMessage): boolean {
  return !NON_SPINE_CACHE_TYPES.has(message.type);
}

/** Strip common markdown syntax for clean preview display. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '') // fenced code blocks
    .replace(/`([^`]+)`/g, '$1')    // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')  // italic
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')    // headings
    .replace(/^\s*[-*+]\s+/gm, '')  // list items
    .replace(/^\s*\d+\.\s+/gm, '')  // ordered list items
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // images
    .replace(/\n+/g, ' ')           // newlines to spaces
    .replace(/\s+/g, ' ')           // collapse whitespace
    .trim();
}

/**
 * Rebuild session preview from the current messages in the store.
 */
function rebuildPreview(sessionId: string): void {
  const store = getStore();
  const msgs = store.messages.get(sessionId);
  if (!msgs || msgs.length === 0) return;

  let preview: SessionPreview | null = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const ts = 'timestamp' in m ? (m as { timestamp: string }).timestamp : '';
    const payload = 'payload' in m ? (m.payload as Record<string, unknown>) : null;

    if (m.type === 'question' && payload) {
      // Skip already-answered questions — they shouldn't show the question badge
      if (payload.answer) continue;
      const q = typeof payload.question === 'string' ? payload.question : '';
      preview = { text: stripMarkdown(q).slice(0, PREVIEW_MAX), type: 'question', timestamp: ts };
      break;
    }
    if (m.type === 'permission' && payload) {
      // Skip already-resolved permissions
      if (payload.resolution) continue;
      const tool = typeof payload.toolName === 'string' ? payload.toolName : '';
      preview = { text: tool.slice(0, PREVIEW_MAX), type: 'permission', timestamp: ts };
      break;
    }
    if (m.type === 'error' && payload) {
      const msg = typeof payload.message === 'string' ? payload.message : 'Error';
      preview = { text: stripMarkdown(msg).slice(0, PREVIEW_MAX), type: 'error', timestamp: ts };
      break;
    }
    if (m.type === 'turn_status' && payload) {
      const draft = typeof payload.draft === 'string' ? payload.draft : '';
      const action = payload.action && typeof payload.action === 'object' ? payload.action as Record<string, unknown> : null;
      const kind = action && action.type === 'failed' ? 'Turn failed' : 'User aborted';
      preview = { text: stripMarkdown(draft || kind).slice(0, PREVIEW_MAX), type: action?.type === 'failed' ? 'error' : 'agent', timestamp: ts };
      break;
    }
    if (m.type === 'interrupted_turn' && payload) {
      const draft = typeof payload.draft === 'string' ? payload.draft : '';
      const failed = payload.reason === 'process_lost';
      preview = {
        text: stripMarkdown(draft || (failed ? 'Turn failed' : 'User aborted')).slice(0, PREVIEW_MAX),
        type: failed ? 'error' : 'agent',
        timestamp: ts,
      };
      break;
    }
    if (m.type === 'agent_message' && payload) {
      const content = typeof payload.content === 'string' ? payload.content : '';
      if (content) {
        preview = { text: stripMarkdown(content).slice(0, PREVIEW_MAX), type: 'agent', timestamp: ts };
        break;
      }
    }
    if (m.type === 'user_message' && payload) {
      const content = typeof payload.content === 'string' ? payload.content : '';
      preview = { text: stripMarkdown(content).slice(0, PREVIEW_MAX), type: 'user', timestamp: ts };
      break;
    }
    if (m.type === 'answer' && payload) {
      const answer = typeof payload.answer === 'string' ? payload.answer : '';
      if (answer) { preview = { text: stripMarkdown(answer).slice(0, PREVIEW_MAX), type: 'answer', timestamp: ts }; break; }
    }
  }

  if (preview) {
    store.setSessionPreview(sessionId, preview);
  }
}

interface PendingRequest {
  sessionId: string;
  resolve: (messages: ChatMessage[]) => void;
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
  /** Sessions currently loading */
  private loadingSessions = new Set<string>();
  /** Highest seq covered by each in-flight fetch. */
  private loadingThroughSeq = new Map<string, number>();
  /** Latest tail reconciliation requested beyond an in-flight range. */
  private pendingTailReconciles = new Map<string, number>();
  /** Turn-trace pulls already issued, keyed `${sessionId}:${bubbleSeq}`.
   *  Prevents re-pulling the same concluded turn's TRACE on every render. */
  private tracePulled = new Set<string>();
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
      if (authoritativeLastSeq > loadingThrough) {
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
    void this.fetchRange(sessionId, fromSeq, authoritativeLastSeq, { initial: true });
  }

  /**
   * Fetch messages in a seq range. Checks IDB first, falls back to tentacle.
   * Puts the complete result into the store in one write.
   */
  async fetchRange(sessionId: string, fromSeq: number, toSeq: number, options?: { initial?: boolean }): Promise<void> {
    if (this.loadingSessions.has(sessionId)) {
      logger.info('fetchRange skipped (loading)', { sessionId, fromSeq, toSeq });
      return;
    }

    const clampedFrom = Math.max(1, fromSeq);
    if (clampedFrom > toSeq) return;

    logger.info('fetchRange', { sessionId, fromSeq: clampedFrom, toSeq, initial: options?.initial });

    this.loadingSessions.add(sessionId);
    this.loadingThroughSeq.set(sessionId, toSeq);
    if (options?.initial) {
      getStore().setSessionLoading(sessionId, true);
    }

    try {
      // Step 1: Check IDB for the requested range
      let idbMessages: ChatMessage[] = [];
      try {
        const db = await import('./message-db');
        const cached = await db.getMessagesInRange(sessionId, clampedFrom, toSeq);
        idbMessages = cached.filter(isSpineCacheMessage);
        logger.info('IDB range query', {
          sessionId,
          fromSeq: clampedFrom,
          toSeq,
          found: idbMessages.length,
          ignoredTransient: cached.length - idbMessages.length,
          expected: toSeq - clampedFrom + 1,
        });
      } catch {
        // IDB unavailable
      }

      // Step 2: Check if IDB covers the full range
      const expectedCount = toSeq - clampedFrom + 1;
      if (idbMessages.length >= expectedCount) {
        // IDB has everything — put in store and done
        this.deliverMessages(sessionId, idbMessages, options?.initial);
        return;
      }

      // Step 3: IDB has partial or no data — request from tentacle
      // Find the highest seq IDB has to request only the missing portion
      const idbSeqs = new Set(idbMessages.map(m => {
        const seq = 'seq' in m ? (m as { seq?: number }).seq : undefined;
        return typeof seq === 'number' ? seq : 0;
      }));
      let afterSeq = clampedFrom - 1;
      if (idbMessages.length > 0) {
        // Find the highest contiguous seq from IDB to minimize tentacle request
        let highestIdb = clampedFrom - 1;
        for (let s = clampedFrom; s <= toSeq; s++) {
          if (idbSeqs.has(s)) highestIdb = s;
          else break;
        }
        afterSeq = highestIdb;
      }

      const tentacleMessages = await this.requestFromTentacle(sessionId, afterSeq, toSeq - afterSeq);
      
      // Merge IDB + tentacle, dedup by seq, sort
      const allMessages = [...idbMessages, ...tentacleMessages];
      const seen = new Set<number>();
      const deduped = allMessages.filter(m => {
        const seq = 'seq' in m ? (m as { seq?: number }).seq : undefined;
        if (typeof seq !== 'number' || seen.has(seq)) return false;
        seen.add(seq);
        return true;
      });
      deduped.sort((a, b) => {
        const seqA = 'seq' in a ? (a as { seq?: number }).seq ?? 0 : 0;
        const seqB = 'seq' in b ? (b as { seq?: number }).seq ?? 0 : 0;
        return seqA - seqB;
      });

      // Store tentacle messages in IDB for future cache hits
      if (tentacleMessages.length > 0) {
        import('./message-db').then(db => db.putMessages(sessionId, tentacleMessages)).catch(() => {});
      }

      this.deliverMessages(sessionId, deduped, options?.initial);
    } catch (err) {
      logger.error('fetchRange failed', { sessionId, error: (err as Error).message });
    } finally {
      this.loadingSessions.delete(sessionId);
      this.loadingThroughSeq.delete(sessionId);
      getStore().setSessionLoading(sessionId, false);
      const pendingLastSeq = this.pendingTailReconciles.get(sessionId);
      if (pendingLastSeq !== undefined) {
        this.pendingTailReconciles.delete(sessionId);
        this.reconcileTail(sessionId, pendingLastSeq);
      }
    }
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
      logger.warn('range batch was truncated by tentacle — caller may need to paginate', {
        sessionId, firstSeq, lastSeq, count,
      });
    }
    this.deliverPending(sessionId, (messages ?? []) as ChatMessage[]);
  }

  /**
   * Shared delivery path for range batches. Resolves any pending in-flight
   * request; otherwise falls back to a direct store write so messages aren't
   * lost on unsolicited batches.
   */
  private deliverPending(sessionId: string, messages: ChatMessage[]): void {
    const pending = this.pendingRequests.get(sessionId);
    if (pending) {
      this.pendingRequests.delete(sessionId);
      pending.resolve(messages);
      return;
    }
    // No pending request — direct batch (e.g. from a concurrent path)
    if (messages.length > 0) {
      getStore().prependMessages(sessionId, messages);
      rebuildPreview(sessionId);
    }
    this.loadingSessions.delete(sessionId);
    getStore().setSessionLoading(sessionId, false);
  }

  /** Clear all tracking (on disconnect). */
  clear(): void {
    // Resolve any pending requests with empty results
    for (const [, pending] of this.pendingRequests) {
      pending.resolve([]);
    }
    this.pendingRequests.clear();
    this.tentacleLastSeq.clear();
    this.tentacleDeviceMap.clear();
    this.loadingSessions.clear();
    this.loadingThroughSeq.clear();
    this.pendingTailReconciles.clear();
    this.tracePulled.clear();
    this.cardRequested.clear();
  }

  requestCard(sessionId: string): void {
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
    const tentacleDeviceId = this.tentacleDeviceMap.get(sessionId);
    if (!tentacleDeviceId || !this.sendFn) {
      logger.warn('cannot request turn trace', {
        sessionId, bubbleSeq, hasSend: !!this.sendFn, hasDevice: !!tentacleDeviceId,
      });
      return;
    }
    const store = getStore();
    // A turn-trace pull is a best-effort background reconcile. If the tentacle
    // device has no known encryption key yet (offline / no key exchange this
    // session), the encrypted-send path would surface a user-facing
    // "Cannot send: target device has no encryption key" banner — wrong for a
    // silent background operation. Skip without marking as pulled so it retries
    // once the key arrives.
    const targetDev = store.devices.get(tentacleDeviceId);
    if (!(targetDev?.encryptionKey ?? targetDev?.publicKey)) {
      logger.debug('skip turn trace pull — tentacle not encryptable yet', {
        sessionId, bubbleSeq, tentacleDeviceId,
      });
      return;
    }
    this.tracePulled.add(key);
    this.sendFn({
      type: 'request_turn_trace',
      deviceId: store.deviceId ?? '',
      payload: { sessionId, bubbleSeq, targetDeviceId: tentacleDeviceId },
    });
    logger.info('requested turn trace', { sessionId, bubbleSeq });
  }

  /**
   * Force a re-pull of a turn's trace on the next `requestTurnTrace` (e.g. on
   * `idle`, to reconcile the live-broadcast steps against the authoritative
   * persisted list).
   */
  invalidateTurnTrace(sessionId: string, bubbleSeq: number): void {
    this.tracePulled.delete(`${sessionId}:${bubbleSeq}`);
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
    if (!complete) {
      // Turn not finished — let a subsequent pull (e.g. at idle) refresh it.
      this.tracePulled.delete(`${sessionId}:${bubbleSeq}`);
    }
  }

  /**
   * Request messages from tentacle for an exact seq range and await the response.
   * `afterSeq` is the EXCLUSIVE lower bound (matches the existing fetchRange
   * semantics where `idbMessages` already cover up to and including `afterSeq`).
   * `limit` is the number of messages we want past `afterSeq`.
   */
  private requestFromTentacle(sessionId: string, afterSeq: number, limit: number): Promise<ChatMessage[]> {
    const tentacleDeviceId = this.tentacleDeviceMap.get(sessionId);
    if (!tentacleDeviceId || !this.sendFn) {
      logger.warn('cannot request from tentacle', { sessionId, hasSend: !!this.sendFn, hasDevice: !!tentacleDeviceId });
      return Promise.resolve([]);
    }

    const fromSeq = afterSeq + 1;
    const toSeq = afterSeq + limit;
    if (toSeq < fromSeq) return Promise.resolve([]);

    return new Promise<ChatMessage[]>((resolve) => {
      const pending: PendingRequest = { sessionId, resolve };
      this.pendingRequests.set(sessionId, pending);

      const store = getStore();
      this.sendFn!({
        type: 'request_session_messages_range',
        deviceId: store.deviceId ?? '',
        payload: { sessionId, fromSeq, toSeq, targetDeviceId: tentacleDeviceId },
      });

      logger.info('requested from tentacle (range)', { sessionId, fromSeq, toSeq });

      // Safety timeout — resolve with empty if tentacle never responds
      setTimeout(() => {
        // A later tail reconcile may already have installed a new request for
        // this session. Only the request that armed this timer may time out.
        if (this.pendingRequests.get(sessionId) === pending) {
          logger.warn('tentacle range request timed out', { sessionId, fromSeq, toSeq });
          this.pendingRequests.delete(sessionId);
          resolve([]);
        }
      }, BATCH_TIMEOUT_MS);
    });
  }

  /**
   * Put complete message set into the store and run side effects.
   */
  private deliverMessages(sessionId: string, messages: ChatMessage[], initial?: boolean): void {
    if (messages.length > 0) {
      getStore().prependMessages(sessionId, messages);
      if (initial) {
        const existingPreview = getStore().sessionPreviews.get(sessionId);
        rebuildPreview(sessionId);
        // Preserve the existing preview timestamp if it's newer than the rebuilt one.
        // This keeps forked sessions showing their fork time instead of the source
        // session's last message time.
        if (existingPreview) {
          const rebuilt = getStore().sessionPreviews.get(sessionId);
          if (rebuilt && existingPreview.timestamp > rebuilt.timestamp) {
            getStore().setSessionPreview(sessionId, { ...rebuilt, timestamp: existingPreview.timestamp });
          }
        }
      }
    }
    logger.info('delivered', { sessionId, count: messages.length, initial });
  }
}

export const messageProvider = new MessageProvider();
