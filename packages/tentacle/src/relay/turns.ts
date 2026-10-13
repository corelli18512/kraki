/** Inputs and turns: admitting send_input (ledger, fingerprints), dispatching to the agent, steering, idle, compaction, finishing a turn. */

import { createHash } from 'node:crypto';
import type { CardActionState, IdleMessage } from '@kraki/protocol';
import { type InputLedgerEntry } from '../session-manager.js';
import type { RelayClient } from '../relay-client.js';
import { recordTrace } from './adapter-events.js';
import { clearOpenQuestions, soleOpenQuestion } from './questions.js';
import { maybeGenerateTitle } from './session-commands.js';
import { logger, traceLog } from './shared.js';

export function beginAdapterTurn(client: RelayClient, sessionId: string, turnId?: string): string {
  const resolvedTurnId = turnId ?? `${sessionId}:${(client.nextInputTurnAnchors.get(sessionId) ?? 0) + 1}`;
  if (!turnId) client.nextInputTurnAnchors.set(sessionId, (client.nextInputTurnAnchors.get(sessionId) ?? 0) + 1);
  client.activeInputTurnIds.set(sessionId, resolvedTurnId);
  client.adapter.setTurnIdentity?.(sessionId, resolvedTurnId);
  return resolvedTurnId;
}

/** A terminal adapter event must identify the accepted turn it belongs to.
 *  Legacy adapters/tests may omit the token; those events retain the old
 *  fallback behavior, while tokenized events are strictly fenced. */
export function acceptsAdapterTurn(client: RelayClient, sessionId: string, turnId?: string): boolean {
  if (!turnId) return true;
  const activeTurnId = client.activeInputTurnIds.get(sessionId);
  if (activeTurnId === turnId) return true;
  traceLog.info({
    ns: process.hrtime.bigint().toString(),
    comp: 'tentacle',
    evt: 'ADAPTER-LATE-CALLBACK',
    sessionId,
    turnId,
    activeTurnId,
  });
  return false;
}

/** Non-terminal events must not mutate a turn after its terminal boundary.
 * Legacy untagged callbacks retain compatibility; real adapters tag every
 * turn-scoped event so a same-turn late callback is rejected here. */
export function acceptsAdapterEvent(client: RelayClient, sessionId: string, turnId?: string): boolean {
  if (!acceptsAdapterTurn(client, sessionId, turnId)) return false;
  if (turnId && client.settledAdapterTurnIds.get(sessionId) === turnId) {
    traceLog.info({
      ns: process.hrtime.bigint().toString(),
      comp: 'tentacle',
      evt: 'ADAPTER-SETTLED-CALLBACK',
      sessionId,
      turnId,
    });
    return false;
  }
  return true;
}

