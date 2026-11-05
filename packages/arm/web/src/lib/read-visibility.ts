/**
 * Ephemeral UI guard for a manual "mark unread" on the currently open Chat.
 *
 * Tentacle remains the durable authority. This set is deliberately not stored
 * in Zustand/IndexedDB: it only prevents focus/visibility hooks in the current
 * mounted view from immediately undoing the user's manual action.
 */
const suppressedAutoReadSessions = new Set<string>();

export function suppressAutoRead(sessionId: string): void {
  suppressedAutoReadSessions.add(sessionId);
}

export function allowAutoRead(sessionId: string): void {
  suppressedAutoReadSessions.delete(sessionId);
}

export function isAutoReadSuppressed(sessionId: string): boolean {
  return suppressedAutoReadSessions.has(sessionId);
}

/**
 * Reads this browser sent (`mark_read`) that no session list or snapshot has
 * shown applied yet. A list the Tentacle built before the read reached it (a
 * reconnect, or simply in flight) must not undo it: the read is kept and sent
 * once more (K-095). Any session_read, or Mark Unread here, ends the tracking.
 */
const unconfirmedReads = new Map<string, number>();

export function noteSentRead(sessionId: string, seq: number): void {
  unconfirmedReads.set(sessionId, Math.max(seq, unconfirmedReads.get(sessionId) ?? 0));
}

export function forgetSentRead(sessionId: string): void {
  unconfirmedReads.delete(sessionId);
}

/** The Tentacle's read cursor arrived in a session list or snapshot. Returns
 *  the read this browser sent that it does not include yet (keep it and send
 *  it again), else undefined. The read is no longer tracked either way. */
export function takeUnappliedRead(sessionId: string, tentacleReadSeq: number): number | undefined {
  const sent = unconfirmedReads.get(sessionId);
  unconfirmedReads.delete(sessionId);
  return sent !== undefined && sent > tentacleReadSeq ? sent : undefined;
}
