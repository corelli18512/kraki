import type { CardActionState, SessionSummary } from '@kraki/protocol';
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
    case 'user_abort':
      return `user_abort:${a.payload.abortedAt}`;
    case 'failed':
      return `failed:${a.payload.failedAt}:${a.payload.code ?? ''}:${a.payload.message}`;
  }
}

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
