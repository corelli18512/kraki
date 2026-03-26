import type { InnerMessage } from '@kraki/protocol';
import { getStore, setStoreState } from './store-adapter';
import { isViewingSession } from './replay';
import type { CommandState } from './commands';
import { resolvePermissionMessage, resolveQuestionMessage } from './commands';
import type { PendingPermission, PendingQuestion } from '../types/store';

export interface RouterContext {
  replaying: boolean;
  cmdState: CommandState;
  /** Send an encrypted message back through the relay (for auto-approve in auto mode). */
  sendEncrypted?: (msg: Record<string, unknown>) => void;
  /** Called when tentacle signals replay is complete. */
  onReplayComplete?: () => void;
}

export function handleDataMessage(msg: InnerMessage, ctx: RouterContext): void {
  const store = getStore();

  // Track highest seq for replay requests after reconnect
  if (typeof msg.seq === 'number' && msg.seq > 0) {
    store.trackSeq(msg.seq);
  }

  // Handle replay_complete — tentacle finished replaying buffered messages
  if (msg.type === 'replay_complete') {
    ctx.onReplayComplete?.();
    return;
  }

  // Handle device_greeting before sessionId check (greetings have no sessionId)
  if (msg.type === 'device_greeting') {
    const greeting = (msg as any).payload;
    store.setDeviceOnline(msg.deviceId, true);
    if (greeting?.models) {
      store.setDeviceModels(msg.deviceId, greeting.models);
    }
    return;
  }

  if (!('sessionId' in msg) || !msg.sessionId) return;
  const sid = msg.sessionId;

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
      store.appendMessage(sid, msg);
      const reqId = (msg.payload as any).requestId;
      const wasOurRequest = reqId ? ctx.cmdState.pendingCreateRequests.delete(reqId) : false;
      // Show initial prompt as user message if we sent one via create_session
      const pendingPrompt = reqId ? ctx.cmdState.pendingPrompts.get(reqId) : undefined;
      if (pendingPrompt) {
        ctx.cmdState.pendingPrompts.delete(reqId);
        store.appendMessage(sid, {
          type: 'user_message',
          sessionId: sid,
          deviceId: '',
          seq: 0,
          timestamp: msg.timestamp,
          payload: { content: pendingPrompt },
        } as any);
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
      store.appendDelta(sid, msg.payload.content);
      break;
    }

    case 'agent_message': {
      store.flushDelta(sid);
      store.appendMessage(sid, msg);
      if (!ctx.replaying && !isViewingSession(sid)) store.incrementUnread(sid);
      break;
    }

    case 'error':
      store.flushDelta(sid);
      store.appendMessage(sid, msg);
      if (!ctx.replaying && !isViewingSession(sid)) store.incrementUnread(sid);
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
      if (!ctx.replaying && !isViewingSession(sid)) store.incrementUnread(sid);
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
      if (!ctx.replaying && !isViewingSession(sid)) store.incrementUnread(sid);
      break;
    }

    case 'idle': {
      const idled = store.sessions.get(sid);
      if (idled) store.upsertSession({ ...idled, state: 'idle' });
      store.flushDelta(sid);
      break;
    }

    case 'session_mode_set': {
      const mode = (msg as any).payload?.mode;
      if (mode === 'ask' || mode === 'auto') {
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
      store.resolvePendingInput(sid);
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
      // Merge tool_complete into the matching tool_start by toolCallId only
      const msgs = store.messages.get(sid);
      const toolCallId = (msg as any).payload?.toolCallId;
      if (msgs && toolCallId) {
        let idx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i] as any;
          if (m.type === 'tool_start' && m.payload?.toolCallId === toolCallId) {
            idx = i;
            break;
          }
        }
        if (idx >= 0) {
          const original = msgs[idx] as any;
          const updated = [...msgs];
          updated[idx] = {
            ...msg,
            payload: {
              ...(msg as any).payload,
              args: (msg as any).payload?.args && Object.keys((msg as any).payload.args).length > 0
                ? (msg as any).payload.args
                : original.payload?.args ?? {},
            },
          } as any;
          const next = new Map(store.messages);
          next.set(sid, updated);
          setStoreState({ messages: next });
          break;
        }
      }
      // Fallback: append if no matching tool_start found
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
