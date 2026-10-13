/** Claude's canUseTool: permission requests, AskUserQuestion as a Kraki question, resolving what is pending. */

import { isKrakiSelfManagementCommand, SELF_MANAGEMENT_DENIAL_REASON, shellCommandFromInput } from '../self-management-guard.js';
import { DEFAULT_SESSION_MODE } from '@kraki/protocol';
import { DELEGATE_ANSWER, krakiAutoApproves, type SessionMode } from './permission-policy.js';
import type { ClaudeAdapter } from './claude.js';
import { logger, type PermissionResult, type PendingPermission, type AskUserQuestionItem, type PendingQuestion, makeId } from './claude-session.js';
import { toolNameToKind, parseClaudeToolCall } from './claude-tools.js';

/**
 * Create the `canUseTool` callback for the Claude Agent SDK.
 * Implements Kraki's 4-mode permission system.
 */
export function makeCanUseToolHandler(
  adapter: ClaudeAdapter,
  sessionId: string,
  pendingPermissions: Map<string, PendingPermission>,
  pendingQuestions: Map<string, PendingQuestion>,
) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      suggestions?: Array<{ type: string; [key: string]: unknown }>;
      title?: string;
      displayName?: string;
      description?: string;
      toolUseID: string;
      agentID?: string;
    },
  ): Promise<PermissionResult> => {

    // Handle AskUserQuestion tool → bridge to onQuestionRequest
    if (toolName === 'AskUserQuestion') {
      return handleAskUserQuestion(adapter, sessionId, input, pendingQuestions);
    }

    if (isKrakiSelfManagementCommand(shellCommandFromInput(input))) {
      logger.warn({ sessionId, toolName }, 'blocked tentacle self-management command');
      return { behavior: 'deny', message: SELF_MANAGEMENT_DENIAL_REASON };
    }

    const toolKind = toolNameToKind(toolName);
    const mode = adapter.sessionModes.get(sessionId) ?? DEFAULT_SESSION_MODE;

    if (krakiAutoApproves(mode, toolKind)) {
      logger.debug({ sessionId, toolKind, mode }, 'permission auto-approved');
      return { behavior: 'allow', updatedInput: input };
    }

    // Not auto-approved — send to relay for user decision
    const permId = makeId('perm');
    const parsed = parseClaudeToolCall(toolName, input);

    logger.debug({
      permissionId: permId,
      sessionId,
      toolKind,
      toolName,
    }, 'permission requested');

    // Register BEFORE announcing: a response may arrive synchronously.
    const decision = new Promise<PermissionResult>((resolve) => {
      pendingPermissions.set(permId, { resolve, toolKind, input });
    });
    // Approval cards raised by a subagent say so.
    let parentToolCallId: string | undefined;
    if (options.agentID) {
      const owner = adapter.sessions.get(sessionId);
      const label = owner?.subagentLabels?.get(options.agentID) ?? 'subagent';
      parsed.description = `Subagent ${label} — ${parsed.description}`;
      parentToolCallId = owner?.taskDispatch?.get(options.agentID);
    }
    adapter.onPermissionRequest?.(sessionId, {
      ...adapter.lifecycleEvent(adapter.sessions.get(sessionId)),
      id: permId,
      ...parsed,
      ...(parentToolCallId && { parentToolCallId }),
    });
    return decision;
  };
}

/**
 * Handle the AskUserQuestion tool by bridging to onQuestionRequest.
 */
