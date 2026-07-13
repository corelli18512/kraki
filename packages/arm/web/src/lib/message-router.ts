import type { InnerMessage, SessionListMessage, SessionMessagesRangeBatchMessage, DeviceGreetingMessage, SessionModeSetMessage, SessionModelSetMessage, SessionTitleUpdatedMessage, SessionPinnedMessage, SessionReadMessage, IdleMessage, ProducerMessage, AgentMessageDelta, CardAction } from '@kraki/protocol';
import { getStore } from './store-adapter';
import { isViewingSession } from './replay';
import { createLogger } from './logger';
import type { CommandState } from './commands';
import { messageProvider } from './message-provider';
import { ingestChunk } from './attachments';
import type { SessionPreview } from '../types/store';
import { traceEvent } from './trace';

const logger = createLogger('msg-router');

const PREVIEW_MAX = 80;
function truncPreview(s: string): string {
  return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) + '…' : s;
}

/**
 * Message types that can trigger an unread badge.
 * Used by the live message handler and the reconnect IDB scan.
 */
export const UNREAD_CANDIDATE_TYPES = new Set(['error', 'idle']);

const RETIRED_LIVE_TYPES = new Set([
  'agent_narration',
  'tool_start',
  'tool_complete',
  'permission',
  'question',
  'permission_resolved',
  'question_resolved',
  'approve',
  'deny',
  'always_allow',
  'answer',
]);

/** Set session preview and optionally increment unread. */
function updatePreview(sid: string, preview: SessionPreview, notify: boolean): void {
  const store = getStore();
  const shouldIncrement = notify && (!isViewingSession(sid) || !document.hasFocus());
  store.setSessionPreview(sid, preview, shouldIncrement);
}

export interface RouterContext {
  cmdState: CommandState;
  /** Send an encrypted message back through the relay (for auto-approve in auto mode). */
  sendEncrypted?: (msg: Record<string, unknown>) => void;
  /** Called when tentacle sends session_list for sync. */
  onSessionList?: (msg: SessionListMessage) => void;
  /** Called when tentacle sends a range-fetch batch. */
  onSessionMessagesRangeBatch?: (msg: SessionMessagesRangeBatchMessage) => void;
}

