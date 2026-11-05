/**
 * A request to GitHub that never got an answer (DNS failure, refused, timed
 * out, TLS stall), as a message that names github.com and the proxy setting.
 * Sign-in used to end on a bare "fetch failed" where GitHub is blocked
 * (K-324).
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
