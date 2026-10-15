// Recent client experience, not HTTP probe latency or relay processing time.
// All rules default to shadow-only even when infrastructure notifications are on.
export function experienceChecks(snapshot, now, config, memory) {
  const notify = config.experienceNotify === true;
  const rules = [];
  const sourceOk = snapshot?.schema === 1 && snapshot.host === config.host
    && Number.isFinite(snapshot.asOf) && now >= snapshot.asOf && now - snapshot.asOf <= 180_000;
  const check = (r) => rules.push({ severity: 'warning', failAfter: 3, recoverAfter: 3, notify, ...r });
  check({ id: 'K-INSIGHTS-DATA', ok: sourceOk, title: '体验统计任务未更新', detail: '统计文件缺失、来源不匹配或超过 3 分钟' });
  memory.experience ??= {};
  const prior = memory.experience;
  const groups = new Map((sourceOk && Array.isArray(snapshot.recent) ? snapshot.recent : []).map((g) => [g.id, g]));
  for (const [id, g] of groups) prior[id] = { title: g.title, metric: g.metric, targetMs: g.targetMs, lastAt: now };
  for (const [id, saved] of Object.entries(prior)) {
    if (now - saved.lastAt > 7 * 86400_000) { delete prior[id]; continue; }
    const g = groups.get(id);
    const fresh = sourceOk && !snapshot.quality?.scan?.backlog && !snapshot.quality?.collectionDisabled
      && g && Number.isFinite(g.latestEventAt) && now - g.latestEventAt <= 300_000;
    const label = `体验观察：${saved.title} · ${id}`;
    if (saved.targetMs) {
      check({ id: `K-EXP-P95@${id}`, unknown: !fresh || g.samples < 20, ok: !!g && g.p95Ms <= g.targetMs,
        recoverOk: !!g && g.p95Ms <= g.targetMs * 0.8,
        title: `${label} P95 超标`, detail: g ? `15 分钟 n=${g.samples}，P95=${g.p95Ms ?? '未知'} ms，目标=${g.targetMs} ms` : '暂无新样本' });
      check({ id: `K-EXP-EXTREME@${id}`, unknown: !fresh, ok: !!g && g.extreme < 3,
        title: `${label} 多次极慢`, detail: g ? `15 分钟 ${g.extreme} 次超过 max(15秒, 3倍目标)` : '暂无新样本' });
    }
    const n = g ? g.success + g.failures : 0;
    const limit = g?.metric === 'voice' ? 0.02 : 0.01;
    if (saved.metric !== 'reply') {
      check({ id: `K-EXP-FAIL@${id}`, unknown: !fresh || n < 20,
        ok: !!g && !(g.failures >= 3 && g.failureRate > limit), recoverOk: !!g && g.failureRate <= limit,
        title: `${label} 失败/超时偏多`,
        detail: g ? `15 分钟 ${g.failures}/${n} 失败（不含取消等非服务结果）` : '暂无新样本' });
    }
    if (saved.metric === 'send') check({ id: `K-EXP-SEND-PROBLEM@${id}`, unknown: !fresh || g.total < 20,
      ok: !(g?.problems >= 3 && g.problemRate > 0.01), recoverOk: !!g && g.problemRate <= 0.01, title: `${label} 频繁显示发送异常`, detail: g ? `15 分钟 ${g.problems}/${g.total} 次显示异常` : '暂无新样本' });
    if (saved.metric === 'reply') check({ id: `K-EXP-STALL@${id}`, unknown: !fresh || g.observedReplies < 20,
      ok: !(g?.stalls >= 3 && g.stallRate > 0.02), recoverOk: !!g && g.stallRate <= 0.02, title: `${label} 文本流停顿偏多`, detail: g ? `15 分钟 ${g.stalls}/${g.observedReplies} 回复有 ≥3秒停顿（不含工具执行）` : '暂无新样本' });
  }
  if (sourceOk) check({ id: 'K-EXP-PENDING', severity: 'info', notify: false,
    unknown: snapshot.quality?.scan?.backlog || snapshot.quality?.collectionDisabled,
    ok: (snapshot.pending?.explicitFailures ?? 0) < 3, title: '多条消息未确认且曾明确显示失败',
    detail: `15 分钟 ${snapshot.pending?.explicitFailures ?? 0} 条；仅排查线索，可能离线/上传不完整，不当作已丢失` });
  return { rules, notes: sourceOk ? snapshot : { unavailable: true } };
}

export function experienceDigest(snapshot, now) {
  if (!snapshot || snapshot.unavailable || !Number.isFinite(snapshot.asOf) || now - snapshot.asOf > 180_000) {
    return ['用户/体验统计  暂不可用（不是 0，也不是正常）'];
  }
  const daily = snapshot.daily;
  const lines = [];
  if (snapshot.product) {
    const p = snapshot.product;
    const r = p.registration;
    const activity = p.days?.[daily?.date];
    const dau = activity?.observedDau;
    lines.push(`用户 · ${daily?.date ?? '昨日'}（北京时间）`);
    lines.push(`  注册总数 ${r?.total ?? '未知'}（当前存量） / 昨日新增 ${r?.newByDay?.[daily?.date] ?? '未知'}`);
    lines.push(`  昨日活跃 ${dau ?? '未知'}${dau != null ? '（新版前台信号覆盖范围内）' : ''}${activity?.dayComplete ? '' : ' · 未覆盖完整一天/两地数据不全'}`);
  }
  lines.push(`体验 · ${daily?.date ?? '昨日'} · 仅已上传 iOS/Mac 样本`);
  const metrics = daily?.metrics ?? [];
  if (!metrics.length) lines.push('  暂无样本，不能判断达标；Web/Windows 未覆盖');
  const prior = new Map((snapshot.previous?.metrics ?? []).map((m) => [m.id, m]));
  // Bark is a bounded APNs payload, not a dashboard: prioritize the worst cohorts.
  const ranked = [...metrics].sort((a, b) => ((b.p95Ms ?? 0) / (b.targetMs || Infinity)) - ((a.p95Ms ?? 0) / (a.targetMs || Infinity)));
  for (const g of ranked.slice(0, 6)) {
    const ms = (n) => n == null ? '—' : `${(n / 1000).toFixed(2)}s`;
    const old = prior.get(g.id)?.p95Ms;
    const change = Number.isFinite(old) && old > 0 && Number.isFinite(g.p95Ms) ? ` 较前日${Math.round((g.p95Ms / old - 1) * 100)}%` : '';
    lines.push(`  ${g.title} ${g.platform}/${g.kind} v${g.version}：n=${g.samples} P50/95/99 ${ms(g.p50Ms)}/${ms(g.p95Ms)}/${ms(g.p99Ms)}${change}；失败 ${g.failures}/${g.success + g.failures}${g.samples < 20 ? '（样本少）' : ''}`);
  }
  if (metrics.length > 6) lines.push(`  另 ${metrics.length - 6} 组见服务器统计文件`);
  const latest = snapshot.quality?.latestEventAt;
  lines.push(`  最近事件：${Number.isFinite(latest) ? `${Math.max(0, Math.round((now - latest) / 60000))} 分钟前` : '无'}；非全量用户覆盖`);
  if (snapshot.quality?.scan?.backlog) lines.push('  数据尚在补处理，暂停体验判定');
  if (snapshot.quality?.lateArrivals) lines.push(`  最近补传旧事件 ${snapshot.quality.lateArrivals} 条，不计入当前窗口`);
  lines.push('  体验规则：观察模式（除非另行明确启用）');
  return lines;
}
