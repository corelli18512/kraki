/** Copilot permission and user-input handlers, and resolving what is still pending. */

import type { PermissionRequest, PermissionRequestResult } from '@github/copilot-sdk';
import { parsePermission } from '../parse-permission.js';
import { isKrakiSelfManagementCommand, SELF_MANAGEMENT_DENIAL_REASON, shellCommandFromInput } from '../self-management-guard.js';
import { DEFAULT_SESSION_MODE } from '@kraki/protocol';
import { DELEGATE_ANSWER, krakiAutoApproves, type SessionMode } from './permission-policy.js';
import type { CopilotAdapter } from './copilot.js';
import { logger, copilotToolKind, type UserInputRequest, type UserInputResponse, type PendingPermission, type PendingQuestion, makeId } from './copilot-session.js';

export function makePermissionHandler(adapter: CopilotAdapter, pending: Map<string, PendingPermission>) {
  return (req: PermissionRequest, invocation: { sessionId: string }): Promise<PermissionRequestResult> | PermissionRequestResult => {
    const sessionId = invocation.sessionId;
    const toolKind = req.kind; // e.g. 'shell', 'write', 'read', 'url', 'mcp'
    const mode = adapter.sessionModes.get(sessionId) ?? DEFAULT_SESSION_MODE;

    const rawRequest = req as PermissionRequest & Record<string, unknown>;
    if (toolKind === 'shell' && isKrakiSelfManagementCommand(shellCommandFromInput(rawRequest))) {
      logger.warn({ sessionId }, 'blocked tentacle self-management command');
      return { kind: 'reject', feedback: SELF_MANAGEMENT_DENIAL_REASON };
    }

    if (krakiAutoApproves(mode, copilotToolKind(toolKind))) {
      logger.debug({ sessionId, toolKind, mode }, 'permission auto-approved');
      return { kind: 'approve-once' };
    }

    // Not auto-approved — send to relay for user decision
    const permId = makeId('perm');
    const parsed = parsePermission(req);

    logger.debug({
      permissionId: permId,
      sessionId,
      toolKind,
      toolName: parsed.toolArgs.toolName,
    }, 'permission requested');

    adapter.onPermissionRequest?.(sessionId, {
      ...adapter.lifecycleEvent(sessionId),
      id: permId,
      ...parsed,
    });

    const promise = new Promise<PermissionRequestResult>((resolve) => {
      pending.set(permId, { resolve, toolKind });
    });

    return promise;
  };
}

export function makeQuestionHandler(adapter: CopilotAdapter, pending: Map<string, PendingQuestion>) {
  return (req: UserInputRequest, invocation: { sessionId: string }): Promise<UserInputResponse> | UserInputResponse => {
    const sessionId = invocation.sessionId;
    const mode = adapter.sessionModes.get(sessionId) ?? DEFAULT_SESSION_MODE;

    // Delegate mode: auto-answer questions
    if (mode === 'delegate') {
      logger.debug({ sessionId }, 'question auto-answered (delegate mode)');
      return { answer: 'proceed with your best judgment', wasFreeform: true };
    }

    const qId = makeId('q');

    logger.debug({
      questionId: qId,
      sessionId,
      choicesCount: req.choices?.length ?? 0,
      allowFreeform: req.allowFreeform !== false,
    }, 'question requested');

    adapter.onQuestionRequest?.(sessionId, {
      ...adapter.lifecycleEvent(sessionId),
      id: qId,
      question: req.question ?? '',
      choices: req.choices ?? undefined,
    });

    return new Promise<UserInputResponse>((resolve) => {
      pending.set(qId, { resolve });
    });
  };
}

/** Clean up session-scoped permission state */
export function cleanupSessionPermissions(adapter: CopilotAdapter, sessionId: string): void {
  adapter.sessionModes.delete(sessionId);
  adapter.pendingModeSignals.delete(sessionId);
  adapter.sessionUsage.delete(sessionId);
  adapter.expectedModels.delete(sessionId);
  adapter.userRequestedModels.delete(sessionId);
  adapter.nativeTitles.delete(sessionId);
  adapter.turnHasOutput.delete(sessionId);
  adapter.turnErrorReported.delete(sessionId);
  const inflight = adapter.sessionToolCallIds.get(sessionId);
  if (inflight) {
    for (const id of inflight) {
      adapter.pendingToolArgs.delete(id);
      adapter.pendingToolIdentity.delete(id);
    }
    adapter.sessionToolCallIds.delete(sessionId);
  }
}

/** Entering auto/delegate approves the permissions already waiting (as the
 *  new mode would have); delegate also answers the open questions. */
export function releasePendingForMode(adapter: CopilotAdapter, sessionId: string, mode: SessionMode): void {
  const entry = adapter.sessions.get(sessionId);
  if (!entry || (mode !== 'auto' && mode !== 'delegate')) return;
  for (const [permId, p] of entry.pendingPermissions) {
    p.resolve({ kind: 'approve-once' });
    entry.pendingPermissions.delete(permId);
    adapter.onPermissionAutoResolved?.(sessionId, permId, 'approved');
  }
  if (mode !== 'delegate') return;
  for (const [qId, q] of entry.pendingQuestions) {
    q.resolve({ answer: DELEGATE_ANSWER, wasFreeform: true });
    entry.pendingQuestions.delete(qId);
    adapter.onQuestionAutoResolved?.(sessionId, qId);
  }
}

/** Resolve all pending permissions/questions and fire callbacks so relay-client broadcasts resolutions. */
export function broadcastPendingResolutions(adapter: CopilotAdapter, sessionId: string): void {
  const entry = adapter.sessions.get(sessionId);
  if (!entry) return;
  for (const [permId, p] of entry.pendingPermissions) {
    p.resolve({ kind: 'reject' });
    adapter.onPermissionAutoResolved?.(sessionId, permId, 'cancelled');
  }
  entry.pendingPermissions.clear();
  for (const [qId, q] of entry.pendingQuestions) {
    q.resolve({ answer: '', wasFreeform: true });
    adapter.onQuestionAutoResolved?.(sessionId, qId);
  }
  entry.pendingQuestions.clear();
}
