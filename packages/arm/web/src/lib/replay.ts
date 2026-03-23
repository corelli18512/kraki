import { getStore } from './store-adapter';

/** Check if a session is currently being viewed. */
export function isViewingSession(sessionId: string): boolean {
  // Check store first (set by useEffect), fall back to URL for synchronous accuracy
  const storeId = getStore().activeSessionId;
  if (storeId) return storeId === sessionId;
  return window.location.pathname === `/session/${sessionId}`;
}

/** Mark a session as read (local-only). */
export function markSessionRead(sessionId: string): void {
  getStore().clearUnread(sessionId);
}
