// Delivery preflight: never print values (keys and heartbeat URLs are secrets).
// This is a local configuration check, not proof of phone delivery.
export function safeEndpoint(value, { base = false } = {}) {
  try {
    const u = new URL(value);
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname);
    return (u.protocol === 'https:' || (u.protocol === 'http:' && loopback))
      && !u.username && !u.password && !u.hash && (!base || !u.search);
  } catch { return false; }
}

export function deliveryConfig(env, { requireLive = false } = {}) {
  const errors = [];
  const warnings = [];
  const notify = env.KRAKI_WATCH_NOTIFY ?? '0';
  if (!['0', '1'].includes(notify)) errors.push('KRAKI_WATCH_NOTIFY must be 0 or 1');
  if (requireLive && notify !== '1') errors.push('test-notify requires KRAKI_WATCH_NOTIFY=1 (shadow mode sends nothing)');
  if (notify === '1' && !env.BARK_KEY) errors.push('BARK_KEY is required when notifications are enabled');
  if (env.BARK_KEY && /[\s/?#]/.test(env.BARK_KEY)) errors.push('BARK_KEY must be the key only, not the full Bark URL');
  if (!safeEndpoint(env.BARK_SERVER || 'https://api.day.app', { base: true })) {
    errors.push('BARK_SERVER must be an HTTPS base URL without credentials, query or fragment (HTTP allowed only on loopback)');
  }
  if (env.HC_PING_URL && !safeEndpoint(env.HC_PING_URL)) errors.push('HC_PING_URL must be an HTTPS URL without credentials or fragment (HTTP allowed only on loopback)');
  if (!env.HC_PING_URL) warnings.push('HC_PING_URL not configured: an independent dead-man check is still required');
  if (notify === '0') warnings.push('shadow mode: no Bark notifications will be sent');
  return { errors, warnings };
}
