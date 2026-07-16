import { wsClient } from './ws-client';

/** Thin page-lifecycle boundary kept separate so React page tests do not need to
 * know the subscription controller internals. */
export function setDesiredSessionSubscription(sessionId: string | null): void {
  if (typeof wsClient.setDesiredSession === 'function') wsClient.setDesiredSession(sessionId);
}
