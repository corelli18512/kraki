// Daily summary text. Pure.
import { localParts, minutesText } from './engine.mjs';

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

  const avail = Object.entries(day.probes).map(([name, p]) => `${name} ${pct(p)}`);
  if (avail.length) lines.push(`可用性  ${avail.join('  ')}`);

  const fired = day.incidents.filter((i) => i.severity !== 'info');
  lines.push(`告警  紧急 ${day.fired.critical}  警告 ${day.fired.warning}  信息 ${day.fired.info}`);
  for (const i of fired.slice(-6)) {
    const span = i.endedAt ? `${minutesText(i.endedAt - i.startedAt)}，已恢复` : '仍未恢复';
    lines.push(`  · ${localParts(i.startedAt, tz).hm} ${i.title}（${span}）`);
  }
  for (const [id, a] of Object.entries(state.alerts)) {
    if (a.status === 'firing' && a.severity !== 'info' && !incidentIds.has(id)) lines.push(`  · 仍未恢复：${a.title}`);
  }

  const t = day.totals;
  const pk = day.peaks;
  const conn = [];
  if (Number.isFinite(pk.conns)) conn.push(`峰值 ${pk.conns}`);
  if (t['m:auth.ok'] !== undefined) conn.push(`登录 ${t['m:auth.ok']}`);
  else if (t['log:login'] !== undefined) conn.push(`登录 ${t['log:login']}`);
  if (t['m:auth.fail']) conn.push(`登录失败 ${t['m:auth.fail']}`);
  if (conn.length) lines.push(`连接  ${conn.join(' / ')}`);

  const pushParts = [];
  if (t['m:push.attempted'] !== undefined) pushParts.push(`成功 ${t['m:push.sent'] ?? 0} / 失败 ${t['m:push.failed'] ?? 0}`);
  else pushParts.push(`失败 ${t['log:pushFail'] ?? 0}`);
  lines.push(`推送  ${pushParts.join(' ')}`);
  if (t['m:pulse.forwarded'] !== undefined) lines.push(`转发消息  ${t['m:pulse.forwarded']}  relay 处理 p99 峰值 ${pk.frameP99Ms ?? '—'} ms`);

  const res = [];
  if (Number.isFinite(pk.rssMb)) res.push(`relay 内存峰值 ${pk.rssMb} MB`);
  if (day.notes.disk !== undefined) res.push(`磁盘 ${day.notes.disk}%`);
  if (res.length) lines.push(`资源  ${res.join('  ')}`);

  const b = day.notes.backup;
  if (b) lines.push(b.failed ? '备份  ✗ 失败' : `备份  ✓ ${localParts(Date.parse(b.at), tz).hm} ${(b.sizeBytes / 1048576).toFixed(1)} MB${b.copied === true ? ' 已复制' : b.copied === false ? ' 复制失败' : ''}`);

  const certs = Object.entries(day.notes).filter(([k]) => k.startsWith('cert:')).map(([k, v]) => [k.slice(5), v]).sort((a, b) => a[1] - b[1]);
  if (certs.length) lines.push(`证书  最近到期 ${certs[0][0]} 还有 ${certs[0][1]} 天`);
  const versions = Object.entries(day.notes).filter(([k]) => k.startsWith('version:')).map(([k, v]) => `${k.slice(8)} ${v}`);
  if (versions.length) lines.push(`版本  ${versions.join(' / ')}`);

  return {
    kind: 'digest',
    severity: problems > 0 ? 'warning' : 'info',
    title: `Kraki 日报 · ${label} · ${problems > 0 ? `${problems} 个问题` : '全部正常'}`,
    body: lines.join('\n'),
    quiet: false,
  };
}
