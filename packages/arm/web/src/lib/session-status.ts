import type { CardActionState, SessionSummary } from '@kraki/protocol';
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
 * For sessions not yet opened after a reload, the tentacle surfaces an open
 * `ask_user` question by overriding the digest `preview` with a `question`
 * entry — so `previewType === 'question'` seeds the pending status until the
 * live card arrives.
 */
export type SessionStatus = 'idle' | 'working' | 'pending' | 'ended';

/** A stable identity for a card action — changes when the slot's meaningful
 *  state changes (tool start/complete, prompt open/resolve, batch count). Used
 *  both to gate trace re-pulls and to drive scroll auto-follow. */
export function cardActionKey(a: CardActionState | null): string {
  if (!a) return 'none';
  switch (a.type) {
    case 'tool_start':
    case 'tool_complete':
      return `${a.type}:${a.payload.toolCallId ?? a.payload.headline}`;
    case 'tool_batch':
      return `batch:${a.payload.running}`;
    case 'permission':
      return `perm:${a.payload.id}:${a.payload.decision ?? 'pending'}`;
    case 'question':
      return `q:${a.payload.id}:${a.payload.cancelled ? 'cancelled' : a.payload.answer === undefined ? 'pending' : 'answered'}`;
  }
}

/** Count an open (unanswered) question for a session from the card map. */
export function countPendingQuestions(
  sessionId: string,
  cards: Map<string, SessionCard>,
): number {
  const action = cards.get(sessionId)?.action;
  return action?.type === 'question' && action.payload.answer === undefined && !action.payload.cancelled ? 1 : 0;
}

export function getSessionStatus(
  session: Pick<SessionSummary, 'state'>,
  livePendingCount: number,
  previewType?: string,
): SessionStatus {
  if ((session.state as string) === 'ended') return 'ended';
  if (session.state === 'idle') return 'idle';
  if (livePendingCount > 0 || previewType === 'question') return 'pending';
  return 'working';
}
