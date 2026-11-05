import { toWireSessionMode, type SessionMode } from '@kraki/protocol';
import { t } from '../i18n';
import { getStore } from './store-adapter';

/** No session_created or error for a create/import this long: give up on it
 *  (iOS/Mac CommandSender.schedulePendingTimeout). */
export const CREATE_REQUEST_TIMEOUT_MS = 30_000;

/** Instance-scoped tracking for create_session requests. */
export class CommandState {
  readonly pendingPrompts = new Map<string, string>();
  readonly pendingCreateRequests = new Set<string>();
  /** Fork requests → their source session, to seed the fork's history. */
  readonly forkSources = new Map<string, string>();
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

  /** Clean up a failed request (called on server_error with requestId).
   *  The typed first message goes back to the New Session draft (as on
   *  iOS/Mac, CommandSender.failPendingRequest), instead of being lost. */
  clearRequest(requestId: string): void {
    const prompt = this.pendingPrompts.get(requestId);
    if (prompt !== undefined && this.pendingCreateRequests.has(requestId)) recoverNewSessionText(prompt);
    this.pendingPrompts.delete(requestId);
    this.pendingCreateRequests.delete(requestId);
    this.forkSources.delete(requestId);
  }

  /** A create/import still unanswered after CREATE_REQUEST_TIMEOUT_MS: its
   *  first message goes back to the draft (clearRequest), an import's pending
   *  page goes away, and the user is told. A late session_created still adds
   *  the session to the list, without sending the prompt or navigating. */
  expireRequestLater(requestId: string, pendingSessionId?: string): void {
    setTimeout(() => {
      if (!this.pendingCreateRequests.has(requestId)) return;
      this.clearRequest(requestId);
      const store = getStore();
      if (pendingSessionId) store.removePendingSession(pendingSessionId);
      store.setLastError(t('app:errors.requestTimedOut'));
    }, CREATE_REQUEST_TIMEOUT_MS);
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
  reason?: string,
): void {
  send({
    type: 'deny',
    sessionId,
    payload: { permissionId, ...(reason?.trim() && { reason: reason.trim() }) },
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
  mode: SessionMode,
  send: (msg: Record<string, unknown>) => void,
  state?: CommandState,
): void {
  state?.trackModeChange(sessionId);
  send({
    type: 'set_session_mode',
    sessionId,
    // Transition release: legacy wire name so older tentacles understand it.
    payload: { mode: toWireSessionMode(mode) },
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

/** Shared with NewSessionComposer (its draft id). */
export const NEW_SESSION_DRAFT_ID = 'kraki.new-session-draft';

/** Put text back into the New Session draft, after anything already typed
 *  there (CommandSender+VoiceHandoff.swift recoverNewSessionText). */
export function recoverNewSessionText(text: string): void {
  if (!text.trim()) return;
  const store = getStore();
  const existing = store.drafts.get(NEW_SESSION_DRAFT_ID) ?? '';
  store.setDraft(NEW_SESSION_DRAFT_ID, existing ? `${existing}\n${text}` : text);
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
  state.expireRequestLater(requestId);
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
  state.forkSources.set(requestId, sourceSessionId);
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

/** Longest a pin request waits for its `session_pinned` echo; after that a
 *  lost echo no longer hides pin changes made on other devices. */
export const PIN_ECHO_TIMEOUT_MS = 10_000;

/** Pin requests sent from this app whose echoes have not all come back. The
 *  Tentacle echoes every request in order, so under latency rapid toggles
 *  bring back superseded states that would make the row jump (K-207). */
const pendingPins = new Map<string, { echoes: number; pinned: boolean; sentAt: number }>();

function livePendingPin(sessionId: string) {
  const entry = pendingPins.get(sessionId);
  if (entry && Date.now() - entry.sentAt > PIN_ECHO_TIMEOUT_MS) {
    pendingPins.delete(sessionId);
    return undefined;
  }
  return entry;
}

/** The pin state this app last requested while echoes are outstanding. */
export function pendingPin(sessionId: string): boolean | undefined {
  return livePendingPin(sessionId)?.pinned;
}

/** A `session_pinned` arrived: false while it is the echo of a superseded
 *  request from this app (the last echo, or any other change, applies). */
export function settlePinEcho(sessionId: string): boolean {
  const entry = livePendingPin(sessionId);
  if (!entry) return true;
  entry.echoes -= 1;
  if (entry.echoes > 0) return false;
  pendingPins.delete(sessionId);
  return true;
}

export function resetPendingPins(): void {
  pendingPins.clear();
}

export function pinSession(
  sessionId: string,
  pinned: boolean,
  send: (msg: Record<string, unknown>) => void,
): void {
  const pending = livePendingPin(sessionId);
  pendingPins.set(sessionId, { echoes: (pending?.echoes ?? 0) + 1, pinned, sentAt: Date.now() });
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

/** Archive or restore a session (F2). */
export function archiveSession(
  sessionId: string,
  archived: boolean,
  send: (msg: Record<string, unknown>) => void,
): void {
  send({ type: 'archive_session', sessionId, payload: { archived } });
}

/** Ask a computer for its archived sessions (answered by archived_session_list). */
export function requestArchivedSessions(
  targetDeviceId: string,
  send: (msg: Record<string, unknown>) => void,
): void {
  send({ type: 'request_archived_sessions', payload: { targetDeviceId } });
}

/** Delete every archived session on a computer. */
export function deleteArchivedSessions(
  targetDeviceId: string,
  send: (msg: Record<string, unknown>) => void,
): void {
  send({ type: 'delete_archived_sessions', payload: { targetDeviceId } });
}

/** Days without messages before a computer archives a session; 0 = never. */
export function setAutoArchiveDays(
  targetDeviceId: string,
  days: number,
  send: (msg: Record<string, unknown>) => void,
): void {
  send({ type: 'set_auto_archive_days', payload: { targetDeviceId, days } });
}

/** Ask a computer to update Kraki (remote update). */
export function updateDevice(
  targetDeviceId: string,
  requestId: string,
  when: 'now' | 'idle' | undefined,
  send: (msg: Record<string, unknown>) => void,
): void {
  send({ type: 'update_device', payload: { targetDeviceId, requestId, ...(when ? { when } : {}) } });
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
  state.expireRequestLater(requestId, localSessionId);
  send({
    type: 'import_session',
    payload: { requestId, localSessionId, targetDeviceId, ...(meta && { meta }) },
  });
  return requestId;
}
