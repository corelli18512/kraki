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
import { resolvePermissionMessage, resolveQuestionMessage } from './commands';
import { createLogger } from './logger';
import type { ChatMessage, PendingPermission, PendingQuestion, SessionPreview } from '../types/store';

const logger = createLogger('msg-provider');

const PAGE_SIZE = 100;
const LATEST_SIZE = 50;
const PREVIEW_MAX = 80;

/**
 * Rebuild session preview from the current messages in the store.
 * Scans backwards for the last meaningful message (agent answer after idle,
 * question, permission, error, user_message, or answer).
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
      preview = { text: q.slice(0, PREVIEW_MAX), type: 'question', timestamp: ts };
      break;
    }
    if (m.type === 'permission' && payload) {
      const tool = typeof payload.toolName === 'string' ? payload.toolName : '';
      preview = { text: tool.slice(0, PREVIEW_MAX), type: 'permission', timestamp: ts };
      break;
    }
    if (m.type === 'error' && payload) {
      const msg = typeof payload.message === 'string' ? payload.message : 'Error';
      preview = { text: msg.slice(0, PREVIEW_MAX), type: 'error', timestamp: ts };
      break;
    }
    if (m.type === 'user_message' && payload) {
      const content = typeof payload.content === 'string' ? payload.content : '';
      preview = { text: content.slice(0, PREVIEW_MAX), type: 'user', timestamp: ts };
      break;
    }
    if (m.type === 'answer' && payload) {
      const answer = typeof payload.answer === 'string' ? payload.answer : '';
      if (answer) { preview = { text: answer.slice(0, PREVIEW_MAX), type: 'answer', timestamp: ts }; break; }
    }
    if (m.type === 'agent_message' && payload) {
      const content = typeof payload.content === 'string' ? payload.content : '';
      // Only use agent_message if it's the final answer (followed by idle or is the last message)
      const next = msgs[i + 1];
      if (!next || next.type === 'idle') {
        preview = { text: content.slice(0, PREVIEW_MAX), type: 'agent', timestamp: ts };
        break;
      }
    }
  }

  if (preview) {
    store.setSessionPreview(sessionId, preview);
  }
}

/**
 * Scan replayed messages for pending permissions/questions that didn't go
 * through handleDataMessage (the live path). Without this, permissions
 * arriving via batch replay are never added to pendingPermissions and end up
 * folded into the ThinkingBox with no actionable PermissionInput card.
 */
function processReplayedActions(sessionId: string, messages: ChatMessage[]): void {
  const store = getStore();

  // Collect IDs that have been resolved within this batch
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

  // Add unresolved permissions to the store so ChatView can show PermissionInput
  for (const msg of messages) {
    if (msg.type === 'permission' && !resolvedPermIds.has(msg.payload?.id)) {
      // Only add if not already tracked
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

  // Stamp resolutions on permission messages so MessageBubble renders them correctly
  for (const [permId, resolution] of permResolutions) {
    resolvePermissionMessage(sessionId, permId, resolution);
    store.removePermission(permId);
  }
  for (const [qId, answer] of questionAnswers) {
    resolveQuestionMessage(sessionId, qId, answer);
    store.removeQuestion(qId);
  }
}

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

    // Signal loading start
    getStore().setSessionLoading(sessionId, true);

    // Check IndexedDB first
    let dbLastSeq = 0;
    try {
      const db = await import('./message-db');
      const lastSeq = await db.getLastSeq(sessionId, totalLastSeq);
      dbLastSeq = lastSeq;

      if (lastSeq > 0) {
        const allMsgs = await db.getMessages(sessionId);
        const latestFromDb = allMsgs.slice(-LATEST_SIZE);
        if (latestFromDb.length > 0) {
          getStore().prependMessages(sessionId, latestFromDb);
          processReplayedActions(sessionId, latestFromDb as ChatMessage[]);
          rebuildPreview(sessionId);
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
        return; // loading cleared when batch arrives
      }
    }

    // No tentacle request needed — clear loading now
    getStore().setSessionLoading(sessionId, false);
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
          processReplayedActions(sessionId, older as ChatMessage[]);
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

    const typed = (messages ?? []) as ChatMessage[];
    if (typed.length > 0) {
      getStore().prependMessages(sessionId, typed);
      processReplayedActions(sessionId, typed);
      rebuildPreview(sessionId);
    }

    // Clear internal loading keys for this session
    for (const key of [...this.loading]) {
      if (key.startsWith(`${sessionId}:`)) {
        this.loading.delete(key);
      }
    }
    getStore().setSessionLoading(sessionId, false);
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
