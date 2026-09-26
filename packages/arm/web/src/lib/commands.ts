import { getStore } from './store-adapter';

/** Instance-scoped tracking for create_session requests. */
export class CommandState {
  readonly pendingPrompts = new Map<string, string>();
  readonly pendingCreateRequests = new Set<string>();
  /** Count of in-flight mode changes per session (for echo suppression). */
  readonly pendingModeChanges = new Map<string, number>();

  /** Optimistic actions awaiting a pulse ack, keyed by the pulse send seq.
   *  On ack → resolve() finalizes (drop tracking). On timeout → rollback(). */
  private pulsePending = new Map<bigint, { rollback: () => void; timer: ReturnType<typeof setTimeout> }>();

  /** Register an optimistic action tracked by its pulse seq. If no ack arrives
   *  within `timeoutMs`, `rollback` runs (revert UI + show error). */
  trackPulseSend(seq: bigint, rollback: () => void, timeoutMs = 10_000): void {
    const timer = setTimeout(() => {
      this.pulsePending.delete(seq);
      rollback();
    }, timeoutMs);
    this.pulsePending.set(seq, { rollback, timer });
  }

  /** The relay confirmed receipt up to `seqUpTo` — finalize those optimistic
   *  actions (cancel their rollback timers). */
  resolvePulseAcked(seqUpTo: bigint): void {
    for (const [seq, entry] of this.pulsePending) {
      if (seq <= seqUpTo) {
        clearTimeout(entry.timer);
        this.pulsePending.delete(seq);
      }
    }
  }

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

}

export function setSessionModel(
  sessionId: string,
  model: string,
  send: (msg: Record<string, unknown>) => void,
  reasoningEffort?: string,
  contextTier?: string,
): void {
  send({
    type: 'set_session_model',
    sessionId,
    payload: { model, ...(reasoningEffort && { reasoningEffort }), ...(contextTier && { contextTier }) },
  });
  // Optimistically update the local session model
  const store = getStore();
  const session = store.sessions.get(sessionId);
  if (session) {
    store.upsertSession({ ...session, model });
  }
}

export function createSession(
  opts: { targetDeviceId: string; model: string; reasoningEffort?: string; contextTier?: string; prompt?: string; cwd?: string; agentId?: string },
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
      ...(opts.contextTier && { contextTier: opts.contextTier }),
      // The first prompt is sent as an ordinary message once the session
      // exists (session_created), so it gets a bubble with delivery states.
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
