/** Messages from apps: validation and dispatch to the per-type handlers. */

import { normalizeSessionMode, toWireSessionMode } from '@kraki/protocol';
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseConsumerMessage } from '@kraki/protocol/schemas';
import { isSafeId } from '../session-manager.js';
import { getKrakiHome } from '../config.js';
import { RelayClient } from '../relay-client.js';
import { handleRefreshAccountUsage, handleRequestUsageHistory } from './account-usage.js';
import { handleRequestAttachment } from './attachments.js';
import { handleRequestCard, handleSessionMessages, handleSessionMessagesRange, handleSessionReplay, handleSetSessionSubscription, handleTurnTrace } from './history.js';
import { clearOpenQuestions, deliverQuestionAnswer, resolvePermission, soleOpenQuestion } from './questions.js';
import { deleteSessionEverywhere, handleCreateSession, handleDeleteArchivedSessions, handleForkSession, handleImportSession, handleRequestArchivedSessions, handleRequestLocalSessions, handleSetAutoArchiveDays, unarchiveOnUse } from './session-commands.js';
import { ensureSessionResumed, sendToAdapter } from './session-resume.js';
import { acceptMaintenanceFollowUp, acceptsAdapterEvent, beginAdapterTurn, beginSteerAcceptance, clearCompacting, dispatchInput, finishSteerAcceptance, finishTurnWithStatus, reechoInput, reserveInput, resolveTurnIdle, sendTurnIdle, settleAdapterIdle, updateInputLedger, waitForTurnIdle } from './turns.js';
import { logger, traceLog, describeFailure } from './shared.js';

