import { getStore } from './store-adapter';

/** Check if a session is currently being viewed. */
export function isViewingSession(sessionId: string): boolean {
  // Check store first (set by useEffect), fall back to URL for synchronous accuracy
  const storeId = getStore().activeSessionId;
  if (storeId) return storeId === sessionId;
  return window.location.pathname === `/session/${sessionId}`;
}

/**
 * Simplified replay state for the thin relay protocol.
 * The relay no longer stores or replays messages — the app relies on
 * localStorage cache (zustand persist) for offline data.
 * Read state is tracked locally.
 */
export class ReplayState {
  replaying = false;

  /** No-op — the thin relay does not support server-side replay. */
  startReplay(_send: (msg: Record<string, unknown>) => void): void {
    // Intentionally empty — app uses localStorage cache
  }

  reset(): void {
    this.replaying = false;
    getStore().setReplaying(false);
  }

  /** Mark a session as read (local-only). */
  markRead(sessionId: string): void {
    getStore().clearUnread(sessionId);
  }
}
