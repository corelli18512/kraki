/**
 * Desktop shell bridge (packages/desktop, Electron). The preload script
 * exposes `window.krakiDesktop`; in a normal browser it is undefined and every
 * helper here is a no-op, so the Web app runs unchanged in both.
 */
export interface KrakiDesktopBridge {
  platform: string;
  version: string;
  /** Origin GitHub redirects back to after OAuth (the shell intercepts it). */
  oauthRedirectOrigin: string;
  notify: (n: { title: string; body: string; sessionId?: string }) => void;
  setBadge: (count: number) => void;
  onOpenSession: (handler: (sessionId: string) => void) => () => void;
}

declare global {
  interface Window { krakiDesktop?: KrakiDesktopBridge }
}

export const desktop: KrakiDesktopBridge | undefined =
  typeof window !== 'undefined' ? window.krakiDesktop : undefined;

export const isDesktop = !!desktop;

/** Whether the user is looking at this session right now. */
function isWatching(sessionId: string): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
    && window.location.pathname === `/session/${sessionId}`;
}

const recent = new Map<string, number>();

/** A native notification for something that needs the user — only in the
 *  desktop shell (browsers get Web Push), never for the session in view, and
 *  at most one per session per few seconds. */
export function notifyDesktop(sessionId: string, title: string, body: string): void {
  if (!desktop || isWatching(sessionId)) return;
  const now = Date.now();
  if ((recent.get(sessionId) ?? 0) > now - 3_000) return;
  recent.set(sessionId, now);
  desktop.notify({ title, body: body.replace(/\s+/g, ' ').trim().slice(0, 180), sessionId });
}
