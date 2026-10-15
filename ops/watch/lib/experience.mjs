// Recent client experience, not HTTP probe latency or relay processing time.
// All rules default to shadow-only even when infrastructure notifications are on.
export function experienceChecks(snapshot, now, config, memory) {
  const notify = config.experienceNotify === true;
  const rules = [];
  const sourceOk = snapshot?.schema === 1 && snapshot.host === config.host
    && Number.isFinite(snapshot.asOf) && now >= snapshot.asOf && now - snapshot.asOf <= 180_000;
  const check = (r) => rules.push({ severity: 'warning', failAfter: 3, recoverAfter: 3, notify, ...r });
  check({ id: 'K-INSIGHTS-DATA', ok: sourceOk, title: 'Experience statistics not refreshed', detail: 'Statistics missing, source mismatch, or snapshot older than 3 min' });
  memory.experience ??= {};
  const prior = memory.experience;
  const groups = new Map((sourceOk && Array.isArray(snapshot.recent) ? snapshot.recent : []).map((g) => [g.id, g]));
  for (const [id, g] of groups) prior[id] = { title: g.title, metric: g.metric, targetMs: g.targetMs, lastAt: now };
  for (const [id, saved] of Object.entries(prior)) {
    if (now - saved.lastAt > 7 * 86400_000) { delete prior[id]; continue; }
    const g = groups.get(id);
    const fresh = sourceOk && !snapshot.quality?.scan?.backlog && !snapshot.quality?.collectionDisabled
      && g && Number.isFinite(g.latestEventAt) && now - g.latestEventAt <= 300_000;
    const label = `Experience: ${saved.title} · ${id}`;
    if (saved.targetMs) {
      check({ id: `K-EXP-P95@${id}`, unknown: !fresh || g.samples < 20, ok: !!g && g.p95Ms <= g.targetMs,
        recoverOk: !!g && g.p95Ms <= g.targetMs * 0.8,
        title: `${label} P95 above target`, detail: g ? `15 min: n=${g.samples}, P95=${g.p95Ms ?? 'unknown'} ms, target=${g.targetMs} ms` : 'No fresh samples' });
      check({ id: `K-EXP-EXTREME@${id}`, unknown: !fresh, ok: !!g && g.extreme < 3,
        title: `${label} repeated extreme latency`, detail: g ? `${g.extreme} events above max(15s, 3× target) in 15 min` : 'No fresh samples' });
    }
    const n = g ? g.success + g.failures : 0;
    const limit = g?.metric === 'voice' ? 0.02 : 0.01;
    if (saved.metric !== 'reply') {
      check({ id: `K-EXP-FAIL@${id}`, unknown: !fresh || n < 20,
        ok: !!g && !(g.failures >= 3 && g.failureRate > limit), recoverOk: !!g && g.failureRate <= limit,
        title: `${label} elevated failures/timeouts`,
        detail: g ? `15 min: ${g.failures}/${n} failures (excludes cancellations and other non-service outcomes)` : 'No fresh samples' });
    }
    if (saved.metric === 'send') check({ id: `K-EXP-SEND-PROBLEM@${id}`, unknown: !fresh || g.total < 20,
      ok: !(g?.problems >= 3 && g.problemRate > 0.01), recoverOk: !!g && g.problemRate <= 0.01, title: `${label} frequent send warnings shown`, detail: g ? `15 min: ${g.problems}/${g.total} sends showed warnings` : 'No fresh samples' });
    if (saved.metric === 'reply') check({ id: `K-EXP-STALL@${id}`, unknown: !fresh || g.observedReplies < 20,
      ok: !(g?.stalls >= 3 && g.stallRate > 0.02), recoverOk: !!g && g.stallRate <= 0.02, title: `${label} frequent text-stream stalls`, detail: g ? `15 min: ${g.stalls}/${g.observedReplies} replies had stalls ≥3s (excludes tool execution)` : 'No fresh samples' });
  }
  if (sourceOk) check({ id: 'K-EXP-PENDING', severity: 'info', notify: false,
    unknown: snapshot.quality?.scan?.backlog || snapshot.quality?.collectionDisabled,
    ok: (snapshot.pending?.explicitFailures ?? 0) < 3, title: 'Multiple unconfirmed sends previously showed failure',
    detail: `${snapshot.pending?.explicitFailures ?? 0} in 15 min; investigation only, possibly offline/incomplete uploads, not proof of loss` });
  return { rules, notes: sourceOk ? snapshot : { unavailable: true } };
}

