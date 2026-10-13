// Relay log parsing for kraki-watch. Pure.
//
// The relay writes one line per event to stdout (captured by journald):
//   "◈ [2026-10-13T14:39:54.763Z] health {"conns":0,...}"
//   "❌ [2026-10-12T13:24:41.233Z] APNs request error {"error":"read ECONNRESET"}"
// Prefix: ◈ info, ⚠️ warn, ❌ error, 🔍 debug.

const LINE = /^(◈|⚠️|❌|🔍)\s*\[([^\]]+)\]\s+(.*?)(?:\s+(\{.*\}))?\s*$/u;
const LEVEL = { '◈': 'info', '⚠️': 'warn', '❌': 'error', '🔍': 'debug' };

export function parseLine(line) {
  const m = LINE.exec(line);
  if (!m) return null;
  let data = null;
  if (m[4]) {
    try { data = JSON.parse(m[4]); } catch { data = null; }
  }
  const at = Date.parse(m[2]);
  return { level: LEVEL[m[1]], at: Number.isNaN(at) ? null : at, message: m[3], data };
}

/** Messages counted by name. Anything else at error level counts as `other-error`. */
export const TRACKED = {
  pushFail: ['APNs send failed', 'APNs request error', 'APNs request timed out', 'Web push send failed', 'Push notification send failed', 'Push send threw unexpectedly'],
  authFail: ['GitHub auth failed', 'GitHub code exchange failed', 'Device registration failed'],
  authAbuse: ['Auth throttled', 'Auth rejected', 'API key auth failed', 'Challenge-response auth failed', 'Pairing auth failed: invalid or expired token', 'Open auth failed: invalid shared key'],
  stall: ['Closing stalled connection (send buffer full)'],
  pulse: ['pulse-hub dropped unreadable snapshot', 'pulse-hub gc tick failed'],
  region: ['Edge announce failed', 'Edge announce rejected', 'Failed to fetch account service config', 'Edge region announce failed (continuing)'],
  voice: ['Voice lease persist failed'],
  crash: ['Uncaught exception — exiting', 'Unhandled promise rejection'],
  login: ['Device authenticated (via backend)', 'Device authenticated'],
};
const CATEGORY = new Map(Object.entries(TRACKED).flatMap(([cat, msgs]) => msgs.map((m) => [m, cat])));
const PUSH_AUTH = /ProviderToken|Forbidden|BadCertificate|BadTopic|TopicDisallowed/;

/**
 * Summarize log lines (oldest first) into one per-minute sample.
 * `health` is the latest health line's data; `errorsByMessage` counts
 * error-level messages not otherwise categorized.
 */
export function summarize(lines) {
  const out = { counts: {}, pushAuth: 0, errorsByMessage: {}, health: null, healthAt: null, lastCrash: null };
  for (const raw of lines) {
    const e = parseLine(raw);
    if (!e) continue;
    if (e.message === 'health' && e.data) {
      out.health = e.data;
      out.healthAt = e.at;
      continue;
    }
    const cat = CATEGORY.get(e.message);
    if (cat) {
      out.counts[cat] = (out.counts[cat] ?? 0) + 1;
      if (cat === 'pushFail' && PUSH_AUTH.test(String(e.data?.reason ?? e.data?.error ?? ''))) out.pushAuth += 1;
      if (cat === 'crash') out.lastCrash = String(e.data?.error ?? e.message).split('\n')[0].slice(0, 160);
      continue;
    }
    if (e.level === 'error') out.errorsByMessage[e.message] = (out.errorsByMessage[e.message] ?? 0) + 1;
  }
  return out;
}