export function inputFingerprint(
  client: RelayClient,
  text: string,
  attachments?: import('@kraki/protocol').Attachment[],
): { contentLength: number; contentHash: string } {
  const attachmentShape = (attachments ?? []).map((attachment) => ({
    type: attachment.type,
    mimeType: 'mimeType' in attachment ? attachment.mimeType : undefined,
    id: 'id' in attachment ? attachment.id : undefined,
    size: 'size' in attachment ? attachment.size : undefined,
    data: 'data' in attachment ? attachment.data : undefined,
  }));
  const content = JSON.stringify({ text, attachments: attachmentShape });
  return {
    contentLength: text.length,
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
}

export function reserveInput(
  client: RelayClient,
  sessionId: string,
  clientId: string | undefined,
  requestedDelivery: 'prompt' | 'steer',
  text: string,
  attachments?: import('@kraki/protocol').Attachment[],
): { duplicate: boolean; conflict: boolean; recovery: boolean; effectiveDelivery: 'prompt' | 'steer'; turnId: string; entry?: InputLedgerEntry } {
  const meta = client.sessionManager.getMeta(sessionId);
  const adapterSettled = client.adapter.isTurnSettled?.(sessionId) === true;
  const staleSteer = requestedDelivery === 'steer'
    && (
      meta?.state === 'idle'
      || meta?.state === 'disconnected'
      || adapterSettled
    );
  if (requestedDelivery === 'steer' && adapterSettled && meta?.state === 'active') {
    // Reconcile a terminal callback that Relay missed before opening the new
    // prompt. Otherwise the prior normal-input chain remains blocked forever
    // waiting for an idle the adapter has already crossed.
    const settledTurnId = client.activeInputTurnIds.get(sessionId);
    settleAdapterIdle(client, sessionId, settledTurnId ? { turnId: settledTurnId } : undefined);
  }
  const effectiveDelivery = staleSteer ? 'prompt' : requestedDelivery;
  const proposedAnchor = effectiveDelivery === 'steer'
    ? (meta?.currentTurnStartSeq ?? meta?.lastSeq ?? 0)
    : (meta?.lastSeq ?? 0) + 1;
  const turnAnchor = effectiveDelivery === 'steer'
    ? proposedAnchor
    : Math.max(proposedAnchor, (client.nextInputTurnAnchors.get(sessionId) ?? 0) + 1);
  if (effectiveDelivery === 'prompt') client.nextInputTurnAnchors.set(sessionId, turnAnchor);
  // An accepted active-turn steer stays inside the provider run that is
  // already in flight. Reuse its identity so provider callbacks captured at
  // that run boundary remain admissible; only a stale steer opens a new turn.
  const turnId = effectiveDelivery === 'steer' && !staleSteer
    ? client.activeInputTurnIds.get(sessionId) ?? `${sessionId}:${turnAnchor}`
    : `${sessionId}:${turnAnchor}`;
  if (!clientId) return { duplicate: false, conflict: false, recovery: false, effectiveDelivery, turnId };

  const fingerprint = inputFingerprint(client, text, attachments);
  const ledgerEntries = client.sessionManager.getInputLedger?.(sessionId) ?? [];
  const existing = client.sessionManager.getInputLedgerEntry?.(sessionId, clientId)
    ?? ledgerEntries.find((entry) => entry.clientId === clientId)
    ?? null;
  if (existing) {
    if (existing.contentHash !== fingerprint.contentHash) {
      return { duplicate: true, conflict: true, recovery: false, effectiveDelivery, turnId };
    }
    // Admitted by this process: it is queued or running right now. A client
    // retry (lost echo, reconnect) must not dispatch it a second time; the
    // recovery paths below are only for entries left by a previous process.
    if (client.admittedInputs.has(`${sessionId}\u0000${clientId}`) && existing.status !== 'rejected') {
      return { duplicate: true, conflict: false, recovery: false, effectiveDelivery, turnId, entry: existing };
    }
    // `persisted` means the user_message is durable but adapter dispatch has
    // not started. It is the only restart state that is safe to recover by
    // sending the replayed payload again. `dispatching` is deliberately
    // treated as at-most-once: the daemon may have crossed the adapter
    // boundary before it crashed, so replaying it could duplicate the turn.
    if ((existing.status === 'persisted' || existing.status === 'rejected') && existing.userSeq !== undefined) {
      // A rejected adapter call is known not to have been acknowledged. The
      // transcript row already exists, so retry the same clientId without
      // appending another user_message. `dispatching` remains at-most-once:
      // a crash may have crossed the adapter boundary before the state write.
      client.admittedInputs.add(`${sessionId}\u0000${clientId}`);
      return { duplicate: false, conflict: false, recovery: true, effectiveDelivery: existing.delivery === 'steer' ? 'steer' : 'prompt', turnId: existing.turnId, entry: existing };
    }
    if (existing.status === 'pending') {
      const recoveredSeq = client.sessionManager.findUserMessageSeqByClientId(sessionId, clientId);
      if (recoveredSeq !== null) {
        const recovered: InputLedgerEntry = {
          ...existing,
          status: 'persisted',
          userSeq: recoveredSeq,
          updatedAt: new Date().toISOString(),
        };
        client.sessionManager.recordInputLedger(sessionId, recovered);
        client.admittedInputs.add(`${sessionId}\u0000${clientId}`);
      return { duplicate: false, conflict: false, recovery: true, effectiveDelivery: recovered.delivery === 'steer' ? 'steer' : 'prompt', turnId: recovered.turnId, entry: recovered };
      }
      // The reservation survived but the transcript append did not. Reuse
      // its identity and perform the normal persistence path exactly once.
      client.admittedInputs.add(`${sessionId}\u0000${clientId}`);
      return { duplicate: false, conflict: false, recovery: false, effectiveDelivery: existing.delivery === 'steer' ? 'steer' : 'prompt', turnId: existing.turnId, entry: existing };
    }
    return { duplicate: true, conflict: false, recovery: false, effectiveDelivery, turnId, entry: existing };
  }

  // Only legacy sessions with no ledger need the compatibility transcript
  // scan. Once the durable index exists, the hot input path is O(1) in the
  // number of historical messages.
  const recoveredSeq = ledgerEntries.length === 0
    ? client.sessionManager.findUserMessageSeqByClientId(sessionId, clientId)
    : null;
  if (recoveredSeq !== null) {
    const recovered: InputLedgerEntry = {
      version: 1,
      clientId,
      status: 'persisted',
      requestedDelivery,
      delivery: effectiveDelivery,
      turnId,
      contentLength: fingerprint.contentLength,
      contentHash: fingerprint.contentHash,
      userSeq: recoveredSeq,
      updatedAt: new Date().toISOString(),
    };
    client.sessionManager.recordInputLedger(sessionId, recovered);
    // Without a matching ledger entry we cannot prove the replayed body is
    // the original body, so preserve at-most-once behavior for legacy data.
    return { duplicate: true, conflict: false, recovery: false, effectiveDelivery, turnId, entry: recovered };
  }

  const entry: InputLedgerEntry = {
    version: 1,
    clientId,
    status: 'pending',
    requestedDelivery,
    delivery: effectiveDelivery,
    turnId,
    contentLength: fingerprint.contentLength,
    contentHash: fingerprint.contentHash,
    updatedAt: new Date().toISOString(),
  };
  client.sessionManager.recordInputLedger(sessionId, entry);
  client.admittedInputs.add(`${sessionId}\u0000${clientId}`);
  return { duplicate: false, conflict: false, recovery: false, effectiveDelivery, turnId, entry };
}

export function updateInputLedger(
  client: RelayClient,
  sessionId: string,
  clientId: string | undefined,
  status: InputLedgerEntry['status'],
  userSeq?: number,
): void {
  if (!clientId) return;
  const existing = client.sessionManager.getInputLedgerEntry(sessionId, clientId);
  if (!existing) return;
  client.sessionManager.recordInputLedger(sessionId, {
    ...existing,
    status,
    ...(userSeq !== undefined && { userSeq }),
    updatedAt: new Date().toISOString(),
  });
}

export function waitForTurnIdle(client: RelayClient, sessionId: string): Promise<void> {
  const existing = client.turnIdleWaiters.get(sessionId);
  if (existing) return existing.promise;
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  client.turnIdleWaiters.set(sessionId, { promise, resolve });
  return promise;
}

export function resolveTurnIdle(client: RelayClient, sessionId: string): void {
  // A terminal turn boundary also retires its transport-acceptance gate. Pi
  // can acknowledge abort while an older prompt RPC is still waiting behind
  // preflight compaction; that stale Promise must not serialize later input.
  // The underlying task remains observed and is fenced by its turn identity
  // if it ever completes, while a new dispatch may start immediately.
  client.inputDispatches.delete(sessionId);
  const waiter = client.turnIdleWaiters.get(sessionId);
  if (!waiter) return;
  client.turnIdleWaiters.delete(sessionId);
  waiter.resolve();
}

export function beginSteerAcceptance(client: RelayClient, sessionId: string): void {
  client.steerAcceptanceInFlight.add(sessionId);
}

export function finishSteerAcceptance(client: RelayClient, sessionId: string, accepted: boolean): void {
  client.steerAcceptanceInFlight.delete(sessionId);
  const deferredIdle = client.idleDuringSteerAcceptance.delete(sessionId);
  if (!deferredIdle) return;
  if (accepted) {
    // The old provider error was already broadcast immediately. A successful
    // interjection recovered the session, so it must not freeze as the outcome
    // of the newer work when that work eventually idles.
    client.pendingTerminalErrors.delete(sessionId);
  } else {
    settleAdapterIdle(client, sessionId);
  }
}

export function settleAdapterIdle(client: RelayClient, sessionId: string, event?: { turnId?: string }): void {
  if (!acceptsAdapterTurn(client, sessionId, event?.turnId)) return;
  // Tokenized callbacks use their source identity. Only legacy callbacks fall
  // back to the currently active relay turn.
  const turnId = event?.turnId ?? client.activeInputTurnIds.get(sessionId);
  const idleTurnId = turnId ?? '__unidentified__';
  if (client.settledAdapterTurnIds.get(sessionId) === idleTurnId) return;
  const stagedError = client.pendingTerminalErrors.get(sessionId);
  const terminalError = stagedError && (!stagedError.turnId || stagedError.turnId === idleTurnId)
    ? stagedError
    : undefined;
  if (stagedError?.turnId && stagedError.turnId !== idleTurnId) {
    client.pendingTerminalErrors.delete(sessionId);
  }
  if (soleOpenQuestion(client, sessionId) && !terminalError) return;
  client.settledAdapterTurnIds.set(sessionId, idleTurnId);
  client.errorPersistedForTurn.delete(sessionId);
  if (turnId) {
    client.sessionManager.markInputLedgerSettled(sessionId, turnId);
    traceLog.info({
      ns: process.hrtime.bigint().toString(),
      comp: 'tentacle',
      evt: 'INPUT-SETTLED',
      sessionId,
      turnId,
      willRetry: false,
    });
  }
  if (terminalError) {
    client.pendingTerminalErrors.delete(sessionId);
    const { turnId: _turnId, ...terminalPayload } = terminalError;
    finishTurnWithStatus(client, sessionId, {
      type: 'failed',
      payload: {
        ...terminalPayload,
        failedAt: new Date().toISOString(),
      },
    });
  } else {
    clearOpenQuestions(client, sessionId);
    anchorStepsOnlyTurn(client, sessionId);
  }
  resolveTurnIdle(client, sessionId);
  client.sessionManager.markIdle(sessionId);
  // Compaction is an orthogonal maintenance axis. A successful turn may be
  // idle while threshold/manual compaction continues; its own end event clears
  // the runtime indicator. Overflow recovery never reaches this idle path.
  const usage = client.adapter.getSessionUsage(sessionId) ?? undefined;
  if (usage) client.sessionManager.setUsage(sessionId, usage);
  sendTurnIdle(client, 
    sessionId,
    { usage, ...(terminalError && { reason: 'failed' as const }) },
    terminalError ? { failure: terminalError.message } : {},
  );
  // The closing idle changes the turn boundary — the agent reply / terminal
  // outcome now replaces the user_message as the preview anchor. Broadcast so
  // every arm's digest-derived preview advances authoritatively. Without this
  // a question/permission-less turn would never refresh the sidebar preview
  // (broadcastSessionList otherwise only fires on question/permission events).
  client.broadcastSessionList();
  maybeGenerateTitle(client, sessionId);
}

/** A turn that ended on tool calls with no closing prose is relayed as-is:
 *  it has Steps but no reply. Give those Steps a spine anchor (protocol
 *  SystemMessage kind `no_reply`, which clients render as a steps-only
 *  section) — for every agent alike, instead of each adapter improvising. */
export function anchorStepsOnlyTurn(client: RelayClient, sessionId: string): void {
  if (client.turnHasOutcome.has(sessionId)) return;
  if ((client.turnStepCounts.get(sessionId) ?? 0) === 0) return;
  client.card.onBubble(sessionId);
  client.send({ type: 'system_message', sessionId, payload: { kind: 'no_reply' } });
}

/** Persist the durable user-visible outputs of a genuine completed turn on
 *  its closing idle. Initialization/import/fork idles deliberately bypass
 *  this helper because they do not close a user turn. */
export function sendTurnIdle(
  client: RelayClient,
  sessionId: string,
  payload: Omit<IdleMessage['payload'], 'turnArtifacts'>,
  push: { failure?: string } | null = {},
): void {
  const turnArtifacts = client.sessionManager.readCurrentTurnArtifacts(sessionId);
  if (push) client.closingTurnPush.set(sessionId, push);
  else client.closingTurnPush.delete(sessionId);
  client.send({
    type: 'idle',
    sessionId,
    payload: {
      ...payload,
      ...(turnArtifacts.length > 0 && { turnArtifacts }),
    },
  }, payload.reason !== 'aborted');
  client.closingTurnPush.delete(sessionId);
}

export function dispatchInput(client: RelayClient, sessionId: string, task: () => Promise<void>): Promise<void> {
  const previous = client.inputDispatches.get(sessionId);
  const next = previous ? previous.catch(() => {}).then(task) : task();
  client.inputDispatches.set(sessionId, next);
  const cleanup = () => {
    if (client.inputDispatches.get(sessionId) === next) client.inputDispatches.delete(sessionId);
  };
  next.then(cleanup, cleanup);
  return next;
}

/** Enter/leave transient compaction maintenance. This no longer overwrites
 *  the conversational session state: a completed turn may stay `idle` while
 *  threshold compaction runs, keeping the composer available. */
export function setCompacting(client: RelayClient, sessionId: string, active: boolean, reason?: 'manual' | 'threshold' | 'overflow'): void {
  if (active) {
    if (!client.compactingSessions.has(sessionId)) {
      client.compactingSessions.set(sessionId, reason);
      client.send({ type: 'compacting', sessionId, payload: { phase: 'start', ...(reason && { reason }) } });
    }
  } else if (client.compactingSessions.delete(sessionId)) {
    client.compactionTurnIds.delete(sessionId);
    const queued = client.maintenanceFollowUps.get(sessionId);
    const activate = queued?.accepted === true;
    const metaState = client.sessionManager.getMeta(sessionId)?.state;
    const nextState = activate || metaState === 'active' ? 'active' : 'idle';
    if (activate) {
      client.maintenanceFollowUps.delete(sessionId);
      client.sessionManager.markActive(sessionId);
    }
    client.send({ type: 'compacting', sessionId, payload: { phase: 'end', nextState } });
    if (activate) client.send({ type: 'active', sessionId, payload: {} });
  }
}

export function acceptMaintenanceFollowUp(client: RelayClient, sessionId: string): void {
  const queued = client.maintenanceFollowUps.get(sessionId);
  if (!queued) return;
  queued.accepted = true;
  if (!client.compactingSessions.has(sessionId)) {
    client.maintenanceFollowUps.delete(sessionId);
    client.sessionManager.markActive(sessionId);
    client.send({ type: 'active', sessionId, payload: {} });
  }
}

/** Clear stale compacting for a session (idle / active turn start / end /
 *  process loss). Safe no-op when not compacting. */
export function clearCompacting(client: RelayClient, sessionId: string): void {
  setCompacting(client, sessionId, false);
}

/** Freeze the live card into a durable terminal status and close every
 *  unfinished TRACE action with the appropriate non-success outcome. */
export function finishTurnWithStatus(
  client: RelayClient,
  sessionId: string,
  action: Extract<CardActionState, { type: 'user_abort' | 'failed' }>,
): void {
  const termination = action.type === 'user_abort' ? 'cancelled' : 'interrupted';
  const snapshot = client.card.terminate(sessionId, action);

  for (const tool of snapshot.runningTools) {
    recordTrace(client, {
      type: 'tool_complete',
      sessionId,
      payload: {
        ...tool.payload,
        success: false,
        termination,
        ...(tool.payload.subagent && { subagent: { ...tool.payload.subagent, status: termination === 'cancelled' ? 'stopped' : 'failed' } }),
      },
    });
    const id = tool.payload.toolCallId;
    if (id) {
      client.lastArgsByToolCallId.delete(id);
      client.lastArgsRefByToolCallId.delete(id);
    }
  }
  client.sessionToolCallIds.delete(sessionId);

  if (snapshot.previousAction?.type === 'permission' && !snapshot.previousAction.payload.decision) {
    recordTrace(client, {
      type: 'permission',
      sessionId,
      payload: { ...snapshot.previousAction.payload, cancelled: true },
    });
  }
  for (const prompt of snapshot.queuedPrompts) {
    recordTrace(client, { type: 'permission', sessionId, payload: { ...prompt.payload, cancelled: true } });
  }

  const finishedAt = action.type === 'user_abort' ? action.payload.abortedAt : action.payload.failedAt;
  const steps = client.turnStepCounts.get(sessionId) ?? 0;
  client.send({
    type: 'turn_status',
    sessionId,
    payload: { draft: snapshot.draft, action, finishedAt, steps },
  }, action.type === 'failed');
  clearOpenQuestions(client, sessionId);
  client.card.clear(sessionId);
}

/** Drop any in-flight toolCallId state for a session — called when a
 *  session ends or is deleted. Without this, the toolCallId-keyed
 *  `lastArgs*` maps would leak entries for any tool call that didn't
 *  receive a matching `tool_complete` before the session went away. */
export function purgeSessionToolState(client: RelayClient, sessionId: string): void {
  client.errorPersistedForTurn.delete(sessionId);
  clearOpenQuestions(client, sessionId);
  client.turnStepCounts.delete(sessionId);
  const inflight = client.sessionToolCallIds.get(sessionId);
  if (!inflight) return;
  for (const id of inflight) {
    client.lastArgsByToolCallId.delete(id);
    client.lastArgsRefByToolCallId.delete(id);
  }
  client.sessionToolCallIds.delete(sessionId);
}

/** Unicast the persisted user_message for `clientId` back to `deviceId`. */
export function reechoInput(client: RelayClient, deviceId: string, sessionId: string, clientId: string): void {
  const key = client.consumerKeys.get(deviceId);
  const seq = client.sessionManager.findUserMessageSeqByClientId(sessionId, clientId);
  // Each early return leaves the sender's input unconfirmed; say why.
  if (!key || seq === null) {
    logger.warn({ sessionId, deviceId, clientId, reason: !key ? 'no_consumer_key' : 'no_user_message' }, 'Cannot re-echo duplicate input');
    return;
  }
  const [row] = client.sessionManager.getMessagesAfterSeq(sessionId, seq - 1, 1);
  if (!row || row.seq !== seq) {
    logger.warn({ sessionId, deviceId, clientId, seq, rowSeq: row?.seq ?? null }, 'Cannot re-echo duplicate input: row mismatch');
    return;
  }
  try {
    const message = JSON.parse(row.payload) as Record<string, unknown>;
    message.seq = row.seq;
    if (!message.timestamp) message.timestamp = row.ts;
    if (!message.sessionId) message.sessionId = sessionId;
    client.sendReliableUnicastTo(deviceId, key, message);
    logger.info({ sessionId, deviceId, seq }, 'Re-echoed duplicate input');
  } catch (err) {
    logger.warn({ err, sessionId, seq }, 'Could not re-echo duplicate input');
  }
}
