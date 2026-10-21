import { randomBytes } from 'node:crypto';

/**
 * Correlates one account service call across hosts: an edge sends it with
 * every request (RemoteAuthBackend) and logs it with its own outcome; the
 * account service (AccountApi) logs it with the request and echoes it back.
 */
export const REQUEST_ID_HEADER = 'X-Kraki-Request-Id';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

export function newRequestId(): string {
  return randomBytes(6).toString('hex');
}

/** The caller's id when it is well formed, otherwise a fresh one. */
export function requestIdFrom(header: string | string[] | undefined): string {
  return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : newRequestId();
}