export function handleDataMessage(msg: InnerMessage, ctx: RouterContext): void {
  const store = getStore();

  // Handle session_list — tentacle's authoritative session metadata
  if (msg.type === 'session_list') {
    ctx.onSessionList?.(msg);
    return;
  }

  // Handle session_messages_range_batch — response to request_session_messages_range
  if (msg.type === 'session_messages_range_batch') {
    ctx.onSessionMessagesRangeBatch?.(msg as SessionMessagesRangeBatchMessage);
    return;
  }
  // Handle turn_trace_batch — response to request_turn_trace (TRACE axis pull).
  // Routed before the session-existence check parity with range batches; the
  // provider injects the steps into the concluding turn's bubble.
  if (msg.type === 'turn_trace_batch') {
    const p = (msg as { payload: { sessionId: string; bubbleSeq: number; entries: unknown[]; complete: boolean } }).payload;
    messageProvider.handleTurnTraceBatch(p.sessionId, p.bubbleSeq, p.entries, p.complete);
    return;
  }
  // attachment_data — chunk of bytes for an attachment ref. Has a sessionId
  // but we route it before the session-existence check because the chunk's
  // session may not be in our store yet during early load.
  if (msg.type === 'attachment_data') {
    const payload = (msg as { payload: { id: string; index: number; total: number; mimeType: string; data: string; error?: string } }).payload;
    void ingestChunk(payload.id, payload.index, payload.total, payload.mimeType, payload.data, payload.error);
    return;
  }

  // agent_message_delta / card_action — status-card draft stream + action slot.
  // Routed before the session-existence check (like turn_trace_batch) because a
  // reconnect push/snapshot can arrive before session_list hydrates the store;
  // applyCardMessage/setCardAction key purely by sessionId and don't need the
  // session record to exist yet.
  if (msg.type === 'agent_message_delta') {
    const cardMsg = msg as AgentMessageDelta;
    store.applyCardMessage(
      cardMsg.sessionId,
      cardMsg.payload.content,
      cardMsg.payload.reset,
    );
    return;
  }
  if (msg.type === 'card_action') {
    const cardAction = msg as CardAction;
    store.setCardAction(cardAction.sessionId, cardAction.payload.action);
    return;
  }

  // Handle local_sessions_list — response to import picker request
  if (msg.type === 'local_sessions_list') {
    const payload = (msg as { payload: { sessions: unknown[]; requestId?: string } }).payload;
    store.setLocalSessions(payload.sessions as import('@kraki/protocol').LocalSession[]);
    store.setLocalSessionsLoading(false);
    return;
  }

  // Handle device_greeting before sessionId check (greetings have no sessionId)
  if (msg.type === 'device_greeting') {
    const greeting = (msg as DeviceGreetingMessage).payload;
    store.setDeviceOnline(msg.deviceId, true);
    if (greeting?.agents?.length) {
      store.setDeviceAgents(msg.deviceId, greeting.agents);
    }
    if (greeting?.version) {
      store.setDeviceVersion(msg.deviceId, greeting.version);
    }
    return;
  }

  if (!('sessionId' in msg) || !msg.sessionId) return;
  const sid = msg.sessionId;
  const replaying = false; // Replay now arrives as batch, not individual messages

  // Drop messages for sessions we don't know about — session_list sync on
  // reconnect will recover any legitimately missed sessions.
  if (!store.sessions.has(sid) && msg.type !== 'session_created') {
    return;
  }

  if (RETIRED_LIVE_TYPES.has(msg.type)) return;

  switch (msg.type) {
    case 'session_created': {
      const device = store.devices.get(msg.deviceId);
      store.upsertSession({
        id: sid,
        deviceId: msg.deviceId,
        deviceName: device?.name ?? msg.deviceId,
        agent: msg.payload.agent,
        model: msg.payload.model,
        state: 'active',
        messageCount: 0,
      });
      // Clear pending state — session is now real
      store.removePendingSession(sid);
      // Set an initial preview so new sessions sort to the top of the list
      updatePreview(sid, { text: 'New session', type: 'session_created', timestamp: msg.timestamp ?? new Date().toISOString() }, false);
      const lastSeq = (msg.payload as Record<string, unknown>).lastSeq as number | undefined;
      const enriched = lastSeq && lastSeq > 0 ? { ...msg, payload: { ...msg.payload, forked: true } } : msg;
      store.appendMessage(sid, enriched);
      // Set tentacle info so message provider can route replay requests
      messageProvider.setTentacleInfo(sid, lastSeq ?? 0, msg.deviceId);
      if (lastSeq && lastSeq > 0) {
        const fromSeq = Math.max(1, lastSeq - 49);
        messageProvider.fetchRange(sid, fromSeq, lastSeq, { initial: true });
      }
      const reqId = msg.payload.requestId;
      const wasOurRequest = reqId ? ctx.cmdState.pendingCreateRequests.delete(reqId) : false;
      // Show initial prompt as user message if we sent one via create_session
      const pendingPrompt = reqId ? ctx.cmdState.pendingPrompts.get(reqId) : undefined;
      if (pendingPrompt) {
        ctx.cmdState.pendingPrompts.delete(reqId!);
        store.appendMessage(sid, {
          type: 'user_message',
          sessionId: sid,
          deviceId: '',
          seq: 0,
          timestamp: msg.timestamp,
          payload: { content: pendingPrompt },
        } as ProducerMessage);
      }
      // Auto-navigate to the new session if we created it
      if (wasOurRequest) {
        store.setNavigateToSession(sid);
      }
      break;
    }

    case 'session_ended': {
      const ended = store.sessions.get(sid);
      if (ended) store.upsertSession({ ...ended, state: 'ended' });
      store.appendMessage(sid, msg);
      break;
    }

    case 'agent_message': {
      logger.info('agent_message received', { sessionId: sid, contentLen: msg.payload.content?.length });
      traceEvent({ comp: 'arm', evt: 'APP-AGENT-MESSAGE', sessionId: sid, contentLen: msg.payload.content?.length });
      store.appendMessage(sid, msg);
      // Preview is set by idle handler (final answer only) and rebuildPreview (IDB/replay).
      // Setting it here would show intermediate thinking-step messages.
      break;
    }

    case 'error':
      // Clear pending state if this error is for an optimistic session
      if (store.pendingSessions.has(sid)) {
        store.removePendingSession(sid);
      }
      store.appendMessage(sid, msg);
      updatePreview(sid, {
        text: truncPreview((msg.payload as Record<string, unknown>).message as string ?? 'Error'),
        type: 'error',
        timestamp: msg.timestamp,
      }, !replaying);
      break;

    case 'turn_status': {
      store.appendMessage(sid, msg);
      const draft = typeof msg.payload.draft === 'string' ? msg.payload.draft : '';
      const failed = msg.payload.action?.type === 'failed';
      updatePreview(sid, {
        text: truncPreview(draft || (failed ? 'Turn failed' : 'User aborted')),
        type: failed ? 'error' : 'agent',
        timestamp: msg.timestamp,
      }, !replaying);
      break;
    }

    case 'interrupted_turn': {
      store.appendMessage(sid, msg);
      const draft = typeof msg.payload.draft === 'string' ? msg.payload.draft : '';
      const failed = msg.payload.reason === 'process_lost';
      updatePreview(sid, {
        text: truncPreview(draft || (failed ? 'Turn failed' : 'User aborted')),
        type: failed ? 'error' : 'agent',
        timestamp: msg.timestamp,
      }, !replaying);
      break;
    }

    case 'system_message': {
      // Kraki-originated spine notice (e.g. no_reply). Behaves like an
      // agent_message boundary: clear the ephemeral narration draft and land a
      // persistent bubble that anchors the turn's Steps.
      store.appendMessage(sid, msg);
      const label =
        msg.payload.content ??
        (msg.payload.kind === 'no_reply' ? 'No reply' : 'System notice');
      updatePreview(sid, { text: truncPreview(label), type: 'agent', timestamp: msg.timestamp }, !replaying);
      break;
    }

    case 'idle': {
      const idled = store.sessions.get(sid);
      if (idled) store.upsertSession({ ...idled, state: 'idle' });
      store.appendMessage(sid, msg);
      // Extract usage from idle payload
      const idlePayload = (msg as IdleMessage).payload;
      const idleUsage = idlePayload?.usage;
      if (idleUsage) store.setSessionUsage(sid, idleUsage);
      const idleReason = idlePayload?.reason;
      // Don't update preview for aborted turns — the agent text is incomplete
      if (idleReason !== 'aborted') {
        const sessionMsgs = store.messages.get(sid);
        if (sessionMsgs) {
          for (let i = sessionMsgs.length - 1; i >= 0; i--) {
            const m = sessionMsgs[i];
            if (m.type === 'agent_message' && 'payload' in m) {
              const content = (m.payload as Record<string, unknown>).content;
              if (typeof content === 'string') {
                updatePreview(sid, { text: truncPreview(content), type: 'agent', timestamp: msg.timestamp }, !replaying);
              }
              break;
            }
            if (m.type === 'user_message' || m.type === 'idle') break;
          }
        }
      }
      if (!replaying && isViewingSession(sid) && document.hasFocus()) {
        import('./ws-client').then(({ wsClient }) => wsClient.markRead(sid)).catch(() => {});
      }
      // The turn just concluded — pull the authoritative TRACE for its bubble
      // once (reconciles/replaces whatever live steps we accumulated). Find the
      // concluding agent_message (the bubble that crystallized this turn).
      {
        const sessionMsgs = store.messages.get(sid);
        if (sessionMsgs) {
          for (let i = sessionMsgs.length - 1; i >= 0; i--) {
            const m = sessionMsgs[i];
            if (m.type === 'agent_message' && 'seq' in m) {
              const bubbleSeq = (m as { seq?: number }).seq;
              if (typeof bubbleSeq === 'number') {
                messageProvider.invalidateTurnTrace(sid, bubbleSeq);
                messageProvider.requestTurnTrace(sid, bubbleSeq);
              }
              break;
            }
            if (m.type === 'user_message' || m.type === 'idle') break;
          }
        }
      }
      break;
    }

    case 'active': {
      const activated = store.sessions.get(sid);
      if (activated) store.upsertSession({ ...activated, state: 'active' });
      store.appendMessage(sid, msg);
      break;
    }

    case 'session_mode_set': {
      // Skip our own echoes — mode was already applied optimistically
      if (ctx.cmdState.consumeModeEcho(sid)) break;
      const mode = (msg as SessionModeSetMessage).payload?.mode;
      if (mode === 'safe' || mode === 'discuss' || mode === 'execute' || mode === 'delegate') {
        store.setSessionMode(sid, mode);
      }
      break;
    }

    case 'session_title_updated': {
      const titleMsg = msg as SessionTitleUpdatedMessage;
      const session = store.sessions.get(sid);
      if (session) {
        store.upsertSession({
          ...session,
          title: titleMsg.payload.title,
          autoTitle: titleMsg.payload.autoTitle,
        });
      }
      break;
    }

    case 'session_model_set': {
      const { model } = (msg as SessionModelSetMessage).payload;
      if (model) {
        const session = store.sessions.get(sid);
        if (session) {
          store.upsertSession({ ...session, model });
        }
      }
      break;
    }

    case 'session_pinned': {
      const pinned = (msg as SessionPinnedMessage).payload?.pinned;
      const next = new Set(store.pinnedSessions);
      if (pinned) {
        next.add(sid);
      } else {
        next.delete(sid);
      }
      store.setPinnedSessions(next);
      break;
    }

    case 'session_read': {
      const readSeq = (msg as SessionReadMessage).payload?.seq;
      if (typeof readSeq === 'number' && !isViewingSession(sid)) {
        // Only clear unread up to the broadcast seq — keep unread for messages beyond it
        const msgs = store.messages.get(sid);
        if (msgs) {
          const maxLocalSeq = msgs.reduce((max, m) => {
            const s = 'seq' in m ? (m as { seq?: number }).seq ?? 0 : 0;
            return s > max ? s : max;
          }, 0);
          if (readSeq >= maxLocalSeq) {
            store.clearUnread(sid);
          }
        } else {
          store.clearUnread(sid);
        }
      }
      break;
    }

    case 'session_deleted': {
      store.removeSession(sid);
      break;
    }

    case 'user_message': {
      // Tentacle broadcasts `user_message` for every `send_input` it
      // receives, as round-trip confirmation. If our pending placeholder
      // is still around, we resolve it in place; otherwise we append
      // (covers history replays and messages from other devices).
      //
      // Resolution is by `clientId` round-tripped through tentacle. The
      // legacy fallback (first pending) handles older clients and
      // historical messages without clientId.
      const payload = (msg.payload ?? {}) as Record<string, unknown>;
      const clientId = typeof payload.clientId === 'string' ? payload.clientId : undefined;
      const serverContent = typeof payload.content === 'string' ? payload.content : undefined;
      traceEvent({ comp: 'arm', evt: 'APP-USER-MESSAGE-ECHO', sessionId: sid, clientId, contentLen: serverContent?.length });
      const resolved = store.resolvePendingInput(sid, msg.seq, clientId, serverContent);
      if (!resolved) {
        store.appendMessage(sid, msg);
      }
      if (serverContent !== undefined) {
        updatePreview(sid, { text: truncPreview(serverContent), type: 'user', timestamp: msg.timestamp }, false);
      }
      break;
    }

    // send_input is stored by the head but display is handled by user_message
    // (tentacle broadcasts user_message back as round-trip confirmation)
    case 'send_input':
      break;

    default:
      if ('payload' in msg) {
        store.appendMessage(sid, msg as Parameters<typeof store.appendMessage>[1]);
      }
      break;
  }
}
