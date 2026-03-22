import type { Message } from '@kraki/protocol';
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
}

export function handleHeadNotice(msg: Extract<Message, { type: 'head_notice' }>): void {
  const store = getStore();
  switch (msg.event) {
    case 'device_online':
      store.upsertDevice(msg.data.device);
      break;
    case 'device_offline':
      store.setDeviceOnline(msg.data.deviceId, false);
      break;
    case 'device_added':
      store.upsertDevice(msg.data.device);
      break;
    case 'device_removed':
      store.removeDevice(msg.data.deviceId);
      break;
    case 'session_updated':
      store.upsertSession(msg.data.session);
      break;
    case 'session_removed':
      store.removeSession(msg.data.sessionId);
      // Navigate away if currently viewing the deleted session
      if (store.activeSessionId === msg.data.sessionId) {
        window.history.replaceState({}, '', '/');
      }
      break;
    case 'read_state_updated':
      // Another device marked a session as read — clear our unread badge
      store.clearUnread(msg.data.sessionId);
      break;
  }
}

export function handleDataMessage(msg: Message, ctx: RouterContext): void {
  const store = getStore();
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
          type: 'user_message' as any,
          sessionId: sid,
          deviceId: '',
          seq: 0,
          channel: '',
          timestamp: msg.timestamp,
          payload: { content: pendingPrompt },
        });
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

      // Auto-approve if session is in auto mode (handles race with tentacle)
      const sessionMode = store.sessionModes.get(sid);
      if (sessionMode === 'auto' && !ctx.replaying && ctx.sendEncrypted) {
        ctx.sendEncrypted({
          type: 'approve',
          sessionId: sid,
          payload: { permissionId: perm.id },
        });
        store.appendMessage(sid, {
          ...msg,
          payload: { ...msg.payload, resolution: 'approved' },
        } as any);
        break;
      }

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
