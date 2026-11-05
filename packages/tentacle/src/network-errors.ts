/**
 * Network failures in words a user can act on.
 *
 * - GitHub that never answered (DNS failure, refused, timed out, TLS stall):
 *   name github.com and the proxy setting. Sign-in used to end on a bare
 *   "fetch failed" where GitHub is blocked (K-324).
 * - A relay URL that answered plain HTTP instead of a WebSocket (a reverse
 *   proxy without upgrade support): `ws` only says "Unexpected server
 *   response: 200" (K-278).
 */

/** The low-level reason: `ENOTFOUND`, `ECONNREFUSED`, `timed out`, … */
export function networkErrorReason(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; name?: string; message?: string } };
  if (e?.name === 'TimeoutError' || e?.cause?.name === 'ConnectTimeoutError') return 'timed out';
  return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
}

export function githubUnreachableMessage(err: unknown): string {
  return `Could not reach github.com (${networkErrorReason(err)}). Check your network connection; `
    + 'if you need a proxy to reach GitHub, set HTTPS_PROXY=http://host:port and try again.';
}

/** The message for a failed relay WebSocket connection. */
export function relayConnectErrorMessage(err: { message?: string } | undefined): string {
  const message = err?.message || 'Connection failed';
  const status = message.match(/^Unexpected server response: (\d+)/)?.[1];
  if (!status) return message;
  return `The server answered HTTP ${status} instead of opening a WebSocket. `
    + 'If the relay is behind a reverse proxy, let it pass WebSocket upgrades (the Upgrade and Connection headers).';
}