export function handleConsumerMessage(client: RelayClient, raw: unknown): void {
  // Field types first (see @kraki/protocol/schemas): handlers below trust them,
  // and a malformed field must never reach a session's history.
  const checked = parseConsumerMessage(raw);
  if (!checked.ok) {
    rejectConsumerMessage(client, raw, checked);
    return;
  }
  const msg = checked.message;
  noteAppAlive(client, msg.deviceId);
  // Session/attachment ids become filesystem paths. Reject anything that is
  // not one of our id shapes before it reaches a handler.
  const p = (msg as { payload?: Record<string, unknown> }).payload ?? {};
  const ids = [msg.sessionId, p.sessionId, p.sourceSessionId, p.localSessionId,
    msg.type === 'request_attachment' ? p.id : undefined];
  if (ids.some((id) => id !== undefined && id !== null && id !== '' && !isSafeId(id))) {
    logger.warn({ type: msg.type, deviceId: msg.deviceId }, 'Dropped consumer message with an unsafe id');
    return;
  }
  if (msg.type === 'client_features') {
    const features = Array.isArray(msg.payload?.features) ? msg.payload.features.filter((f) => typeof f === 'string') : [];
    client.appFeatures.set(msg.deviceId, new Set(features));
    logger.info({ deviceId: msg.deviceId, features }, 'App features');
    return;
  }

  // create_session is special — no sessionId yet
  if (msg.type === 'create_session') {
    handleCreateSession(client, msg);
    return;
  }

  // fork_session is special — operates on a source session, not the new one
  if (msg.type === 'fork_session') {
    handleForkSession(client, msg);
    return;
  }

  // request_session_messages — turn-aware paginated replay
  if (msg.type === 'request_session_messages') {
    handleSessionMessages(client, msg.deviceId, msg.payload.sessionId, msg.payload.beforeSeq);
    return;
  }

  // request_session_messages_range — exact seq-range fetch (gap recovery, range queries)
  if (msg.type === 'request_session_messages_range') {
    handleSessionMessagesRange(client, msg.deviceId, msg.payload.sessionId, msg.payload.fromSeq, msg.payload.toSeq);
    return;
  }

  // request_turn_trace — pull one turn's tool trace (TRACE axis), keyed by
  // the concluding bubble's spine seq.
  if (msg.type === 'request_turn_trace') {
    handleTurnTrace(client, msg.deviceId, msg.payload.sessionId, msg.payload.bubbleSeq);
    return;
  }

  // set_session_subscription — atomically replace this Arm's one current
  // session and return the bounded live-ready snapshot in the ACK.
  if (msg.type === 'set_session_subscription') {
    if (msg.payload.sessionId && isSafeId(msg.payload.sessionId)) unarchiveOnUse(client, msg.payload.sessionId);
    const rid = (msg.payload as { requestId?: unknown }).requestId;
    const requestId = typeof rid === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(rid) ? rid : undefined;
    handleSetSessionSubscription(client, msg.deviceId, msg.payload.sessionId, requestId);
    return;
  }

  // request_card — legacy explicit card pull. Subscription ACK is the normal
  // reconnect/session-open authority, but keep this endpoint for diagnostics.
  if (msg.type === 'request_card') {
    handleRequestCard(client, msg.deviceId, msg.payload.sessionId);
    return;
  }

  // request_replay — replay buffered messages to the requesting device
  // request_session_replay — replay buffered messages for a specific session
  if (msg.type === 'request_session_replay') {
    if (!client.legacyReplayWarned.has(msg.deviceId)) {
      client.legacyReplayWarned.add(msg.deviceId);
      logger.warn({ deviceId: msg.deviceId, sessionId: msg.payload.sessionId }, 'Arm using deprecated request_session_replay — should migrate to request_session_messages');
    }
    handleSessionReplay(client, msg.deviceId, msg.payload.sessionId, msg.payload.afterSeq, msg.payload.limit);
    return;
  }

  // client_log — write web app debug logs to local file
  const msgRecord = msg as unknown as Record<string, unknown>;
  if (msgRecord.type === 'client_log') {
    const payload = msgRecord.payload as Record<string, unknown> | undefined;
    handleClientLog(client, msg.deviceId, payload?.entries as Array<{ ts: string; level: string; scope: string; message: string }> | undefined);
    return;
  }

  // ── Archive (no sessionId) ───────────────────────────
  if (msg.type === 'request_archived_sessions') {
    handleRequestArchivedSessions(client, msg.deviceId, msg.payload?.requestId);
    return;
  }
  if (msg.type === 'set_auto_archive_days') {
    handleSetAutoArchiveDays(client, msg.payload?.days);
    return;
  }
  if (msg.type === 'delete_archived_sessions') {
    handleDeleteArchivedSessions(client);
    return;
  }

  // ── Local session sync (no sessionId) ────────────────
  if (msg.type === 'request_local_sessions') {
    handleRequestLocalSessions(client, msg);
    return;
  }
  if (msg.type === 'import_session') {
    handleImportSession(client, msg);
    return;
  }

  if (msg.type === 'update_device') {
    const p = msg.payload as { requestId?: unknown; when?: unknown } | undefined;
    const requestId = typeof p?.requestId === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(p.requestId) ? p.requestId : '';
    const when = p?.when === 'now' || p?.when === 'idle' ? p.when : undefined;
    if (client.onUpdateRequest) void client.onUpdateRequest(requestId, when);
    else client.sendUpdateStatus({ phase: 'failed', requestId, error: 'This computer can’t be updated remotely.' });
    return;
  }

  if (msg.type === 'refresh_account_usage') {
    void handleRefreshAccountUsage(client, msg.deviceId, msg.payload?.requestId);
    return;
  }

  if (msg.type === 'request_usage_history') {
    handleRequestUsageHistory(client, msg.deviceId, msg.payload?.since);
    return;
  }

  if (msg.type === 'request_attachment') {
    handleRequestAttachment(client, msg).catch((err) => {
      logger.warn({ err, attachmentId: msg.payload?.id }, 'request_attachment failed');
    });
    return;
  }

  const sessionId = msg.sessionId;
  if (!sessionId) return;

  try {
    if (msg.type === 'send_input' && isSafeId(sessionId)) unarchiveOnUse(client, sessionId);
    switch (msg.type) {
      case 'archive_session': {
        const archived = msg.payload.archived === true;
        // A running session stays in the list.
        if (archived && client.sessionManager.getSessionList({ all: true }).find((s) => s.id === sessionId)?.state === 'active') break;
        if (client.sessionManager.setArchived(sessionId, archived)) client.broadcastSessionList();
        break;
      }
      case 'send_input': {
        const clientId = msg.payload.clientId as string | undefined;
        const requestedDelivery = msg.payload.delivery === 'steer' ? 'steer' as const : 'prompt' as const;
        const reservation = reserveInput(client, 
          sessionId,
          clientId,
          requestedDelivery,
          msg.payload.text,
          msg.payload.attachments,
        );
        traceLog.info({
          ns: process.hrtime.bigint().toString(),
          comp: 'tentacle',
          evt: reservation.conflict ? 'INPUT-REJECTED' : reservation.duplicate ? 'INPUT-DUPLICATE' : 'APP-SEND-INPUT',
          sessionId,
          clientId,
          textLen: (msg.payload.text || '').length,
          hasAttachments: !!msg.payload.attachments?.length,
          requestedDelivery,
          delivery: reservation.effectiveDelivery,
          turnId: reservation.turnId,
          recovery: reservation.recovery,
          contentHash: reservation.entry?.contentHash,
        });
        if (reservation.conflict) {
          client.send({ type: 'error', sessionId, payload: { message: 'Input clientId was already used for different content.' } });
          break;
        }
        if (reservation.duplicate) {
          // A retry of an input we already hold (its echo was lost or is
          // still queued). Re-echo the stored row to the sender so it can
          // settle the optimistic bubble; never run the turn twice.
          if (clientId) reechoInput(client, msg.deviceId, sessionId, clientId);
          break;
        }

        const inputEntry = reservation.entry;
        const effectiveDelivery = reservation.effectiveDelivery;
        // An answer targets an open question explicitly (`answerTo`); a
        // composer message without it answers the sole open question. An
        // `answerTo` for a question that is no longer open is delivered as
        // an ordinary message (not recorded as an answer).
        const requestedAnswerTo = msg.payload.answerTo as string | undefined;
        const answering = requestedAnswerTo
          ? client.openQuestions.get(sessionId)?.get(requestedAnswerTo) ?? null
          : soleOpenQuestion(client, sessionId);
        // Composer text with several open questions is ambiguous. Reject it
        // before it is persisted: a stored user_message would look sent and
        // would start a new turn boundary for input the agent never gets.
        if (!answering && !requestedAnswerTo && (client.openQuestions.get(sessionId)?.size ?? 0) > 1) {
          updateInputLedger(client, sessionId, clientId, 'rejected');
          client.send({ type: 'error', sessionId, payload: { message: 'Multiple questions are pending. Answer the intended question directly.' } });
          break;
        }
        let persistedSeq = inputEntry?.userSeq;
        if (!reservation.recovery) {
          const userMessage = {
            type: 'user_message' as const,
            sessionId,
            payload: {
              content: msg.payload.text,
              ...(msg.payload.attachments?.length && { attachments: msg.payload.attachments }),
              ...(msg.payload.clientId && { clientId: msg.payload.clientId }),
              ...(effectiveDelivery === 'steer' && !answering && { delivery: 'steer' as const }),
              ...(answering && { answerTo: answering.questionId }),
            },
          };
          client.send(userMessage);
          // send() assigns the per-session sequence by mutating the outbound
          // message. Reuse it instead of rescanning messages.jsonl.
          persistedSeq = (userMessage as typeof userMessage & { seq?: number }).seq;
          updateInputLedger(client, sessionId, clientId, 'persisted', persistedSeq);
        }
        traceLog.info({
          ns: process.hrtime.bigint().toString(),
          comp: 'tentacle',
          evt: 'INPUT-PERSISTED',
          sessionId,
          clientId,
          seq: persistedSeq ?? undefined,
          turnId: reservation.turnId,
          textLen: msg.payload.text.length,
          contentHash: inputEntry?.contentHash,
        });

        if (answering) {
          updateInputLedger(client, sessionId, clientId, 'dispatching');
          const delivery = deliverQuestionAnswer(client, sessionId, answering, {
            text: msg.payload.text === '[image]' ? '' : msg.payload.text,
            attachments: msg.payload.attachments,
          }, reservation.turnId);
          void delivery.then(() => {
            updateInputLedger(client, sessionId, clientId, 'delivered');
          }).catch((err) => {
            updateInputLedger(client, sessionId, clientId, 'rejected');
            logger.error({ err, sessionId }, 'question answer from composer failed');
            client.send({ type: 'error', sessionId, payload: { message: describeFailure('Failed to deliver answer', err) } });
          });
          break;
        }
        if (effectiveDelivery === 'steer') {
          void dispatchInput(client, sessionId, async () => {
            beginSteerAcceptance(client, sessionId);
            await ensureSessionResumed(client, sessionId);
            // Reassert active after resume so an idle/send race cannot leave a
            // successfully accepted interjection running behind an idle UI.
            client.send({ type: 'active', sessionId, payload: {} });
            // A steer joins the turn running when it reaches the adapter. Its
            // admission-time id can be stale (admitted while a lazy resume and
            // the prompt it follows were still being dispatched).
            const steerTurnId = client.activeInputTurnIds.get(sessionId) ?? reservation.turnId;
            beginAdapterTurn(client, sessionId, steerTurnId);
            client.sessionManager.markActive(sessionId);
            traceLog.info({ ns: process.hrtime.bigint().toString(), comp: 'tentacle', evt: 'APP-ADAPTER-STEER', sessionId, clientId, turnId: steerTurnId });
            updateInputLedger(client, sessionId, clientId, 'dispatching');
            const delivery = sendToAdapter(client, sessionId, msg.payload.text, msg.payload.attachments, { delivery: 'steer' });
            await delivery;
            updateInputLedger(client, sessionId, clientId, 'delivered');
            traceLog.info({
              ns: process.hrtime.bigint().toString(),
              comp: 'tentacle',
              evt: 'INPUT-DELIVERED',
              sessionId,
              clientId,
              turnId: steerTurnId,
              delivery: 'steer',
            });
            // The adapter ACK is the ownership boundary for the interjection.
            // Reassert active so an idle from the pre-steer work that raced the
            // ACK cannot become the final visible state. A later provider idle
            // still settles the steered work normally.
            finishSteerAcceptance(client, sessionId, true);
            // Unless that turn has already settled (no later idle would
            // clear an active reasserted now).
            if (client.settledAdapterTurnIds.get(sessionId) === steerTurnId) return;
            client.send({ type: 'active', sessionId, payload: {} });
            client.sessionManager.markActive(sessionId);
          }).catch((err) => {
            updateInputLedger(client, sessionId, clientId, 'rejected');
            finishSteerAcceptance(client, sessionId, false);
            logger.error({ err, sessionId }, 'steer input failed');
            client.send({ type: 'error', sessionId, payload: { message: describeFailure('Failed to steer agent', err) } });
          });
          break;
        }

        const previous = client.inputChains.get(sessionId);
        const deliver = async () => {
          const idle = waitForTurnIdle(client, sessionId);
          try {
            const dispatch = dispatchInput(client, sessionId, async () => {
              await ensureSessionResumed(client, sessionId);
              const compactionReason = client.compactingSessions.get(sessionId);
              const queueBehindMaintenance = client.sessionManager.getMeta(sessionId)?.state === 'idle'
                && (compactionReason === 'threshold' || compactionReason === 'manual');
              if (queueBehindMaintenance) {
                client.maintenanceFollowUps.set(sessionId, { accepted: false });
              } else {
                client.send({ type: 'active', sessionId, payload: {} });
                client.sessionManager.markActive(sessionId);
              }
              // A retried rejected input reuses its turn id; that turn was
              // closed as failed and now runs again.
              if (client.settledAdapterTurnIds.get(sessionId) === reservation.turnId) client.settledAdapterTurnIds.delete(sessionId);
              beginAdapterTurn(client, sessionId, reservation.turnId);
              traceLog.info({ ns: process.hrtime.bigint().toString(), comp: 'tentacle', evt: 'APP-ADAPTER-SEND', sessionId, clientId, queueBehindMaintenance, turnId: reservation.turnId });
              updateInputLedger(client, sessionId, clientId, 'dispatching');
              const delivery = queueBehindMaintenance
                ? sendToAdapter(client, sessionId, msg.payload.text, msg.payload.attachments, { delivery: 'follow_up' })
                : sendToAdapter(client, sessionId, msg.payload.text, msg.payload.attachments);
              await delivery;
              // Abort/process-loss may terminalize this turn while its adapter
              // submission is still unresolved. Never let a late completion
              // regress a settled ledger row or activate stale maintenance.
              if (!acceptsAdapterEvent(client, sessionId, reservation.turnId)
                || client.adapter.isTurnSettled(sessionId)) return;
              if (queueBehindMaintenance) acceptMaintenanceFollowUp(client, sessionId);
              updateInputLedger(client, sessionId, clientId, 'delivered');
              traceLog.info({
                ns: process.hrtime.bigint().toString(),
                comp: 'tentacle',
                evt: 'INPUT-DELIVERED',
                sessionId,
                clientId,
                turnId: reservation.turnId,
                delivery: queueBehindMaintenance ? 'follow_up' : 'prompt',
              });
              traceLog.info({ ns: process.hrtime.bigint().toString(), comp: 'tentacle', evt: 'APP-ADAPTER-DONE', sessionId, clientId, turnId: reservation.turnId });
            });
            // Usually transport acceptance wins and we then wait for provider
            // idle. Explicit abort is the inverse: idle is authoritative even
            // if a preflight prompt RPC never ACKs, so release the input chain
            // without waiting for that stale transport Promise.
            const firstBoundary = await Promise.race([
              dispatch.then(() => 'accepted' as const),
              idle.then(() => 'idle' as const),
            ]);
            if (firstBoundary === 'idle') return;
            await idle;
          } catch (err) {
            resolveTurnIdle(client, sessionId);
            throw err;
          }
        };
        const next = (previous ? previous.catch(() => {}).then(deliver) : deliver())
          .catch((err) => {
            client.maintenanceFollowUps.delete(sessionId);
            updateInputLedger(client, sessionId, clientId, 'rejected');
            logger.error({ err, sessionId }, 'send input failed');
            const message = describeFailure('Failed to deliver message', err);
            client.send({ type: 'error', sessionId, payload: { message } });
            // The adapter refused the prompt after this turn was announced
            // active (e.g. Codex turn/start rejected a retired model). No
            // provider idle will follow: close the turn as failed here.
            const turnId = reservation.turnId;
            if (client.activeInputTurnIds.get(sessionId) === turnId
              && client.settledAdapterTurnIds.get(sessionId) !== turnId
              && client.sessionManager.getMeta(sessionId)?.state === 'active') {
              client.errorPersistedForTurn.set(sessionId, turnId);
              client.pendingTerminalErrors.set(sessionId, { message, source: 'adapter', turnId });
              settleAdapterIdle(client, sessionId, { turnId });
            }
          })
          .finally(() => {
            if (client.inputChains.get(sessionId) === next) client.inputChains.delete(sessionId);
          });
        client.inputChains.set(sessionId, next);
        break;
      }
      case 'approve':
      case 'deny':
      case 'always_allow': {
        // `always_allow` is retired: no app offers it any more, and a
        // session-wide grant was broader than the operator could see. An
        // older app that still sends it approves this one request only.
        const decision = msg.type === 'deny' ? 'deny' : 'approve';
        const reason = decision === 'deny' && typeof (msg.payload as { reason?: unknown }).reason === 'string'
          ? ((msg.payload as { reason: string }).reason).trim().slice(0, 2000)
          : '';
        resolvePermission(client, sessionId, msg.payload.permissionId, decision, reason);
        break;
      }
      case 'kill_session':
        client.adapter.killSession(sessionId)
          .catch((err) => logger.error({ err, sessionId }, 'killSession failed'));
        break;
      case 'abort_session': {
        // The Stop belongs to the turn running now. Its acknowledgement may
        // arrive after that turn settled and a queued prompt took over; it
        // must never settle the successor.
        const turnId = client.activeInputTurnIds.get(sessionId);
        const abortKey = turnId ?? '';
        if (client.abortsInFlight.get(sessionId) === abortKey) break;
        client.abortsInFlight.set(sessionId, abortKey);
        const snapshot = client.card.state(sessionId);
        client.adapter.abortSession(sessionId)
          .then(() => {
            if (client.activeInputTurnIds.get(sessionId) !== turnId) return;
            // An open question is visible state too: record the abort so
            // the conversation shows "User aborted" after it.
            if (snapshot.draft || snapshot.action || client.openQuestions.has(sessionId)) {
              finishTurnWithStatus(client, sessionId, {
                type: 'user_abort',
                payload: { abortedAt: new Date().toISOString() },
              });
            } else {
              clearOpenQuestions(client, sessionId);
              client.card.clear(sessionId);
            }
            client.pendingTerminalErrors.delete(sessionId);
            client.settledAdapterTurnIds.set(sessionId, turnId ?? '__unidentified__');
            if (turnId) client.sessionManager.markInputLedgerSettled(sessionId, turnId);
            resolveTurnIdle(client, sessionId);
            client.sessionManager.markIdle(sessionId);
            clearCompacting(client, sessionId);
            // The user stopped this turn themselves: no turn-end push.
            sendTurnIdle(client, sessionId, { reason: 'aborted' }, null);
            // Turn boundary changed (aborted outcome). See settleAdapterIdle.
            client.broadcastSessionList();
          })
          .catch((err) => {
            logger.error({ err, sessionId }, 'abortSession failed');
            client.send({ type: 'error', sessionId, payload: { message: `Failed to abort session: ${(err as Error).message}` } });
          })
          .finally(() => {
            if (client.abortsInFlight.get(sessionId) === abortKey) client.abortsInFlight.delete(sessionId);
          });
        break;
      }
      case 'delete_session':
        deleteSessionEverywhere(client, sessionId);
        break;
      case 'mark_read': {
        const readSeq = client.sessionManager.markRead(sessionId, msg.payload.seq);
        if (readSeq !== null) {
          client.send({
            type: 'session_read',
            sessionId,
            payload: { seq: readSeq },
          });
        }
        break;
      }
      case 'mark_unread': {
        const rolledBack = client.sessionManager.markUnread(sessionId);
        if (rolledBack !== null) {
          client.send({
            type: 'session_read',
            sessionId,
            payload: { seq: rolledBack },
          });
        }
        break;
      }
      case 'set_session_mode': {
        const mode = normalizeSessionMode(msg.payload.mode);
        client.adapter.setSessionMode(sessionId, mode);
        client.sessionManager.setMode(sessionId, mode);
        client.send({
          type: 'session_mode_set',
          sessionId,
          payload: { mode: toWireSessionMode(mode) },
        });
        break;
      }
      case 'rename_session': {
        const newTitle = msg.payload.title;
        if (newTitle) {
          client.sessionManager.setTitle(sessionId, newTitle);
        } else {
          // Empty string = clear manual title
          client.sessionManager.setTitle(sessionId, '');
        }
        const meta = client.sessionManager.getMeta(sessionId);
        client.send({
          type: 'session_title_updated',
          sessionId,
          payload: { title: meta?.title, autoTitle: meta?.autoTitle },
        });
        break;
      }
      case 'set_session_model': {
        const { model, reasoningEffort, contextTier } = msg.payload;
        const previousMeta = client.sessionManager.getMeta(sessionId);
        const previousModel = previousMeta?.model;
        const previousReasoningEffort = previousMeta?.reasoningEffort;
        // Persist the intent before adapter resume so adapters that rebuild a
        // disconnected SDK session can restore the requested model and effort.
        // Roll both back if the adapter rejects the change; never acknowledge
        // configuration that did not reach the agent runtime.
        client.sessionManager.setModel(sessionId, model, reasoningEffort);
        // Pi must see the explicit model before generic lazy resume: a retired
        // provider in pi.jsonl can otherwise make pi exit before set_model.
        // Other agents retain the established resume-then-set ordering.
        const applyModel = client.sessionManager.getMeta(sessionId)?.agent === 'pi'
          ? client.adapter.setSessionModel(sessionId, model, reasoningEffort, contextTier)
              .then(() => ensureSessionResumed(client, sessionId, false, false))
          : ensureSessionResumed(client, sessionId, true, false)
              .then(() => client.adapter.setSessionModel(sessionId, model, reasoningEffort, contextTier));
        applyModel
          .then(() => {
            client.send({
              type: 'session_model_set',
              sessionId,
              payload: { model, reasoningEffort, contextTier },
            });
          })
          .catch((err) => {
            if (previousModel) {
              client.sessionManager.setModel(sessionId, previousModel, previousReasoningEffort);
            }
            logger.error({ err, sessionId }, 'setSessionModel failed');
            client.send({ type: 'error', sessionId, payload: { message: describeFailure('Failed to change model', err) } });
          });
        break;
      }
      case 'pin_session': {
        const pinned = msg.payload.pinned;
        client.sessionManager.setPin(sessionId, pinned);
        client.send({
          type: 'session_pinned',
          sessionId,
          payload: { pinned },
        });
        break;
      }
      default:
        break;
    }
  } catch (err) {
    logger.error({ err, sessionId, type: msg.type }, 'handleConsumerMessage failed');
  }
}

