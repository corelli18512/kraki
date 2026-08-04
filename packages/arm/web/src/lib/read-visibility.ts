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
