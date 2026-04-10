/**
 * Message Provider — transparent cache layer for session messages.
 *
 * Exposes a single method: fetchRange(sessionId, fromSeq, toSeq).
 * Checks IndexedDB first, falls back to tentacle for missing messages.
 * Callers don't know or care about the source.
 */

import { getStore } from './store-adapter';
import { resolvePermissionMessage, resolveQuestionMessage } from './commands';
import { createLogger } from './logger';
import type { ChatMessage, PendingPermission, PendingQuestion, SessionPreview } from '../types/store';

const logger = createLogger('msg-provider');

const PREVIEW_MAX = 80;
const BATCH_TIMEOUT_MS = 10_000;

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
      const q = typeof payload.question === 'string' ? payload.question : '';
      preview = { text: stripMarkdown(q).slice(0, PREVIEW_MAX), type: 'question', timestamp: ts };
      break;
    }
    if (m.type === 'permission' && payload) {
      const tool = typeof payload.toolName === 'string' ? payload.toolName : '';
      preview = { text: tool.slice(0, PREVIEW_MAX), type: 'permission', timestamp: ts };
      break;
    }
    if (m.type === 'error' && payload) {
      const msg = typeof payload.message === 'string' ? payload.message : 'Error';
      preview = { text: stripMarkdown(msg).slice(0, PREVIEW_MAX), type: 'error', timestamp: ts };
      break;
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
    if (m.type === 'agent_message' && payload) {
      const content = typeof payload.content === 'string' ? payload.content : '';
      const next = msgs[i + 1];
      if (!next || next.type === 'idle') {
        preview = { text: stripMarkdown(content).slice(0, PREVIEW_MAX), type: 'agent', timestamp: ts };
        break;
      }
    }
  }

  if (preview) {
    store.setSessionPreview(sessionId, preview);
  }
}

/**
 * Scan replayed messages for pending permissions/questions.
 */