/** A decrypted app message failed its field check. Unknown types are what
 *  a newer app may send (debug only); a malformed known message is a bug
 *  worth a warning. A dropped send_input gets an error in the chat, or the
 *  app would keep its bubble "sending" with no explanation. */
export function rejectConsumerMessage(client: RelayClient, raw: unknown, { type, unknownType, problem }: { type?: string; unknownType: boolean; problem: string }): void {
  const r = (raw ?? {}) as { deviceId?: unknown; sessionId?: unknown };
  if (unknownType) {
    logger.debug({ type, deviceId: r.deviceId }, 'Ignored app message of an unknown type');
    return;
  }
  logger.warn({ type, problem, deviceId: r.deviceId }, 'Dropped malformed app message');
  if (type === 'send_input' && typeof r.sessionId === 'string' && isSafeId(r.sessionId) && client.sessionManager.getMeta(r.sessionId)) {
    client.send({ type: 'error', sessionId: r.sessionId, payload: { message: 'Kraki on this computer could not read that message. Updating Kraki here may fix it.' } });
  }
}

/** An App that is sending to us is online. Presence frames from the Head can
 *  arrive stale (a `device_left` from before our last `auth_ok`, replayed by
 *  Pulse resume after a Tentacle restart), which would silently stop every
 *  broadcast to a connected App until it reconnects. */
