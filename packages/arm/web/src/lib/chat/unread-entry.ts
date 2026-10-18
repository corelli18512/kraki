import { getStore } from '../store-adapter';

/**
 * Entering a Session with new messages (a red dot, or from a notification):
 * the reader starts at the first message they haven't read when the new part
 * doesn't fit on one screen; otherwise at the newest edge as usual. The same
 * rule as iPhone and Mac (ChatScrollPolicy.UnreadEntry): evaluated on every
 * settle until the reader takes over, so new messages arriving after the
 * chat appeared, or a reply still streaming, behave the same — follow while
 * it fits, stop with the first new message at the top once it doesn't.
 */

/** Sessions about to be opened from a notification click. */
const notificationEntries = new Set<string>();

export function markNotificationEntry(sessionId: string): void {
  notificationEntries.add(sessionId);
}

/** The read position to land after, or null to open at the newest edge.
 *  Call once per entry, before the Session is marked read. */
export function captureEntryBoundary(sessionId: string): number | null {
  const fromNotification = notificationEntries.delete(sessionId);
  const store = getStore();
  const session = store.sessions.get(sessionId);
  const readSeq = session?.readSeq ?? 0;
  if (readSeq <= 0) return null;
  return store.unreadCount.has(sessionId) || fromNotification ? readSeq : null;
}

/** Whether the Session really has something unread (the red dot), not only a
 *  notification click. Read it with captureEntryBoundary, before marking read. */
export function hasUnreadGap(sessionId: string): boolean {
  return getStore().unreadCount.has(sessionId);
}

/** The first loaded, projected row after the read position, before windowing
 *  (rows without a seq —
 *  live, pending — never qualify).
 *
 *  Usually nothing displayable is above it: Tentacle advances the read cursor
 *  with every message appended while the Session was read, and only the turn's
 *  end (idle, no row) opens the unread gap. So for "I sent, left, and the
 *  reply arrived" the cursor already sits on the reply; with
 *  `latestReplyFallback` (a real red dot) the new part is then what follows the
 *  user's latest message: the start of the latest reply. */
export function firstUnreadKey(
  rows: { key: string; seq?: number; isUser?: boolean }[],
  boundary: number,
  latestReplyFallback = false,
): string | null {
  const after = rows.find((r) => (r.seq ?? 0) > boundary);
  if (after) return after.key;
  if (!latestReplyFallback) return null;
  let lastUser = -1;
  rows.forEach((r, i) => { if (r.isUser && r.seq !== undefined) lastUser = i; });
  if (lastUser < 0) return null;
  return rows.slice(lastUser + 1).find((r) => r.seq !== undefined && !r.isUser)?.key ?? null;
}

/** Where to land for the first new row, or null to stay at the newest edge
 *  because its start is readable there. */
export function unreadLanding(rowStartLanding: number, tailOffset: number): number | null {
  return rowStartLanding < tailOffset - 1 ? rowStartLanding : null;
}
