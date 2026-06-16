import type { PermissionRequest, QuestionRequest } from '@kraki/protocol';
import { getStore, setStoreState } from './store-adapter';

/** Instance-scoped tracking for create_session requests. */
export class CommandState {
  readonly pendingPrompts = new Map<string, string>();
  readonly pendingCreateRequests = new Set<string>();
  /** Count of in-flight mode changes per session (for echo suppression). */
  readonly pendingModeChanges = new Map<string, number>();

  /** Clean up a failed request (called on server_error with requestId). */
  clearRequest(requestId: string): void {
    this.pendingPrompts.delete(requestId);
    this.pendingCreateRequests.delete(requestId);
  }

  /** Track an outgoing mode change so the echo can be suppressed. */
  trackModeChange(sessionId: string): void {
    this.pendingModeChanges.set(sessionId, (this.pendingModeChanges.get(sessionId) ?? 0) + 1);
  }

  /**
   * Consume one pending mode echo. Returns true if this was our own echo
   * (caller should skip it), false if it came from another source.
   */
  consumeModeEcho(sessionId: string): boolean {
    const count = this.pendingModeChanges.get(sessionId) ?? 0;
    if (count > 0) {
      if (count === 1) this.pendingModeChanges.delete(sessionId);
      else this.pendingModeChanges.set(sessionId, count - 1);
      return true;
    }
    return false;
  }
}

/** Generate a UUID v4. Prefers `crypto.randomUUID()` (only available
 *  in secure contexts), falls back to a `crypto.getRandomValues`-based
 *  RFC 4122 implementation when the app is served over HTTP (corporate
 *  intranet, local IP dev server, etc). Used for opaque correlation
 *  ids — not cryptographic-strength identifiers. */
function generateClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 from 16 random bytes.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

export function sendInput(
  sessionId: string,
  text: string,
  send: (msg: Record<string, unknown>) => void,
  attachments?: import('@kraki/protocol').Attachment[],
): void {
  const store = getStore();
  const timestamp = new Date().toISOString();
  // Generate a stable correlation id. Tentacle echoes this back inside
  // the resulting `user_message.payload.clientId`, letting us resolve
  // the right pending placeholder even with multiple in-flight sends,
  // reconnects, or multi-device scenarios.
  const clientId = generateClientId();
  store.appendMessage(sessionId, {
    type: 'pending_input',
    id: clientId,
    clientId,
    sessionId,
    text,
    timestamp,
    attachments,
  });
  // Update preview optimistically so session card reflects the sent message immediately
  store.setSessionPreview(sessionId, { text: text.slice(0, 80), type: 'user', timestamp });
  send({
    type: 'send_input',
    sessionId,
    payload: { text, clientId, ...(attachments?.length && { attachments }) },
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
  // Update preview optimistically so the question badge clears immediately
  if (answerText) {
    const timestamp = new Date().toISOString();
    getStore().setSessionPreview(sessionId, { text: answerText.slice(0, 80), type: 'answer', timestamp });
  }
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
  state?: CommandState,
): void {
  state?.trackModeChange(sessionId);
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

export function setSessionModel(
  sessionId: string,
  model: string,
  send: (msg: Record<string, unknown>) => void,
  reasoningEffort?: string,
): void {
  send({
    type: 'set_session_model',
    sessionId,
    payload: { model, ...(reasoningEffort && { reasoningEffort }) },
  });
  // Optimistically update the local session model
  const store = getStore();
  const session = store.sessions.get(sessionId);
  if (session) {
    store.upsertSession({ ...session, model });
  }
}

export function createSession(
  opts: { targetDeviceId: string; model: string; reasoningEffort?: string; prompt?: string; cwd?: string; agentId?: string },
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
      agentId: opts.agentId ?? 'copilot',
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

export function renameSession(
  sessionId: string,
  title: string,
  send: (msg: Record<string, unknown>) => void,
): void {
  // Optimistically update local store
  const store = getStore();
  const session = store.sessions.get(sessionId);
  if (session) {
    store.upsertSession({ ...session, title: title || undefined });
  }
  send({
    type: 'rename_session',
    sessionId,
    payload: { title },
  });
}

export function pinSession(
  sessionId: string,
  pinned: boolean,
  send: (msg: Record<string, unknown>) => void,
): void {
  // Optimistically update local store
  const store = getStore();
  const next = new Set(store.pinnedSessions);
  if (pinned) {
    next.add(sessionId);
  } else {
    next.delete(sessionId);
  }
  store.setPinnedSessions(next);
  send({
    type: 'pin_session',
    sessionId,
    payload: { pinned },
  });
}

export function requestLocalSessions(
  targetDeviceId: string,
  send: (msg: Record<string, unknown>) => void,
  filter?: { search?: string; liveOnly?: boolean; includeLinked?: boolean },
): string {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  getStore().setLocalSessionsLoading(true);
  send({
    type: 'request_local_sessions',
    payload: { requestId, targetDeviceId, filter },
  });
  return requestId;
}

export function importSession(
  localSessionId: string,
  targetDeviceId: string,
  send: (msg: Record<string, unknown>) => void,
  state: CommandState,
  meta?: { cwd?: string; summary?: string; source?: string; model?: string; branch?: string; startTime?: string },
): string {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  state.pendingCreateRequests.add(requestId);
  // Optimistic navigation — session ID is known (localSessionId)
  const store = getStore();
  store.addPendingSession(localSessionId);
  store.setNavigateToSession(localSessionId);
  send({
    type: 'import_session',
    payload: { requestId, localSessionId, targetDeviceId, ...(meta && { meta }) },
  });
  return requestId;
}