function processReplayedActions(sessionId: string, messages: ChatMessage[]): void {
  const store = getStore();

  const resolvedPermIds = new Set<string>();
  const resolvedQuestionIds = new Set<string>();
  const permResolutions = new Map<string, 'approved' | 'denied' | 'always_allowed' | 'cancelled'>();
  const questionAnswers = new Map<string, string>();

  for (const msg of messages) {
    switch (msg.type) {
      case 'approve':
        resolvedPermIds.add(msg.payload?.permissionId);
        permResolutions.set(msg.payload?.permissionId, 'approved');
        break;
      case 'deny':
        resolvedPermIds.add(msg.payload?.permissionId);
        permResolutions.set(msg.payload?.permissionId, 'denied');
        break;
      case 'always_allow':
        resolvedPermIds.add(msg.payload?.permissionId);
        permResolutions.set(msg.payload?.permissionId, 'always_allowed');
        break;
      case 'permission_resolved':
        resolvedPermIds.add(msg.payload?.permissionId);
        permResolutions.set(msg.payload?.permissionId, msg.payload?.resolution);
        break;
      case 'answer':
        if (msg.payload?.questionId) {
          resolvedQuestionIds.add(msg.payload.questionId);
          questionAnswers.set(msg.payload.questionId, msg.payload?.answer as string);
        }
        break;
      case 'question_resolved':
        if (msg.payload?.questionId) {
          resolvedQuestionIds.add(msg.payload.questionId);
          questionAnswers.set(msg.payload.questionId, msg.payload?.answer as string);
        }
        break;
    }
  }

  for (const msg of messages) {
    if (msg.type === 'permission' && !resolvedPermIds.has(msg.payload?.id)) {
      if (!store.pendingPermissions.has(msg.payload.id)) {
        const perm: PendingPermission = {
          id: msg.payload.id,
          sessionId,
          toolName: msg.payload.toolName,
          args: (msg.payload.args ?? {}) as Record<string, unknown>,
          description: msg.payload.description,
          timestamp: msg.timestamp,
        };
        store.addPermission(perm);
        logger.info('restored pending permission from replay', { sessionId, permissionId: perm.id });
      }
    }
    if (msg.type === 'question' && !resolvedQuestionIds.has(msg.payload?.id)) {
      if (!store.pendingQuestions.has(msg.payload.id)) {
        const q: PendingQuestion = {
          id: msg.payload.id,
          sessionId,
          question: msg.payload.question,
          choices: msg.payload.choices,
          timestamp: msg.timestamp,
        };
        store.addQuestion(q);
        logger.info('restored pending question from replay', { sessionId, questionId: q.id });
      }
    }
  }

  for (const [permId, resolution] of permResolutions) {
    resolvePermissionMessage(sessionId, permId, resolution);
    store.removePermission(permId);
  }
  for (const [qId, answer] of questionAnswers) {
    resolveQuestionMessage(sessionId, qId, answer);
    store.removeQuestion(qId);
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
  /** Pending tentacle requests awaiting handleBatch */
  private pendingRequests = new Map<string, PendingRequest>();
  /** Sessions currently loading */
  private loadingSessions = new Set<string>();

  setSend(fn: (msg: Record<string, unknown>) => void): void {
    this.sendFn = fn;
  }

  setTentacleInfo(sessionId: string, lastSeq: number, deviceId: string): void {
    this.tentacleLastSeq.set(sessionId, lastSeq);
    this.tentacleDeviceMap.set(sessionId, deviceId);
  }

  /** Check if a session has an in-flight request. */
  isLoading(sessionId: string): boolean {
    return this.loadingSessions.has(sessionId);
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
    if (options?.initial) {
      getStore().setSessionLoading(sessionId, true);
    }

    try {
      // Step 1: Check IDB for the requested range
      let idbMessages: ChatMessage[] = [];
      try {
        const db = await import('./message-db');
        idbMessages = await db.getMessagesInRange(sessionId, clampedFrom, toSeq);
        logger.info('IDB range query', { sessionId, fromSeq: clampedFrom, toSeq, found: idbMessages.length, expected: toSeq - clampedFrom + 1 });
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
      getStore().setSessionLoading(sessionId, false);
    }
  }

  /**
   * Handle a replay batch from tentacle — resolves the pending request.
   */
  handleBatch(sessionId: string, messages: unknown[], _lastSeq: number, _totalLastSeq: number): void {
    logger.info('handleBatch received', { sessionId, count: (messages ?? []).length });
    const typed = (messages ?? []) as ChatMessage[];
    const pending = this.pendingRequests.get(sessionId);
    if (pending) {
      this.pendingRequests.delete(sessionId);
      pending.resolve(typed);
    } else {
      // No pending request — direct batch (e.g. from a concurrent path)
      // Put directly in store as fallback
      if (typed.length > 0) {
        getStore().prependMessages(sessionId, typed);
        processReplayedActions(sessionId, typed);
        rebuildPreview(sessionId);
      }
      this.loadingSessions.delete(sessionId);
      getStore().setSessionLoading(sessionId, false);
    }
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
  }

  /**
   * Request messages from tentacle and await the batch response.
   */
  private requestFromTentacle(sessionId: string, afterSeq: number, limit: number): Promise<ChatMessage[]> {
    const tentacleDeviceId = this.tentacleDeviceMap.get(sessionId);
    if (!tentacleDeviceId || !this.sendFn) {
      logger.warn('cannot request from tentacle', { sessionId, hasSend: !!this.sendFn, hasDevice: !!tentacleDeviceId });
      return Promise.resolve([]);
    }

    return new Promise<ChatMessage[]>((resolve) => {
      this.pendingRequests.set(sessionId, { sessionId, resolve });

      const store = getStore();
      this.sendFn!({
        type: 'request_session_replay',
        deviceId: store.deviceId ?? '',
        payload: { sessionId, afterSeq, limit, targetDeviceId: tentacleDeviceId },
      });

      logger.info('requested from tentacle', { sessionId, afterSeq, limit });

      // Safety timeout — resolve with empty if tentacle never responds
      setTimeout(() => {
        if (this.pendingRequests.has(sessionId)) {
          logger.warn('tentacle request timed out', { sessionId, afterSeq });
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
      processReplayedActions(sessionId, messages);
      if (initial) {
        rebuildPreview(sessionId);
      }
    }
    logger.info('delivered', { sessionId, count: messages.length, initial });
  }
}

export const messageProvider = new MessageProvider();
