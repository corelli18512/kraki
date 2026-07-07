import type { SessionSummary } from '@kraki/protocol';
import type { SessionCard } from '../types/store';

/**
 * Human-facing session status, richer than the wire's binary active/idle.
 *
 * - `idle`    — no turn running; the composer starts a new run.
 * - `working` — a turn is running (thinking / tools) with no open question.
 * - `pending` — a turn is running but BLOCKED on ≥1 open `ask_user` question;
 *               the human's answer is what unblocks it.
 * - `ended`   — session closed.
 *
 * Derived on the client from the session's wire state plus the live card action.
 * `session.pendingQuestions` remains a reload-seed hint from the tentacle digest
 * for sessions not yet opened.
 */
export type SessionStatus = 'idle' | 'working' | 'pending' | 'ended';

/** Count an open (unanswered) question for a session from the card map. */
export function countPendingQuestions(
  sessionId: string,
  cards: Map<string, SessionCard>,
): number {
  const action = cards.get(sessionId)?.action;
  return action?.kind === 'question' && action.answer === undefined ? 1 : 0;
}

export function getSessionStatus(
  session: Pick<SessionSummary, 'state'> & { pendingQuestions?: number },
  livePendingCount: number,
): SessionStatus {
  if ((session.state as string) === 'ended') return 'ended';
  if (livePendingCount > 0 || (session.pendingQuestions ?? 0) > 0) return 'pending';
  if (session.state === 'idle') return 'idle';
  return 'working';
}
