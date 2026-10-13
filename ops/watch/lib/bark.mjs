// Bark delivery (https://github.com/Finb/Bark). One POST per notification.

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

export async function sendBark(n, { server = 'https://api.day.app', deviceKey, fetchImpl = fetch, attempts = 3 } = {}) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(`${server.replace(/\/$/, '')}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(barkPayload(n, deviceKey)),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { ok: true };
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err?.message ?? String(err);
    }
    if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  return { ok: false, error: lastError };
}
