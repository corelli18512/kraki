// A phone briefing, not a diagnostic dump. The original full report is retained.
import { formatDigest } from './digest.mjs';
import { localParts } from './engine.mjs';

const RANK = { critical: 0, warning: 1, info: 2 };
const FLOW = { send: 'send confirmation', open: 'opening a session', outage: 'connection recovery',
  voice: 'voice transcription', ready: 'content loading' };
const PLATFORM = { ios: 'iOS', mac: 'Mac' };
const fresh = (at, now) => Number.isFinite(at) && at <= now && now - at <= 180_000;
const count = n => Number.isInteger(n) && n >= 0 ? String(n) : 'unavailable';
const line = text => [...String(text).replace(/\s+/g, ' ').trim()].slice(0, 100).join('');

function attention(state) {
  const active = Object.entries(state.alerts).filter(([, a]) => a.status === 'firing' && a.severity !== 'info');
  // An active service outage takes precedence over missing backup evidence.
  active.sort(([aId, a], [bId, b]) => (RANK[a.severity] ?? 2) - (RANK[b.severity] ?? 2)
    || Number(aId.startsWith('K-BACKUP')) - Number(bId.startsWith('K-BACKUP')));
  if (!active.length) return null;
  const [id, a] = active[0];
  let text = a.title;
  if (id === 'K-BACKUP') {
    const status = state.day.notes.backup?.status;
    text = status === 'failed' ? 'the latest backup job failed.'
      : status === 'stale' ? 'the latest successful backup is overdue.' : 'verify scheduled backups.';
  } else if (id.startsWith('K-EXP-')) text = 'review the experience observations.';
  if (a.unknown) text = 'an unresolved issue needs fresh data.';
  return `Needs attention: ${line(text)}${active.length > 1 ? ` (+${active.length - 1} more)` : ''}`;
}

function serviceStatus(state, now, config) {
  if (!fresh(state.lastRunAt, now)) return 'Services: current check results unavailable.';
  const ids = [
    ...(config.probes ?? []).map(p => p.target ? `${p.id}@${p.target}` : p.id),
    ...(config.units ?? []).map(u => u.id ?? `K-SVC-FAILED@${u.unit}`),
  ];
  if (!ids.length) return 'Services: no checks configured.';
  const checks = ids.map(id => state.alerts[id]);
  const missing = checks.filter(a => !a || a.unknown).length;
  const failing = checks.filter(a => a && !a.unknown && (a.fails > 0 || a.status === 'firing')).length;
  if (failing) return `Services: ${failing} check${failing === 1 ? '' : 's'} failing${missing ? `; ${missing} unavailable` : ''}.`;
  if (missing) return `Services: ${missing} check${missing === 1 ? '' : 's'} unavailable.`;
  return 'Services: latest recorded checks passed.';
}

function experience(snapshot) {
  if (snapshot.quality?.collectionDisabled) return ['Experience: diagnostic collection is paused.'];
  if (snapshot.quality?.scan?.backlog) return ['Experience: data processing is incomplete.'];
  const metrics = snapshot.daily?.metrics ?? [];
  if (!metrics.length) return ['Experience: no uploaded samples.'];
  const candidates = metrics.filter(g => FLOW[g.metric] && PLATFORM[g.platform]).map(g => {
    const slow = g.samples >= 20 && Number.isFinite(g.p95Ms) && g.p95Ms > 0
      && Number.isFinite(g.targetMs) && g.targetMs > 0 && g.p95Ms > g.targetMs;
    const failureLimit = g.metric === 'voice' ? 0.02 : 0.01;
    const failing = g.success + g.failures >= 20 && g.failures >= 3 && g.failureRate > failureLimit;
    return { g, slow, failing, score: Math.max(slow ? g.p95Ms / g.targetMs : 0, failing ? g.failureRate / failureLimit : 0) };
  }).filter(c => c.slow || c.failing).sort((a, b) => b.score - a.score);
  if (!candidates.length) return ['Experience: limited samples; no overall rating.'];
  const { g, slow } = candidates[0];
  // Describe one existing cohort. Never average or combine cohort percentiles.
  // Round the upper bound UP so the sentence remains true after formatting.
  const seconds = (Math.ceil(g.p95Ms / 100) / 10).toFixed(1);
  const timing = slow ? `95% of ${g.samples} timed successes took ≤${seconds}s; ${g.failures} failures.`
    : `${g.failures} failures; ${g.success} successes.`;
  const other = [g.cancelled ? `${g.cancelled} cancelled` : '', g.incomplete ? `${g.incomplete} unfinished` : ''].filter(Boolean);
  return [`Worth a look: ${FLOW[g.metric]} on ${PLATFORM[g.platform]} (one version).`,
    `${timing}${other.length ? ` ${other.join(' · ')}.` : ''}`];
}

/** Full diagnostic record and a separate, short English notification. Pure. */
export function formatDigestDelivery(state, now, config) {
  const report = formatDigest(state, now, config);
  const lines = [];
  const issue = attention(state);
  if (issue) lines.push(issue);
  lines.push(serviceStatus(state, now, config));
  const recovered = new Set(state.day.incidents.filter(i => i.severity !== 'info' && i.endedAt != null).map(i => i.id));
  if (recovered.size) lines[lines.length - 1] += ` ${recovered.size} earlier issue${recovered.size === 1 ? '' : 's'} recovered.`;
  if (config.insightsPath) {
    const snapshot = state.day.notes.insights;
    if (!snapshot || snapshot.unavailable || snapshot.schema !== 1 || snapshot.host !== config.host || !fresh(snapshot.asOf, now)) {
      lines.push('Usage and experience: fresh statistics unavailable.');
    } else {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(snapshot.daily?.date ?? '') ? snapshot.daily.date
        : localParts(now - 86400_000, config.timezone).date;
      const label = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
      lines.push('', `${label} · Beijing time`);
      if (snapshot.product) {
        const p = snapshot.product, activity = p.days?.[date];
        lines.push(`Accounts now: ${count(p.registration?.total)} · New: ${count(p.registration?.newByDay?.[date])}`);
        const known = activity?.hostsComplete === true && Number.isInteger(activity.observedDau) && activity.observedDau >= 0;
        lines.push(`Active: ${known ? activity.observedDau : 'unavailable'} (new clients only${known && !activity.dayComplete ? '; partial day' : ''}).`);
      }
      lines.push(...experience(snapshot));
      if (snapshot.daily?.metrics?.length) lines.push('Uploaded samples only—not all users.');
    }
  }
  const notification = { ...report, title: `Kraki Daily · ${line(config.label ?? config.host)}`, body: lines.join('\n') };
  return { report, notification };
}
