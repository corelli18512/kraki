// Turns one run's collected snapshot into check results. Pure.
//
// `snap` (built by collect.mjs):
//   now, maintenance,
//   probes:  [{ id, target, name, severity, failAfter, local, slow, ok, ms, detail, version }]
//   units:   [{ unit, id, name, severity, active, invocationId, activeSince }]
//   disk:    { usedPct } | null
//   memHost: { availPct } | null
//   logs:    summarize() of the relay log since the previous run | null
//   metrics: relay /internal/metrics body | null
//   certs:   [{ host, daysLeft, error }] | undefined (checked hourly)
//   backup:  backup status file | null | undefined (not configured)
//
// `mem` is rules' own memory kept in state.rules (history, unit restarts).

const MIN = 60_000;
const WINDOW_MS = 10 * MIN;

export function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Counter increase since the previous sample. The first sample is only a
 * baseline (its lifetime totals are not "now"); after a relay restart
 * (`restarted`) the new totals are all new.
 */
export function counterDeltas(prev, cur, restarted = false) {
  const out = {};
  for (const [k, v] of Object.entries(cur ?? {})) {
    if (restarted) { out[k] = v; continue; }
    const p = prev?.[k];
    out[k] = typeof p === 'number' && v >= p ? v - p : 0;
  }
  return out;
}

