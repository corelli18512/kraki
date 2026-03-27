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
  resolution: 'approved' | 'denied' | 'always_allowed',
): void {
  const store = getStore();
  const msgs = store.messages.get(sessionId);
  if (!msgs) return;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as any;
    if (m.type === 'permission' && m.payload?.id === permissionId) {
      const updated = [...msgs];
      updated[i] = { ...m, payload: { ...m.payload, resolution } };
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
    const m = msgs[i] as any;
    if (m.type === 'question' && m.payload?.id === questionId) {
      const updated = [...msgs];
      updated[i] = { ...m, payload: { ...m.payload, answer: answerText } };
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
  mode: 'safe' | 'plan' | 'execute' | 'delegate',
  send: (msg: Record<string, unknown>) => void,
): void {
  send({
    type: 'set_session_mode',
    sessionId,
    payload: { mode },
  });
  const store = getStore();
  store.setSessionMode(sessionId, mode);

  // When switching to execute or delegate, auto-approve all pending permissions
  if (mode === 'execute' || mode === 'delegate') {
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
  }
}

export function createSession(
  opts: { targetDeviceId: string; model: string; prompt?: string; cwd?: string },
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
      prompt: opts.prompt,
      cwd: opts.cwd,
    },
  });
}
