// Bark delivery (https://github.com/Finb/Bark). One POST per notification.
import { deliveryConfig } from './config.mjs';

/** Bark request body for a kraki-watch notification. Pure. */
export function barkPayload(n, deviceKey) {
  const base = { device_key: deviceKey, title: n.title, body: n.body || ' ', isArchive: '1' };
  if (n.kind === 'digest') return { ...base, level: 'active', group: 'Kraki 日报' };
  if (n.severity === 'critical' && (n.kind === 'fire' || n.kind === 'repeat')) {
    // critical: rings through silent mode and Focus; call: rings for ~30 s.
    return { ...base, level: 'critical', volume: '8', call: '1', group: 'Kraki 紧急' };
  }
  if (n.kind === 'resolve') return { ...base, level: n.quiet ? 'passive' : 'active', group: n.severity === 'critical' ? 'Kraki 紧急' : 'Kraki 警告' };
  return { ...base, level: 'timeSensitive', group: 'Kraki 警告' };
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