export function evaluateRules(snap, memIn, config) {
  const mem = structuredClone(memIn ?? {});
  mem.hist ??= [];
  mem.units ??= {};
  mem.probeMs ??= {};
  const now = snap.now;
  const results = [];
  const digest = { totals: {}, peaks: {}, notes: {}, probes: [] };
  const push = (r) => results.push(r);

  // ── Probes (HTTP / WebSocket, local and remote) ─────────────────────────
  for (const p of snap.probes ?? []) {
    if (snap.maintenance && p.local) continue;
    const name = p.target ? `${p.id}@${p.target}` : p.id;
    push({ id: name, severity: p.severity, failAfter: p.failAfter ?? 3, ok: p.ok, title: p.ok ? `${p.name}正常` : `${p.name}无法访问`, detail: p.detail });
    digest.probes.push({ name: p.name, ok: p.ok });
    if (p.slow && p.ok && Number.isFinite(p.ms)) {
      const list = (mem.probeMs[name] ??= []);
      list.push(p.ms);
      while (list.length > 10) list.shift();
      const med = median(list);
      push({ id: `K-SLOW@${p.target ?? p.id}`, severity: 'warning', failAfter: 1, ok: !(list.length >= 5 && med > 2000), title: `${p.name}响应变慢`, detail: `最近 ${list.length} 次中位数 ${Math.round(med)} ms` });
    }
    if (p.version) digest.notes[`version:${p.target ?? p.id}`] = p.version;
  }

  // ── systemd units ──────────────────────────────────────────────────────
  for (const u of snap.units ?? []) {
    const m = (mem.units[u.unit] ??= { restarts: [] });
    const down = u.active !== 'active';
    if (!snap.maintenance) {
      push({ id: u.id ?? `K-SVC-FAILED@${u.unit}`, severity: u.severity, failAfter: u.active === 'failed' ? 1 : 2, ok: !down, title: `${u.name}${down ? '已停止' : '运行中'}`, detail: down ? `systemd 状态：${u.active}` : '' });
    }
    // Automatic restarts since the last run (several can happen between runs);
    // a new invocation without one is a manual/other restart.
    // NRestarts resets when the unit is started by hand: then all of it is new.
    const autoRestarts = !Number.isFinite(u.nRestarts) || !Number.isFinite(m.nRestarts) ? 0
      : u.nRestarts >= m.nRestarts ? u.nRestarts - m.nRestarts : u.nRestarts;
    if (Number.isFinite(u.nRestarts)) m.nRestarts = u.nRestarts;
    const newInvocation = u.invocationId && m.invocationId && u.invocationId !== m.invocationId;
    if ((newInvocation || autoRestarts > 0) && !snap.maintenance) {
      for (let i = 0; i < Math.max(1, autoRestarts); i++) m.restarts.push(now);
      const crash = u.unit === config.relayUnit ? snap.logs?.lastCrash : null;
      push({ id: `K-SVC-RESTART@${u.unit}`, event: true, severity: 'warning', ok: false, title: `${u.name}意外重启`, detail: crash ? `最后的错误：${crash}` : '不是部署引起的重启' });
    }
    if (u.invocationId) m.invocationId = u.invocationId;
    m.restarts = m.restarts.filter((t) => now - t < 60 * MIN);
    if (u.flap !== false) {
      push({ id: `K-SVC-FLAP@${u.unit}`, severity: 'critical', failAfter: 1, ok: m.restarts.length < 3, title: `${u.name}反复重启`, detail: `1 小时内重启 ${m.restarts.length} 次` });
    }
    if (u.unit === config.relayUnit) m.activeSince = u.activeSince ?? m.activeSince;
  }

  // ── Host resources ─────────────────────────────────────────────────────
  if (snap.disk) {
    const pct = snap.disk.usedPct;
    const sev = pct >= (config.disk?.critical ?? 95) ? 'critical' : 'warning';
    push({ id: 'K-DISK', severity: sev, failAfter: 1, ok: pct < (config.disk?.warning ?? 85), title: '磁盘快满了', detail: `已用 ${pct}%` });
    digest.notes.disk = pct;
  }
  if (snap.memHost) {
    push({ id: 'K-MEM-HOST', severity: 'warning', failAfter: 10, ok: snap.memHost.availPct >= 10, title: '整机可用内存不足', detail: `可用 ${snap.memHost.availPct}%` });
  }

  // ── Relay: health line, metrics, logs ─────────────────────────────────
  const logs = snap.logs;
  const health = logs?.health ?? null;
  const sample = { at: now, counts: logs?.counts ?? {}, pushAuth: logs?.pushAuth ?? 0, errors: logs?.errorsByMessage ?? {} };
  if (health) {
    sample.conns = health.conns;
    sample.rssMb = health.rssMb;
    sample.durableRows = health.durableRows;
    // Arrival time, not the line's own timestamp: the journal window is
    // "received since the previous run", so a line here means the loop is alive.
    mem.lastHealthAt = now;
    digest.peaks.conns = health.conns;
    digest.peaks.rssMb = health.rssMb;
    push({ id: 'K-MEM', severity: 'warning', failAfter: 10, ok: !(health.rssMb > (config.relayRssMb ?? 512)), title: 'relay 内存偏高', detail: `${health.rssMb} MB` });
  }
  if (snap.metrics?.counters) {
    const uptime = snap.metrics.uptimeSec;
    // New process: uptime went back, or systemd started a new invocation.
    const relay = (snap.units ?? []).find((x) => x.unit === config.relayUnit);
    const newProcess = (Number.isFinite(uptime) && Number.isFinite(mem.lastUptimeSec) && uptime < mem.lastUptimeSec)
      || (relay?.invocationId && mem.lastRelayInvocation && relay.invocationId !== mem.lastRelayInvocation);
    const restarted = mem.lastCounters !== undefined && Boolean(newProcess);
    if (relay?.invocationId) mem.lastRelayInvocation = relay.invocationId;
    sample.metricDeltas = counterDeltas(mem.lastCounters, snap.metrics.counters, restarted);
    // Counters back after an outage: this delta also covers the runs that
    // were already counted from logs. Take those out (push alerts only).
    const gap = [];
    for (let i = mem.hist.length - 1; i >= 0 && !mem.hist[i].metricDeltas; i--) gap.push(mem.hist[i]);
    if (gap.length > 0 && mem.lastCounters !== undefined && !restarted) {
      const d = sample.metricDeltas;
      const logged = gap.reduce((t, s) => t + (s.counts.pushFail ?? 0), 0);
      const loggedAuth = gap.reduce((t, s) => t + (s.pushAuth ?? 0), 0);
      d['push.failed'] = Math.max(0, (d['push.failed'] ?? 0) - logged);
      d['push.authError'] = Math.max(0, (d['push.authError'] ?? 0) - loggedAuth);
    }
    mem.lastCounters = snap.metrics.counters;
    mem.lastUptimeSec = uptime;
    for (const k of ['auth.ok', 'auth.fail', 'push.attempted', 'push.sent', 'push.failed', 'pulse.forwarded', 'conn.stalledClosed']) {
      digest.totals[`m:${k}`] = sample.metricDeltas[k] ?? 0;
    }
    const fh = snap.metrics.frameHandling;
    if (fh?.p99Ms != null) digest.peaks.frameP99Ms = fh.p99Ms;
  }
  for (const [k, v] of Object.entries(sample.counts)) digest.totals[`log:${k}`] = v;

  mem.hist.push(sample);
  mem.hist = mem.hist.filter((s) => now - s.at <= 60 * MIN);
  const win = mem.hist.filter((s) => now - s.at < WINDOW_MS);
  const sum = (fn) => win.reduce((t, s) => t + (fn(s) ?? 0), 0);
  const count = (cat) => sum((s) => s.counts[cat]);

  const relayUnit = (snap.units ?? []).find((u) => u.unit === config.relayUnit);
  if (relayUnit && relayUnit.active === 'active' && !snap.maintenance) {
    const since = Math.max(mem.lastHealthAt ?? 0, relayUnit.activeSince ?? 0);
    const silent = since > 0 && now - since > 3 * MIN;
    push({ id: 'K-HEALTH-SILENT', severity: 'critical', failAfter: 1, ok: !silent, title: 'relay 卡住了（health 日志停止）', detail: since ? `最后一条 ${Math.round((now - since) / MIN)} 分钟前` : '' });
  }

  if (logs) {
    // Relay counters are per final send result; logs also show intermediate
    // retry errors. Use the counters when the relay has them, logs otherwise.
    // Per run: counters when that run had them, else that run's log lines.
    const pushFail = sum((s) => (s.metricDeltas ? (s.metricDeltas['push.failed'] ?? 0) + (s.metricDeltas['push.threw'] ?? 0) : s.counts.pushFail));
    const allMetrics = win.length > 0 && win.every((s) => s.metricDeltas);
    const attempted = sum((s) => s.metricDeltas?.['push.attempted']);
    const share = allMetrics && attempted > 0 ? pushFail / attempted : null;
    push({ id: 'K-PUSH-FAIL', severity: 'warning', failAfter: 1, ok: !(pushFail >= 10 && (share === null || share > 0.2)), title: '推送大量失败', detail: `10 分钟 ${pushFail} 次失败${share === null ? '' : `（${Math.round(share * 100)}%）`}` });
    const pushAuth = sum((s) => (s.metricDeltas ? s.metricDeltas['push.authError'] ?? 0 : s.pushAuth));
    push({ id: 'K-PUSH-AUTH', severity: 'critical', failAfter: 1, ok: pushAuth < 3, title: '推送密钥失效（APNs 认证错误）', detail: `10 分钟 ${pushAuth} 次` });
    push({ id: 'K-AUTH-FAIL', severity: 'warning', failAfter: 1, ok: count('authFail') < 10, title: '登录大量失败', detail: `10 分钟 ${count('authFail')} 次` });
    push({ id: 'K-AUTH-ABUSE', severity: 'info', failAfter: 1, ok: count('authAbuse') < 100, title: '疑似暴力尝试登录', detail: `10 分钟 ${count('authAbuse')} 次` });
    push({ id: 'K-STALL', severity: 'warning', failAfter: 1, ok: count('stall') < 5, title: '大量连接因发送堆积被断开', detail: `10 分钟 ${count('stall')} 次` });
    push({ id: 'K-PULSE', severity: 'critical', failAfter: 1, ok: count('pulse') < 1, title: '可靠传输层数据出错（可能丢消息）', detail: `10 分钟 ${count('pulse')} 次` });
    push({ id: 'K-REGION', severity: 'warning', failAfter: 1, ok: count('region') < 3, title: '东京与国内之间同步出错', detail: `10 分钟 ${count('region')} 次` });
    push({ id: 'K-VOICE-ERR', severity: 'warning', failAfter: 1, ok: count('voice') < 1, title: '语音计费写入失败', detail: `10 分钟 ${count('voice')} 次` });
    const errs = {};
    for (const s of win) for (const [k, v] of Object.entries(s.errors)) errs[k] = (errs[k] ?? 0) + v;
    const totalErrs = Object.values(errs).reduce((a, b) => a + b, 0);
    const top = Object.entries(errs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ×${v}`).join('；');
    push({ id: 'K-ERRORS', severity: 'warning', failAfter: 1, ok: totalErrs < 20, title: 'relay 错误日志偏多', detail: `10 分钟 ${totalErrs} 条：${top}` });
  }

  const withRows = mem.hist.filter((s) => Number.isFinite(s.durableRows));
  if (withRows.length > 0) {
    const latest = withRows[withRows.length - 1].durableRows;
    const old = withRows.find((s) => now - s.at >= 30 * MIN);
    push({ id: 'K-DURABLE', severity: 'warning', failAfter: 1, ok: !(old && latest > 1000 && latest > old.durableRows), title: '待送达的离线消息在堆积', detail: `${old?.durableRows ?? '?'} → ${latest}（30 分钟）` });
  }
  // A deploy drops every connection on purpose: forget the baseline.
  if (snap.maintenance) for (const s of mem.hist) delete s.conns;
  const withConns = mem.hist.filter((s) => Number.isFinite(s.conns));
  if (withConns.length > 1 && !snap.maintenance) {
    const cur = withConns[withConns.length - 1].conns;
    const before = withConns.filter((s) => now - s.at <= 5 * MIN && s !== withConns[withConns.length - 1]).map((s) => s.conns);
    const peak = before.length ? Math.max(...before) : 0;
    push({ id: 'K-CONN-DROP', severity: 'warning', failAfter: 1, ok: !(peak >= 3 && cur < peak * 0.3), title: '大量客户端同时掉线', detail: `5 分钟内 ${peak} → ${cur}` });
  }

  // ── Certificates (hourly) ──────────────────────────────────────────────
  for (const c of snap.certs ?? []) {
    const id = `K-CERT@${c.host}`;
    if (c.error) {
      push({ id, severity: 'warning', failAfter: 3, ok: false, title: `无法检查 ${c.host} 的证书`, detail: c.error });
      continue;
    }
    push({ id, severity: c.daysLeft < 3 ? 'critical' : 'warning', failAfter: 1, ok: c.daysLeft >= 14, title: `${c.host} 证书快到期`, detail: `还剩 ${c.daysLeft} 天` });
    digest.notes[`cert:${c.host}`] = c.daysLeft;
  }

  // ── Backups ────────────────────────────────────────────────────────────
  if (snap.backup !== undefined) {
    const b = snap.backup;
    const age = b?.at ? now - Date.parse(b.at) : Number.POSITIVE_INFINITY;
    const failed = !b || b.ok === false || age > 26 * 60 * MIN;
    push({ id: 'K-BACKUP', severity: 'critical', failAfter: 1, ok: !failed, title: '数据库备份失败或过期', detail: !b ? '没有备份记录' : b.ok === false ? `最近一次失败：${b.error ?? ''}` : `最近成功 ${Math.round(age / 3600_000)} 小时前` });
    if (b?.ok) {
      push({ id: 'K-BACKUP-COPY', severity: 'critical', failAfter: 1, ok: b.copied !== false, title: '备份复制到另一台服务器失败', detail: b.copyError ?? '' });
      const shrank = b.prevSizeBytes > 0 && b.sizeBytes < b.prevSizeBytes * 0.5;
      push({ id: 'K-BACKUP-SIZE', severity: 'warning', failAfter: 1, ok: !shrank, title: '新备份比前一天小了一半以上', detail: `${b.prevSizeBytes} → ${b.sizeBytes} 字节` });
      digest.notes.backup = { at: b.at, sizeBytes: b.sizeBytes, copied: b.copied };
    } else {
      digest.notes.backup = { failed: true };
    }
  }

  // ── Versions (info) ────────────────────────────────────────────────────
  const versions = [...new Set(Object.entries(digest.notes).filter(([k]) => k.startsWith('version:')).map(([, v]) => v))];
  if (versions.length > 0) push({ id: 'K-VERSION', severity: 'info', failAfter: 1, ok: versions.length === 1, title: '两台 relay 版本不一致', detail: versions.join(' / ') });

  return { results, mem, digest };
}
