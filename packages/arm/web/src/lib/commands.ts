import type { PermissionRequest, QuestionRequest } from '@kraki/protocol';
import { getStore, setStoreState } from './store-adapter';

/** Instance-scoped tracking for create_session requests. */
export class CommandState {
  readonly pendingPrompts = new Map<string, string>();
  readonly pendingCreateRequests = new Set<string>();

  /** Clean up a failed request (called on server_error with requestId). */
  clearRequest(requestId: string): void {
    this.pendingPrompts.delete(requestId);
    this.pendingCreateRequests.delete(requestId);
  }
}

export function sendInput(
  sessionId: string,
  text: string,
  send: (msg: Record<string, unknown>) => void,
): void {
  const store = getStore();
  store.appendMessage(sessionId, {
    type: 'pending_input',
    id: `pending-${Date.now()}`,
    sessionId,
    text,
    timestamp: new Date().toISOString(),
  });
  send({
    type: 'send_input',
    sessionId,
    payload: { text },
  });
}

/** Stamp a resolution on the matching permission chat message. */
export function resolvePermissionMessage(
  sessionId: string,
  permissionId: string,
  resolution: 'approved' | 'denied' | 'always_allowed' | 'cancelled',
): void {
  const store = getStore();
  const msgs = store.messages.get(sessionId);
  if (!msgs) return;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.type === 'permission' && (m as PermissionRequest).payload?.id === permissionId) {
      const permMsg = m as PermissionRequest;
      const updated = [...msgs];
      updated[i] = { ...permMsg, payload: { ...permMsg.payload, resolution } } as typeof permMsg & { payload: typeof permMsg.payload & { resolution: string } };
      const next = new Map(store.messages);
      next.set(sessionId, updated);
      setStoreState({ messages: next });
      return;
    }
  }
}

/** Stamp the user's answer on the matching question chat message. */
export function resolveQuestionMessage(
  sessionId: string,
  questionId: string,
  answerText: string,
): void {
  const store = getStore();
  const msgs = store.messages.get(sessionId);
  if (!msgs) return;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.type === 'question' && (m as QuestionRequest).payload?.id === questionId) {
      const qMsg = m as QuestionRequest;
      const updated = [...msgs];
      updated[i] = { ...qMsg, payload: { ...qMsg.payload, answer: answerText } } as typeof qMsg & { payload: typeof qMsg.payload & { answer: string } };
      const next = new Map(store.messages);
      next.set(sessionId, updated);
      setStoreState({ messages: next });
      return;
    }
  }
}

export function approve(
  permissionId: string,
  sessionId: string,
  send: (msg: Record<string, unknown>) => void,
): void {
  send({
    type: 'approve',
    sessionId,
    payload: { permissionId },
  });
  getStore().removePermission(permissionId);
  resolvePermissionMessage(sessionId, permissionId, 'approved');
}

export function deny(
  permissionId: string,
  sessionId: string,
  send: (msg: Record<string, unknown>) => void,
): void {
  send({
    type: 'deny',
    sessionId,
    payload: { permissionId },
  });
  getStore().removePermission(permissionId);
  resolvePermissionMessage(sessionId, permissionId, 'denied');
}

export function alwaysAllow(
  permissionId: string,
  sessionId: string,
  send: (msg: Record<string, unknown>) => void,
  toolKind?: string,
): void {
  send({
    type: 'always_allow',
    sessionId,
    payload: { permissionId, toolKind },
  });
  getStore().removePermission(permissionId);
  resolvePermissionMessage(sessionId, permissionId, 'always_allowed');
}

export function answer(
  questionId: string,
  sessionId: string,
  answerText: string,
  send: (msg: Record<string, unknown>) => void,
): void {
  send({
    type: 'answer',
    sessionId,
    payload: { questionId, answer: answerText },
  });
  getStore().removeQuestion(questionId);
  resolveQuestionMessage(sessionId, questionId, answerText);
}

export function killSession(
  sessionId: string,
  send: (msg: Record<string, unknown>) => void,
): void {
  send({
    type: 'kill_session',
    sessionId,
    payload: {},
  });
}

export function abortSession(
  sessionId: string,
  send: (msg: Record<string, unknown>) => void,
): void {
  send({
    type: 'abort_session',
    sessionId,
    payload: {},
  });
}

export function setSessionMode(
  sessionId: string,
  mode: 'safe' | 'discuss' | 'execute' | 'delegate',
  send: (msg: Record<string, unknown>) => void,
): void {
  send({
    type: 'set_session_mode',
    sessionId,
    payload: { mode },
  });
  const store = getStore();
  store.setSessionMode(sessionId, mode);

  // Auto-approve pending permissions based on mode rules
  if (mode === 'execute' || mode === 'delegate') {
    // Execute/Delegate: approve all pending permissions
    const pending = [...store.pendingPermissions.values()].filter(
      (p) => p.sessionId === sessionId,
    );
    for (const perm of pending) {
      send({
        type: 'approve',
        sessionId,
        payload: { permissionId: perm.id },
      });
      store.removePermission(perm.id);
      resolvePermissionMessage(sessionId, perm.id, 'approved');
    }
  } else if (mode === 'discuss') {
    // Plan: approve non-write pending permissions, deny write
    const pending = [...store.pendingPermissions.values()].filter(
      (p) => p.sessionId === sessionId,
    );
    for (const perm of pending) {
      const isWrite = perm.toolName === 'write' || perm.toolName === 'write_file' ||
        perm.toolName === 'create' || perm.toolName === 'edit';
      const filePath = (perm.args.path ?? '') as string;
      const isPlanMd = filePath.endsWith('/plan.md') || filePath === 'plan.md';
      if (!isWrite || isPlanMd) {
        send({
          type: 'approve',
          sessionId,
          payload: { permissionId: perm.id },
        });
        store.removePermission(perm.id);
        resolvePermissionMessage(sessionId, perm.id, 'approved');
      } else {
        send({
          type: 'deny',
          sessionId,
          payload: { permissionId: perm.id },
        });
        store.removePermission(perm.id);
        resolvePermissionMessage(sessionId, perm.id, 'denied');
      }
    }
  }
}

export function createSession(
  opts: { targetDeviceId: string; model: string; reasoningEffort?: string; prompt?: string; cwd?: string },
  send: (msg: Record<string, unknown>) => void,
  state: CommandState,
): void {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  state.pendingCreateRequests.add(requestId);
  if (opts.prompt) {
    state.pendingPrompts.set(requestId, opts.prompt);
  }
  send({
    type: 'create_session',
    payload: {
      requestId,
      targetDeviceId: opts.targetDeviceId,
      model: opts.model,
      ...(opts.reasoningEffort && { reasoningEffort: opts.reasoningEffort }),
      prompt: opts.prompt,
      cwd: opts.cwd,
    },
  });
}

export function forkSession(
  sourceSessionId: string,
  send: (msg: Record<string, unknown>) => void,
  state: CommandState,
): void {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  state.pendingCreateRequests.add(requestId);
  send({
    type: 'fork_session',
    sessionId: sourceSessionId,
    payload: {
      requestId,
      sourceSessionId,
    },
  });
}
