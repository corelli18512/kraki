import type { IncomingMessage } from 'http';

/**
 * The client's IP address, for logs, rate limits and region suggestions.
 *
 * `X-Forwarded-For` is only believed when the connection comes from a trusted
 * reverse proxy (loopback by default — the relay runs behind Caddy/nginx on
 * the same host — plus any address in `KRAKI_TRUSTED_PROXIES`, comma
 * separated). Anyone else could send the header to pose as another address.
 * The proxy appends the address it saw, so the rightmost entry is the one to
 * use; entries to its left are whatever the client claimed.
 */
export function clientIp(req: IncomingMessage | undefined, trustedProxies = configuredTrustedProxies()): string {
  const peer = normalize(req?.socket?.remoteAddress);
  if (!peer) return 'unknown';
  if (!isTrustedProxy(peer, trustedProxies)) return peer;
  const header = req?.headers['x-forwarded-for'];
  const value = Array.isArray(header) ? header.join(',') : header;
  const forwarded = value?.split(',').map((part) => part.trim()).filter(Boolean).at(-1);
  return normalize(forwarded) ?? peer;
}

export function isTrustedProxy(address: string, trustedProxies: ReadonlySet<string>): boolean {
  return address === '127.0.0.1' || address === '::1' || trustedProxies.has(address);
}

function configuredTrustedProxies(): Set<string> {
  return new Set((process.env.KRAKI_TRUSTED_PROXIES ?? '').split(',').map((s) => normalize(s.trim())).filter((s): s is string => !!s));
}

function normalize(address: string | undefined): string | undefined {
  if (!address) return undefined;
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}
