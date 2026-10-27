/**
 * Chooses the address the relay listens on.
 *
 * `open` auth without a shared key lets anyone who can reach the port join
 * the `local` account and drive its computers. That mode therefore listens
 * on loopback by default, and refuses a non-loopback host until
 * OPEN_SHARED_KEY is set. Every other mode keeps Node's default bind (all
 * interfaces) unless a host is set.
 */

import { isIP } from 'node:net';

export const LOOPBACK_HOST = '127.0.0.1';

export interface ListenHostInput {
  /** KRAKI_HOST env / --host flag; empty when unset. */
  host: string;
  authModes: readonly string[];
  /** OPEN_SHARED_KEY env / --open-shared-key flag; empty when unset. */
  openSharedKey: string;
  /** Edge/connected mode delegates auth, so local auth modes do not apply. */
  connectedMode: boolean;
}

export type ListenHostResult =
  /** `host` undefined means Node's default (all interfaces). */
  | { ok: true; host: string | undefined }
  | { ok: false; error: string };

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (h === 'localhost') return true;
  if (isIP(h) === 4) return h.startsWith('127.');
  if (isIP(h) === 6) return h === '::1' || /^::ffff:127\./.test(h);
  return false;
}

export function resolveListenHost(input: ListenHostInput): ListenHostResult {
  // Node's listen() wants a bare IPv6 address; `[::1]` would fail DNS lookup and crash the relay.
  const host = input.host.trim().replace(/^\[(.*)\]$/, '$1');
  const openWithoutKey = !input.connectedMode
    && input.authModes.includes('open')
    && !input.openSharedKey;

  if (!openWithoutKey) return { ok: true, host: host || undefined };
  if (!host) return { ok: true, host: LOOPBACK_HOST };
  if (isLoopbackHost(host)) return { ok: true, host };

  return {
    ok: false,
    error:
      `Refusing to listen on ${host}: auth mode "open" without a shared key lets anyone who can reach ` +
      'this port control your computers.\n' +
      '  Set OPEN_SHARED_KEY=<long random secret> (and put the same secret in ~/.kraki/channel.key on each computer),\n' +
      '  or use --auth github / --auth apikey, or listen on loopback only (unset KRAKI_HOST or use --host 127.0.0.1).',
  };
}
