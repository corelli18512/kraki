import type { InnerMessage, SessionListMessage, SessionReplayBatchMessage, DeviceGreetingMessage, SessionModeSetMessage, PermissionResolvedMessage, ProducerMessage, QuestionResolvedMessage } from '@kraki/protocol';
import { getStore } from './store-adapter';
import { isViewingSession } from './replay';
import { createLogger } from './logger';
import type { CommandState } from './commands';
import { resolvePermissionMessage, resolveQuestionMessage } from './commands';
import { messageProvider } from './message-provider';
import type { PendingPermission, PendingQuestion } from '../types/store';

const logger = createLogger('msg-router');

export interface RouterContext {
  cmdState: CommandState;
  /** Send an encrypted message back through the relay (for auto-approve in auto mode). */
  sendEncrypted?: (msg: Record<string, unknown>) => void;
  /** Called when tentacle sends session_list for sync. */
  onSessionList?: (msg: SessionListMessage) => void;
  /** Called when tentacle sends a replay batch. */
  onSessionReplayBatch?: (msg: SessionReplayBatchMessage) => void;
}

export function handleDataMessage(msg: InnerMessage, ctx: RouterContext): void {
  const store = getStore();

  // Debug: log all incoming message types
  if (msg.type === 'agent_message_delta') {
    logger.info('handleDataMessage: delta arrived', { type: msg.type, sessionId: 'sessionId' in msg ? msg.sessionId : undefined });
  }

  // Handle session_list — tentacle's authoritative session metadata
  if (msg.type === 'session_list') {
    ctx.onSessionList?.(msg);
    return;
  }

  // Handle session_replay_batch — tentacle sent a batch of replayed messages
  if (msg.type === 'session_replay_batch') {
    ctx.onSessionReplayBatch?.(msg as SessionReplayBatchMessage);
    return;
  }

  // Handle device_greeting before sessionId check (greetings have no sessionId)
  if (msg.type === 'device_greeting') {
    const greeting = (msg as DeviceGreetingMessage).payload;
    store.setDeviceOnline(msg.deviceId, true);
    if (greeting?.models) {
      store.setDeviceModels(msg.deviceId, greeting.models);
    }
    if (greeting?.modelDetails) {
      store.setDeviceModelDetails(msg.deviceId, greeting.modelDetails);
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
      const lastSeq = (msg.payload as Record<string, unknown>).lastSeq as number | undefined;
      const enriched = lastSeq && lastSeq > 0 ? { ...msg, payload: { ...msg.payload, forked: true } } : msg;
      store.appendMessage(sid, enriched);
      // Set tentacle info so message provider can route replay requests
      messageProvider.setTentacleInfo(sid, lastSeq ?? 0, msg.deviceId);
      if (lastSeq && lastSeq > 0) {
        messageProvider.requestLatest(sid);
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
      store.flushDelta(sid);
      store.appendMessage(sid, msg);
      break;
    }

    case 'agent_message_delta': {
      logger.info('delta received', { sessionId: sid, contentLen: msg.payload.content?.length });
      store.appendDelta(sid, msg.payload.content);
      break;
    }

    case 'agent_message': {
      logger.info('agent_message received', { sessionId: sid, contentLen: msg.payload.content?.length });
      store.flushDelta(sid);
      store.appendMessage(sid, msg);
      break;
    }

    case 'error':
      store.flushDelta(sid);
      store.appendMessage(sid, msg);
      break;

    case 'permission': {
      const perm: PendingPermission = {
        id: msg.payload.id,
        sessionId: sid,
        toolName: msg.payload.toolName,
        args: msg.payload.args as Record<string, unknown>,
        description: msg.payload.description,
        timestamp: msg.timestamp,
      };

      store.addPermission(perm);
      store.appendMessage(sid, msg);
      break;
    }

    case 'question': {
      const q: PendingQuestion = {
        id: msg.payload.id,
        sessionId: sid,
        question: msg.payload.question,
        choices: msg.payload.choices,
        timestamp: msg.timestamp,
      };
      store.addQuestion(q);
      store.appendMessage(sid, msg);
      break;
    }

    case 'idle': {
      const idled = store.sessions.get(sid);
      if (idled) store.upsertSession({ ...idled, state: 'idle' });
      store.flushDelta(sid);
      store.appendMessage(sid, msg);
      // Only visible chat bubbles count as unread — idle marks a completed turn
      if (!replaying && !isViewingSession(sid)) store.incrementUnread(sid);
      break;
    }

    case 'active': {
      const activated = store.sessions.get(sid);
      if (activated) store.upsertSession({ ...activated, state: 'active' });
      store.appendMessage(sid, msg);
      break;
    }

    case 'session_mode_set': {
      const mode = (msg as SessionModeSetMessage).payload?.mode;
      if (mode === 'safe' || mode === 'discuss' || mode === 'execute' || mode === 'delegate') {
        store.setSessionMode(sid, mode);
      }
      break;
    }

    case 'session_deleted': {
      store.removeSession(sid);
      break;
    }

    // Resolve permissions/questions on replay (approve/deny/always_allow/answer)
    // Merge the resolution into the original permission message so the bubble
    // shows the grant result with the full tool description.
    case 'approve':
    case 'deny':
    case 'always_allow': {
      const permId = msg.payload?.permissionId;
      if (permId) {
        store.removePermission(permId);
        const resolution: 'approved' | 'denied' | 'always_allowed' =
          msg.type === 'approve' ? 'approved'
          : msg.type === 'deny' ? 'denied'
          : 'always_allowed';
        resolvePermissionMessage(sid, permId, resolution);
      }
      break;
    }

    case 'permission_resolved': {
      const resolvedMsg = msg as PermissionResolvedMessage;
      const permId = resolvedMsg.payload?.permissionId;
      const resolution = resolvedMsg.payload?.resolution;
      if (permId && resolution) {
        store.removePermission(permId);
        resolvePermissionMessage(sid, permId, resolution);
      }
      store.appendMessage(sid, msg);
      break;
    }

    case 'question_resolved': {
      const resolvedQMsg = msg as QuestionResolvedMessage;
      const qId = resolvedQMsg.payload?.questionId;
      const qAnswer = resolvedQMsg.payload?.answer;
      if (qId) {
        store.removeQuestion(qId);
        resolveQuestionMessage(sid, qId, qAnswer);
      }
      store.appendMessage(sid, msg);
      break;
    }

    case 'answer': {
      const qId = msg.payload?.questionId;
      if (qId) {
        store.removeQuestion(qId);
        resolveQuestionMessage(sid, qId, msg.payload?.answer as string);
      }
      store.appendMessage(sid, msg);
      break;
    }

    case 'user_message': {
      // Resolve pending_input when tentacle confirms receipt via user_message broadcast
      const hadPending = store.messages.get(sid)?.some((m) => m.type === 'pending_input');
      store.resolvePendingInput(sid, msg.seq);
      if (!hadPending) {
        store.appendMessage(sid, msg);
      }
      break;
    }

    // send_input is stored by the head but display is handled by user_message
    // (tentacle broadcasts user_message back as round-trip confirmation)
    case 'send_input':
      break;

    case 'tool_complete': {
      store.appendMessage(sid, msg);
      break;
    }

    default:
      if ('payload' in msg) {
        store.appendMessage(sid, msg as Parameters<typeof store.appendMessage>[1]);
      }
      break;
  }
}