export function experienceDigest(snapshot, now) {
  if (!snapshot || snapshot.unavailable || !Number.isFinite(snapshot.asOf) || now - snapshot.asOf > 180_000) {
    return ['Account/experience statistics  unavailable (not zero or healthy)'];
  }
  const daily = snapshot.daily;
  const lines = [];
  if (snapshot.product) {
    const p = snapshot.product;
    const r = p.registration;
    const activity = p.days?.[daily?.date];
    const dau = activity?.observedDau;
    lines.push(`Accounts · ${daily?.date ?? 'yesterday'} (Beijing time)`);
    lines.push(`  Registered ${r?.total ?? 'unknown'} (currently retained) / new yesterday ${r?.newByDay?.[daily?.date] ?? 'unknown'}`);
    lines.push(`  Active yesterday ${dau ?? 'unknown'}${dau != null ? ' (new foreground-reporting clients only)' : ''}${activity?.dayComplete ? '' : ' · Partial day or incomplete regional coverage'}`);
  }
  lines.push(`Experience · ${daily?.date ?? 'yesterday'} · Uploaded iOS/Mac samples only`);
  const metrics = daily?.metrics ?? [];
  if (!metrics.length) lines.push('  No samples; performance unknown. Web/Windows not covered.');
  const prior = new Map((snapshot.previous?.metrics ?? []).map((m) => [m.id, m]));
  // Bark is a bounded APNs payload, not a dashboard: prioritize the worst cohorts.
  const ranked = [...metrics].sort((a, b) => ((b.p95Ms ?? 0) / (b.targetMs || Infinity)) - ((a.p95Ms ?? 0) / (a.targetMs || Infinity)));
  for (const g of ranked.slice(0, 6)) {
    const ms = (n) => n == null ? '—' : `${(n / 1000).toFixed(2)}s`;
    const old = prior.get(g.id)?.p95Ms;
    const change = Number.isFinite(old) && old > 0 && Number.isFinite(g.p95Ms) ? ` ${Math.round((g.p95Ms / old - 1) * 100)}% vs prior day` : '';
    lines.push(`  ${g.title} ${g.platform}/${g.kind} v${g.version}: n=${g.samples} P50/95/99 ${ms(g.p50Ms)}/${ms(g.p95Ms)}/${ms(g.p99Ms)}${change}; failures ${g.failures}/${g.success + g.failures}${g.incomplete ? ` incomplete ${g.incomplete}` : ''}${g.cancelled ? ` cancelled ${g.cancelled}` : ''}${g.samples < 20 ? ' (small sample)' : ''}`);
  }
  if (metrics.length > 6) lines.push(`  ${metrics.length - 6} more cohorts in server statistics`);
  if (snapshot.pending?.unresolved) lines.push(`  ${snapshot.pending.unresolved} recent unresolved sends (unconfirmed, not proof of loss)`);
  const excluded = Object.values(daily?.excluded ?? {}).reduce((sum, n) => sum + n, 0);
  if (excluded) lines.push(`  Excluded ${excluded} samples marked offline/background/restored, permission/quota, etc.`);
  const latest = snapshot.quality?.latestEventAt;
  lines.push(`  Latest event: ${Number.isFinite(latest) ? `${Math.max(0, Math.round((now - latest) / 60000))} min ago` : 'none'}; not full-user coverage`);
  if (snapshot.quality?.scan?.backlog) lines.push('  Processing backlog; experience evaluation paused');
  if (snapshot.quality?.lateArrivals) lines.push(`  ${snapshot.quality.lateArrivals} late older events received; not added to the current window`);
  lines.push('  Experience rules: observation only unless separately enabled');
  return lines;
}
