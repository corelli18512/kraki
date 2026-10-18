// Performance data upload for the Web client (lib/diag). The page signs the
// request with its device key; this only carries it, under fixed rules:
// https (or loopback http) origin only, the two collector paths only, an
// allowlisted header set, a bounded body, no redirects (a redirect must not
// carry the signed headers elsewhere), and a short timeout.

const PATHS = { config: 'GET', batch: 'POST' };
const HEADERS = ['X-Kraki-Device', 'X-Kraki-Time', 'X-Kraki-Request', 'X-Kraki-Signature', 'Content-Encoding', 'Content-Type'];
const MAX_BODY = 64 * 1024;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The validated request, or null. */
function validate(req) {
  if (!req || typeof req !== 'object' || typeof req.base !== 'string' || !Object.hasOwn(PATHS, req.path)) return null;
  let base;
  try { base = new URL(req.base); } catch { return null; }
  const ok = base.protocol === 'https:' || (base.protocol === 'http:' && LOOPBACK.has(base.hostname));
  if (!ok || base.username || base.password || base.origin !== req.base) return null;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (!HEADERS.includes(k) || typeof v !== 'string' || v.length > 1024) return null;
    headers[k] = v;
  }
  const method = PATHS[req.path];
  let body;
  if (method === 'POST') {
    if (!(req.body instanceof Uint8Array) || req.body.byteLength === 0 || req.body.byteLength > MAX_BODY) return null;
    body = req.body;
  } else if (req.body !== undefined) return null;
  return { url: `${base.origin}/api/diag/v1/${req.path}`, method, headers, body };
}

async function request(fetchImpl, req, timeoutMs = 20_000) {
  const v = validate(req);
  if (!v) return { status: 0, body: '' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(v.url, { method: v.method, headers: v.headers, body: v.body, redirect: 'manual', signal: controller.signal, credentials: 'omit', cache: 'no-store' });
    const text = (await res.text()).slice(0, 4096);
    return { status: res.status, body: text };
  } catch { return { status: 0, body: '' }; }
  finally { clearTimeout(timer); }
}

module.exports = { validate, request };
