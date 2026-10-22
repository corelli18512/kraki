/** Open questions and permissions: tracking, restoring after a restart, delivering answers and decisions. */

import { type PendingHumanAction } from '../session-manager.js';
import type { RelayClient } from '../relay-client.js';
import { recordTrace } from './adapter-events.js';
import { ensureSessionResumed, sendToAdapter } from './session-resume.js';
import { beginAdapterTurn } from './turns.js';
import { logger } from './shared.js';

/** Record a newly-opened question and persist it for answer routing after a restart. */
export function addOpenQuestion(client: RelayClient, sessionId: string, pending: PendingHumanAction): void {
  let map = client.openQuestions.get(sessionId);
  if (!map) {
    map = new Map();
    client.openQuestions.set(sessionId, map);
  }
  map.set(pending.questionId, pending);
  client.sessionManager.savePendingHumanAction(sessionId, pending);
}

/** Drop a resolved/cancelled question for a session. */
export function removeOpenQuestion(client: RelayClient, sessionId: string, questionId: string): void {
  const map = client.openQuestions.get(sessionId);
  if (!map) return;
  map.delete(questionId);
  if (map.size === 0) {
    client.openQuestions.delete(sessionId);
    client.sessionManager.clearPendingHumanAction(sessionId);
  } else {
    let newest: PendingHumanAction | undefined;
    for (const pending of map.values()) newest = pending;
    if (newest) client.sessionManager.savePendingHumanAction(sessionId, newest);
  }
}

/** Clear all open human attention for a session (turn ended / session gone). */
export function clearOpenQuestions(client: RelayClient, sessionId: string): void {
  // Delete both maps independently: `a || b` short-circuited and leaked a
  // permission when a question was also open on the same session.
  const qChanged = client.openQuestions.delete(sessionId);
  const pChanged = client.openPermissions.delete(sessionId);
  client.sessionManager.clearPendingHumanAction(sessionId);
  if (qChanged || pChanged) client.broadcastSessionList();
}

export function soleOpenQuestion(client: RelayClient, sessionId: string): PendingHumanAction | null {
  const map = client.openQuestions.get(sessionId);
  if (!map || map.size !== 1) return null;
  return map.values().next().value ?? null;
}

/** The newest open human attention item, preserving its original openedAt. */
export function latestOpenAttention(client: RelayClient, sessionId: string): { type: 'permission' | 'question'; text: string; openedAt: string } | undefined {
  let latest: { type: 'permission' | 'question'; text: string; openedAt: string } | undefined;
  for (const permission of client.openPermissions.get(sessionId)?.values() ?? []) {
    if (!latest || permission.openedAt >= latest.openedAt) latest = { type: 'permission', ...permission };
  }
  for (const question of client.openQuestions.get(sessionId)?.values() ?? []) {
    const candidate = { type: 'question' as const, text: question.question, openedAt: question.createdAt };
    if (!latest || candidate.openedAt >= latest.openedAt) latest = candidate;
  }
  return latest;
}

/** Rehydrate open questions (answer routing) before session-list snapshots. */
export function restorePendingHumanActions(client: RelayClient): void {
  for (const meta of client.sessionManager.getSessionList({ all: true })) {
    const pending = client.sessionManager.getPendingHumanAction(meta.id);
    if (!pending) continue;
    let map = client.openQuestions.get(meta.id);
    if (!map) {
      map = new Map();
      client.openQuestions.set(meta.id, map);
    }
    map.set(pending.questionId, pending);
  }
}

/** Deliver through the original live request when possible. If the daemon/Pi
 *  process was reconstructed, continue transparently with a recovery prompt.
 *  The answer itself is already on the spine (`user_message.answerTo`). */
export async function deliverQuestionAnswer(
  client: RelayClient,
  sessionId: string,
  pending: PendingHumanAction,
  answer: { text: string; attachments?: import('@kraki/protocol').Attachment[] },
  turnId?: string,
): Promise<void> {
  // Choices are shortcuts: an answer equal to one of them is a pick.
  const wasFreeform = !(pending.choices ?? []).includes(answer.text);
  await ensureSessionResumed(client, sessionId);
  const result = await client.adapter.respondToQuestion(sessionId, pending.questionId, answer, wasFreeform);
  if (result !== 'accepted') {
    // Expected after a daemon restart or pi process loss: the live dialog is
    // gone, so the answer continues the task as a new (recovery) turn.
    const createdAt = Date.parse(pending.createdAt);
    logger.info({
      sessionId,
      questionId: pending.questionId,
      turnId,
      adapterResult: result,
      ageMs: Number.isNaN(createdAt) ? undefined : Date.now() - createdAt,
    }, 'Question answered after its live request was lost; sending it as a recovery prompt');
    const answerText = answer.text || (answer.attachments?.length ? '[image attachment]' : '(no text)');
    const recoveryPrompt = [
      'A previous turn was interrupted while waiting for the user to answer this question:',
      pending.question,
      '',
      'The user has now answered:',
      answerText,
      '',
      'Continue the previous task using this answer. Do not ask the same question again unless the answer is genuinely insufficient.',
    ].join('\n');
    client.send({ type: 'active', sessionId, payload: {} });
    beginAdapterTurn(client, sessionId, turnId);
    client.sessionManager.markActive(sessionId);
    await sendToAdapter(client, sessionId, recoveryPrompt, answer.attachments);
  }

  removeOpenQuestion(client, sessionId, pending.questionId);
  client.broadcastSessionList();
}

/**
 * Apply an app's permission decision. The resolution is announced only when
 * a live pending request took it. A request that is still open here but gone
 * from the agent (timed out, session ended) is closed as cancelled so apps
 * stop showing it; a duplicate of an earlier decision (Pulse resend) is
 * ignored and never overrides the announced outcome.
 */
export function resolvePermission(client: RelayClient, sessionId: string, permissionId: string, decision: 'approve' | 'deny', reason: string, fromDeviceId?: string): void {
  const verb = decision;
  (reason
    ? client.adapter.respondToPermission(sessionId, permissionId, decision, reason)
    : client.adapter.respondToPermission(sessionId, permissionId, decision))
    .then((result) => {
      // Audit trail: who decided which request, and whether it reached the
      // agent. Never the tool arguments or the deny reason text.
      logger.info({ sessionId, permissionId, decision, fromDeviceId, adapterResult: result, withReason: !!reason }, 'Permission decision');
      const wasOpen = client.openPermissions.get(sessionId)?.delete(permissionId) === true;
      if (result === 'not_found' || result === 'session_gone') {
        if (!wasOpen) return;
        client.card.resolvePrompt(sessionId, permissionId);
        client.broadcastSessionList();
        client.send({ type: 'permission_resolved', sessionId, payload: { permissionId, resolution: 'cancelled', reason: 'This request is no longer pending.' } });
        return;
      }
      client.card.resolvePrompt(sessionId, permissionId, { decision });
      client.broadcastSessionList();
      recordTrace(client, { type: 'permission', sessionId, payload: { id: permissionId, description: '', toolName: '', args: {}, decision, ...(decision === 'deny' && reason && { reason }) } });
      const resolution = decision === 'approve'
        ? { resolution: 'approved' as const }
        : { resolution: 'denied' as const, ...(reason && { reason }) };
      client.send({ type: 'permission_resolved', sessionId, payload: { permissionId, ...resolution } });
    })
    .catch((err) => {
      logger.error({ err, sessionId }, 'respondToPermission failed');
      client.send({ type: 'error', sessionId, payload: { message: `Failed to ${verb} permission: ${(err as Error).message}` } });
    });
}