export function handleAskUserQuestion(
  adapter: ClaudeAdapter,
  sessionId: string,
  input: Record<string, unknown>,
  pendingQuestions: Map<string, PendingQuestion>,
): Promise<PermissionResult> {
  const mode = adapter.sessionModes.get(sessionId) ?? DEFAULT_SESSION_MODE;

  // Delegate mode: auto-answer questions
  if (mode === 'delegate') {
    logger.debug({ sessionId }, 'question auto-answered (delegate mode)');
    // Key each answer by its question TEXT (SDK schema), not a literal
    // "answer" key — otherwise the SDK sees every question as unanswered.
    const qs = (input.questions as AskUserQuestionItem[] | undefined) ?? [];
    const answers: Record<string, string> = {};
    for (const q of qs) {
      if (q?.question) answers[q.question] = 'proceed with your best judgment';
    }
    return Promise.resolve({
      behavior: 'allow',
      updatedInput: { questions: qs, answers },
    });
  }

  const questions = input.questions as AskUserQuestionItem[] | undefined;

  return new Promise<PermissionResult>((resolve) => {
    const qs = questions ?? [];
    if (qs.length === 0) {
      // Malformed AskUserQuestion with no questions: surface a single
      // best-effort prompt so the user isn't stuck, resolve empty.
      const qId = makeId('q');
      adapter.onQuestionRequest?.(sessionId, {
        ...adapter.lifecycleEvent(adapter.sessions.get(sessionId)),
        id: qId,
        question: (input.question as string) ?? 'The agent has a question',
        choices: undefined,
      });
      pendingQuestions.set(qId, { resolve, questionId: qId, questions: qs, qIndex: 0, collected: {} });
      return;
    }
    // Surface the first question; subsequent questions are emitted one at a
    // time as each is answered (see respondToQuestion).
    emitQuestionCard(adapter, sessionId, resolve, qs, 0, {}, pendingQuestions);
  });
}

/**
 * Emit a single AskUserQuestion card (question[index]) to the app and record
 * a pending entry. Shared by the initial emit and the serial advance in
 * respondToQuestion.
 */
export function emitQuestionCard(
  adapter: ClaudeAdapter,
  sessionId: string,
  resolve: (result: PermissionResult) => void,
  questions: AskUserQuestionItem[],
  index: number,
  collected: Record<string, string>,
  pendingQuestions: Map<string, PendingQuestion>,
): void {
  const qId = makeId('q');
  const q = questions[index];
  const choices = q?.options?.map(o => o.label);

  logger.debug({
    questionId: qId,
    sessionId,
    index,
    total: questions.length,
    choicesCount: choices?.length ?? 0,
  }, 'question requested');

  adapter.onQuestionRequest?.(sessionId, {
    ...adapter.lifecycleEvent(adapter.sessions.get(sessionId)),
    id: qId,
    question: q?.question ?? 'The agent has a question',
    choices,
  });

  pendingQuestions.set(qId, { resolve, questionId: qId, questions, qIndex: index, collected });
}

/** Entering auto/delegate approves the permissions already waiting (as the
 *  new mode would have); delegate also answers the open questions. */
export function releasePendingForMode(adapter: ClaudeAdapter, sessionId: string, mode: SessionMode): void {
  const entry = adapter.sessions.get(sessionId);
  if (!entry || (mode !== 'auto' && mode !== 'delegate')) return;
  for (const [permId, p] of entry.pendingPermissions) {
    p.resolve({ behavior: 'allow', updatedInput: p.input });
    entry.pendingPermissions.delete(permId);
    adapter.onPermissionAutoResolved?.(sessionId, permId, 'approved');
  }
  if (mode !== 'delegate') return;
  for (const [qId, q] of entry.pendingQuestions) {
    const questions = q.questions ?? [];
    const answers = { ...(q.collected ?? {}) };
    for (const item of questions.slice(q.qIndex ?? 0)) {
      if (item?.question) answers[item.question] = DELEGATE_ANSWER;
    }
    q.resolve({ behavior: 'allow', updatedInput: { questions, answers } });
    entry.pendingQuestions.delete(qId);
    adapter.onQuestionAutoResolved?.(sessionId, qId);
  }
}

export function broadcastPendingResolutions(adapter: ClaudeAdapter, sessionId: string): void {
  const entry = adapter.sessions.get(sessionId);
  if (!entry) return;
  for (const [permId, p] of entry.pendingPermissions) {
    p.resolve({ behavior: 'deny', message: 'Session ended' });
    adapter.onPermissionAutoResolved?.(sessionId, permId, 'cancelled');
  }
  entry.pendingPermissions.clear();
  for (const [qId, q] of entry.pendingQuestions) {
    // Session ending with a question still open: echo `questions` back
    // (required by the SDK schema) with whatever answers were collected so
    // far in this serial chain (empty if none), so the SDK renders the rest
    // as unanswered rather than throwing on a missing `questions` field.
    q.resolve({
      behavior: 'allow',
      updatedInput: { questions: q.questions ?? [], answers: q.collected ?? {} },
    });
    adapter.onQuestionAutoResolved?.(sessionId, qId);
  }
  entry.pendingQuestions.clear();
}
