// Bark delivery (https://github.com/Finb/Bark). One POST per notification.
import { deliveryConfig } from './config.mjs';

/** Bark request body for a kraki-watch notification. Pure. */
export function barkPayload(n, deviceKey) {
  const shorten = (s, bytes) => {
    if (Buffer.byteLength(s, 'utf8') <= bytes) return s;
    let out = '', size = 0;
    for (const c of s) { size += Buffer.byteLength(c, 'utf8'); if (size > bytes - 3) return out + '…'; out += c; }
    return out;
  };
  const base = { device_key: deviceKey, title: shorten(n.title, 256), body: shorten(n.body || ' ', 2700), isArchive: '1' };
  // Leave APNs envelope headroom (4 KB limit), including JSON escaping. Keep
  // full aggregates on the server; an oversized digest must not be lost.
  while (Buffer.byteLength(JSON.stringify(base), 'utf8') > 3000) {
    if (Buffer.byteLength(base.body, 'utf8') <= 32) throw new Error('Bark payload envelope too large');
    base.body = shorten(base.body, Math.max(32, Buffer.byteLength(base.body, 'utf8') - 256));
  }
  // Digest severity describes its contents, never an interruption escalation.
  // Bark bundles silence.caf; also avoid its default audible sound as a fallback.
  if (n.kind === 'digest') return { ...base, level: 'passive', sound: 'silence', group: 'Kraki Daily' };
  if (n.severity === 'critical' && (n.kind === 'fire' || n.kind === 'repeat')) {
    // critical: rings through silent mode and Focus; call: rings for ~30 s.
    return { ...base, level: 'critical', volume: '8', call: '1', group: 'Kraki Critical' };
  }
  if (n.kind === 'resolve') return { ...base, level: n.quiet ? 'passive' : 'active', group: n.severity === 'critical' ? 'Kraki Critical' : 'Kraki Warnings' };
  return { ...base, level: 'timeSensitive', group: 'Kraki Warnings' };
}

export async function sendBark(n, { server = 'https://api.day.app', deviceKey, fetchImpl = fetch, attempts = 3, timeoutMs = 10_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const { errors } = deliveryConfig({ KRAKI_WATCH_NOTIFY: '1', BARK_KEY: deviceKey, BARK_SERVER: server });
  if (errors.length) return { ok: false, error: errors.join('; ') };
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(`${server.replace(/\/$/, '')}/push`, {
        method: 'POST',
        // Do not forward the device key to a redirect target.
        redirect: 'error',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(barkPayload(n, deviceKey)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const data = await res.json();
        // HTTP 200 from a proxy/login page is not a successful Bark push.
        if (data?.code === 200) return { ok: true };
        lastError = Number.isInteger(data?.code) ? `Bark code ${data.code}` : 'Invalid Bark response';
      } else {
        lastError = `HTTP ${res.status}`;
        await res.body?.cancel();
      }
    } catch (err) {
      // Upstream bodies and exception messages may contain credentials.
      lastError = ['TimeoutError', 'AbortError'].includes(err?.name) ? 'Bark request timed out' : 'Bark request failed or returned invalid JSON';
    }
    if (i + 1 < attempts) await sleep(1000 * (i + 1));
  }
  return { ok: false, error: lastError };
}
