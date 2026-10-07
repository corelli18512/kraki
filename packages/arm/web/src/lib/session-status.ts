import type { SessionSummary } from '@kraki/protocol';
import type { SessionCard } from '../types/store';

/**
 * Human-facing session status, richer than the wire's binary active/idle.
 *
 * - `idle`    — no turn running; the composer starts a new run.
 * - `working` — a turn is running (thinking / tools) with no open question.
 * - `pending` — BLOCKED on the human: an open question (on the spine) or an
 *               unresolved permission (the live card).
 * - `ended`   — session closed.
 *
 * Derived on the client from the session's wire state plus live attention.
 * The Tentacle surfaces an open question in the session_list digest `preview`
 * (`previewType === 'question'`), so it is known before the session is opened.
 */
export type SessionStatus = 'idle' | 'working' | 'compacting' | 'pending' | 'ended';

/** An unresolved permission in the session's live card (1) or none (0). */
export function countPendingQuestions(
  sessionId: string,
  cards: Map<string, SessionCard>,
): number {
  const action = cards.get(sessionId)?.action;
  return action?.type === 'permission' && !action.payload.decision ? 1 : 0;
}

export function getSessionStatus(
  session: Pick<SessionSummary, 'state'>,
  livePendingCount: number,
  previewType?: string,
): SessionStatus {
  if ((session.state as string) === 'ended') return 'ended';
  // A blocking human affordance is the highest-priority visible status: it
  // must read "pending" even when the transport state is "idle" (e.g. after a
  // relay restart flattened in-memory liveness but a question is still open).
  // Checking this before the idle short-circuit is the whole point.
  if (livePendingCount > 0 || previewType === 'question') return 'pending';
  if (session.state === 'idle') return 'idle';
  // compacting is independent and must not displace pending (checked above).
  if (session.state === 'compacting') return 'compacting';
  return 'working';
}