export function noteAppAlive(client: RelayClient, deviceId: string | undefined): void {
  if (!deviceId || client.isAppOnline(deviceId) || !client.consumerKeys.has(deviceId)) return;
  client.onlineConsumers.add(deviceId);
  if (!client.currentSessionByArm.has(deviceId)) client.currentSessionByArm.set(deviceId, null);
  client.attachmentPacer.notifyOnline(deviceId);
  logger.warn({ deviceId }, 'App marked offline is sending; restored as online');
}

export function handleClientLog(client: RelayClient, deviceId: string, entries: Array<{ ts: string; level: string; scope: string; message: string }> | undefined): void {
  if (!Array.isArray(entries) || entries.length === 0) return;
  try {
    const logPath = join(getKrakiHome(), 'logs', 'web-client.log');
    // App-supplied text: one line per entry (no injected newlines/control
    // characters), bounded size per entry and per batch.
    const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);
    const lines = entries.slice(0, 200)
      .map(e => `${clean(e.ts, 40)} [${clean(deviceId, 80)}] [${clean(e.level, 16)}:${clean(e.scope, 64)}] ${clean(e.message, 4000)}`)
      .join('\n') + '\n';
    try {
      if (statSync(logPath).size > RelayClient.CLIENT_LOG_MAX_BYTES) renameSync(logPath, `${logPath}.1`);
    } catch { /* no log yet */ }
    appendFileSync(logPath, lines, 'utf8');
  } catch {
    // Ignore write errors
  }
}
