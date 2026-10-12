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

/** The first rendered row after the read position (rows without a seq —
 *  live, pending — never qualify). */
export function firstUnreadKey(rows: { key: string; seq?: number }[], boundary: number): string | null {
  return rows.find((r) => (r.seq ?? 0) > boundary)?.key ?? null;
}

/** Where to land for the first new row, or null to stay at the newest edge
 *  because its start is readable there. */
export function unreadLanding(rowStartLanding: number, tailOffset: number): number | null {
  return rowStartLanding < tailOffset - 1 ? rowStartLanding : null;
}
