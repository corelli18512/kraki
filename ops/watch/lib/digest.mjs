// Daily summary text. Pure.
import { localParts, minutesText } from './engine.mjs';
import { experienceDigest } from './experience.mjs';

function pct(p) {
  if (!p || p.checks === 0) return '—';
  const v = ((p.checks - p.fails) / p.checks) * 100;
  return v === 100 ? '100%' : `${v.toFixed(v >= 99 ? 2 : 1)}%`;
}

export function formatDigest(state, now, config) {
  const day = state.day;
  const label = config.label ?? config.host;
  const tz = config.timezone;
  const incidentIds = new Set(day.incidents.filter((i) => i.severity !== 'info').map((i) => i.id));
  const problems = incidentIds.size + Object.entries(state.alerts).filter(([id, a]) => a.status === 'firing' && a.severity !== 'info' && !incidentIds.has(id)).length;
  const lines = [];
  const critical = Object.values(state.alerts).filter(a => a.status === 'firing' && a.severity === 'critical');
  if (critical.length) lines.push(`Critical issues: ${critical.length} — ${critical.slice(0, 2).map(a => a.title).join('; ')}${critical.length > 2 ? '…' : ''}`, '');
  if (config.insightsPath) {
    const observed = day.incidents.filter(i => i.id.startsWith('K-EXP-')).length;
    lines.push(`Experience observations: ${observed} rule hits this period (not necessarily notified)`, ...experienceDigest(day.notes.insights, now), '');
  }

  const avail = Object.entries(day.probes).map(([name, p]) => `${name} ${pct(p)}`);
  if (avail.length) lines.push(`Availability  ${avail.join('  ')}`);

  const fired = day.incidents.filter((i) => i.severity !== 'info');
  lines.push(`Alerts  critical ${day.fired.critical}  warning ${day.fired.warning}  info ${day.fired.info}`);
  for (const i of fired.slice(-6)) {
    const span = i.endedAt ? `${minutesText(i.endedAt - i.startedAt)}, recovered` : state.alerts[i.id]?.unknown ? 'insufficient data; recovery unconfirmed' : 'unresolved';
    const title = !i.endedAt && state.alerts[i.id]?.status === 'firing' ? state.alerts[i.id].title : i.title;
    lines.push(`  · ${localParts(i.startedAt, tz).hm} ${title} (${span})`);
  }
  for (const [id, a] of Object.entries(state.alerts)) {
    if (a.status === 'firing' && a.severity !== 'info' && !incidentIds.has(id)) lines.push(`  · ${a.unknown ? 'Insufficient data; recovery unconfirmed' : 'Unresolved'}: ${a.title}`);
  }

  const t = day.totals;
  const pk = day.peaks;
  const conn = [];
  if (Number.isFinite(pk.conns)) conn.push(`peak ${pk.conns}`);
  if (t['m:auth.ok'] !== undefined) conn.push(`sign-ins ${t['m:auth.ok']}`);
  else if (t['log:login'] !== undefined) conn.push(`sign-ins ${t['log:login']}`);
  if (t['m:auth.fail']) conn.push(`failed sign-ins ${t['m:auth.fail']}`);
  if (conn.length) lines.push(`Connections  ${conn.join(' / ')}`);

  const pushParts = [];
  if (t['m:push.attempted'] !== undefined) pushParts.push(`sent ${t['m:push.sent'] ?? 0} / failed ${t['m:push.failed'] ?? 0}`);
  else pushParts.push(`failed ${t['log:pushFail'] ?? 0}`);
  lines.push(`Push  ${pushParts.join(' ')}`);
  if (t['m:pulse.forwarded'] !== undefined) lines.push(`Forwarded messages  ${t['m:pulse.forwarded']}  peak relay processing P99 ${pk.frameP99Ms ?? '—'} ms`);

  const res = [];
  if (Number.isFinite(pk.rssMb)) res.push(`peak relay memory ${pk.rssMb} MB`);
  if (day.notes.disk !== undefined) res.push(`disk ${day.notes.disk}%`);
  if (res.length) lines.push(`Resources  ${res.join('  ')}`);

  const b = day.notes.backup;
  if (b) {
    // Older state collapsed missing status and execution failure into `failed`.
    // Do not turn that ambiguous cached note into a claim that a backup ran.
    const age = now - Date.parse(b.at);
    const valid = !b.failed && Number.isFinite(age) && age >= -120_000 && Number.isFinite(b.sizeBytes) && b.sizeBytes > 0;
    const cachedStatus = b.status ?? (valid ? (age > 26 * 3600_000 ? 'stale' : 'ok') : 'unknown');
    const status = cachedStatus === 'ok' && !valid ? 'invalid' : cachedStatus;
    const labels = { missing: '? Status missing; check scheduled backups', invalid: '? Invalid status; backup availability unconfirmed',
      unknown: '? Incomplete legacy status; awaiting a fresh check', failed: '✗ Latest job record reports failure', stale: '✗ Last successful record is over 26 hours old' };
    lines.push(`Backup  ${status === 'ok' ? `✓ ${localParts(Date.parse(b.at), tz).hm} ${(b.sizeBytes / 1048576).toFixed(1)} MB${b.copied === true ? ' copied' : b.copied === false ? ' copy failed' : ''}` : labels[status] ?? labels.unknown}`);
  }

  const certs = Object.entries(day.notes).filter(([k]) => k.startsWith('cert:')).map(([k, v]) => [k.slice(5), v]).sort((a, b) => a[1] - b[1]);
  if (certs.length) lines.push(`Certificates  next expiry ${certs[0][0]} in ${certs[0][1]} days`);
  const versions = Object.entries(day.notes).filter(([k]) => k.startsWith('version:')).map(([k, v]) => `${k.slice(8)} ${v}`);
  if (versions.length) lines.push(`Versions  ${versions.join(' / ')}`);

  return {
    kind: 'digest',
    severity: problems > 0 ? 'warning' : 'info',
    title: `Kraki Daily · ${label} · ${problems > 0 ? `${problems} issue${problems === 1 ? '' : 's'}` : config.insightsPath ? 'Core checks healthy · Experience under observation' : 'All checks healthy'}`,
    body: lines.join('\n'),
    quiet: false,
  };
}
