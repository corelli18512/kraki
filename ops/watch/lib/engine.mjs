// Alert state machine for kraki-watch. Pure: no I/O, `now` is passed in.
//
// A check result is { id, severity: 'critical'|'warning'|'info', ok, title,
// detail?, failAfter? }. One result per check per run; a check that did not
// run this time (e.g. hourly certificate checks) is simply absent and its
// state is left untouched.
//
// Rules (docs: ops/watch/README.md):
// - A check must fail `failAfter` runs in a row (default 1) before it fires.
// - Critical: notify immediately (even in quiet hours, ringing), repeat every
//   30 min while it lasts, notify once on recovery.
// - Warning: notify, repeat at most every 6 h; in quiet hours the message is
//   deferred and sent in one batch when quiet hours end.
// - Info: never notified on its own; only counted for the daily summary.
// - A warning that turns critical (disk 85% → 95%) fires again as critical.
// - `event: true` results are one-off (an unplanned restart): notified once,
//   no repeat and no recovery message.

export const REPEAT_MS = { critical: 30 * 60_000, warning: 6 * 3600_000 };
const RANK = { info: 0, warning: 1, critical: 2 };

/** Local wall-clock parts in `timeZone`. */
export function localParts(now, timeZone) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), hm: `${p.hour}:${p.minute}` };
}

/** Quiet hours [start, end) in local hours; wraps midnight (e.g. [23, 8]). */
export function inQuietHours(now, config) {
  const [start, end] = config.quietHours ?? [23, 8];
  const { hour } = localParts(now, config.timezone);
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function minutesText(ms) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} 小时 ${m % 60} 分钟` : `${h} 小时`;
}

export function emptyState() {
  return { alerts: {}, deferred: [], day: newDay(), lastDigestDate: null };
}

export function newDay(startedAt = null) {
  return { startedAt, incidents: [], fired: { critical: 0, warning: 0, info: 0 }, totals: {}, peaks: {}, probes: {}, notes: {} };
}

/**
 * Advance the alert state with this run's results.
 * Returns { state, notifications } where each notification is
 * { kind: 'fire'|'repeat'|'resolve'|'deferred'|'digest', severity, title, body, quiet }.
 */
export function evaluate(prev, results, now, config) {
  const state = structuredClone(prev ?? emptyState());
  state.day ??= newDay(now);
  state.day.startedAt ??= now;
  const notes = [];
  const quiet = inQuietHours(now, config);
  const label = config.label ?? config.host;

  for (const r of results) {
    if (r.event) {
      // One-off events (an unplanned restart): notify once, nothing to recover.
      if (r.ok) continue;
      state.day.fired[r.severity] += 1;
      state.day.incidents.push({ id: r.id, severity: r.severity, title: r.title, startedAt: now, endedAt: now });
      if (r.severity !== 'info') notes.push(message('fire', r.severity, `${label}：${r.title}`, r.detail, quiet));
      continue;
    }
    const a = state.alerts[r.id] ?? { status: 'ok', fails: 0 };
    state.alerts[r.id] = a;
    a.title = r.title;
    if (!r.ok) {
      a.fails += 1;
      a.firstFailAt ??= now;
      a.detail = r.detail ?? '';
      const due = a.fails >= (r.failAfter ?? 1);
      if (!due) continue;
      const escalated = a.status === 'firing' && RANK[r.severity] > RANK[a.severity];
      if (a.status === 'firing' && RANK[r.severity] < RANK[a.severity]) {
        // Eased (disk 96% → 88%): same incident, lower level from now on.
        a.severity = r.severity;
        const open = openIncident(state, r.id);
        if (open) open.severity = r.severity;
      }
      if (a.status !== 'firing' || escalated) {
        if (escalated) {
          // The warning incident becomes the critical one: one incident, one recovery.
          const open = openIncident(state, r.id);
          if (open) open.endedAt = now;
        }
        a.status = 'firing';
        a.severity = r.severity;
        a.firedAt = now;
        a.lastNotifiedAt = now;
        state.day.fired[r.severity] += 1;
        state.day.incidents.push({ id: r.id, severity: r.severity, title: r.title, startedAt: a.firstFailAt, endedAt: null });
        if (r.severity === 'info') continue;
        notes.push(message('fire', r.severity, `${label}：${r.title}`, a.detail, quiet));
      } else if (r.severity !== 'info' && now - a.lastNotifiedAt >= REPEAT_MS[a.severity]) {
        a.lastNotifiedAt = now;
        notes.push(message('repeat', a.severity, `${label}：${r.title}（仍未恢复 · 已持续 ${minutesText(now - a.firstFailAt)}）`, a.detail, quiet));
      }
    } else {
      if (a.status === 'firing') {
        const lasted = minutesText(now - a.firstFailAt);
        for (const i of state.day.incidents) if (i.id === r.id && i.endedAt === null) i.endedAt = now;
        if (a.severity !== 'info') notes.push(message('resolve', a.severity, `${label}：已恢复 · ${r.title}`, `持续 ${lasted}`, quiet));
      }
      state.alerts[r.id] = { status: 'ok', fails: 0, title: r.title };
    }
  }

  // Deliver: critical always now; warnings and recoveries of warnings wait out quiet hours.
  const notifications = [];
  for (const n of notes) {
    if (n.severity === 'warning' && quiet) state.deferred.push({ ...n, at: now });
    else notifications.push(n);
  }
  if (!quiet && state.deferred.length > 0) {
    const lines = state.deferred.map((d) => `${localParts(d.at, config.timezone).hm} ${d.title}${d.body ? ` — ${d.body}` : ''}`);
    notifications.push({ kind: 'deferred', severity: 'warning', title: `${label}：夜间 ${state.deferred.length} 条警告`, body: lines.join('\n'), quiet: false });
    state.deferred = [];
  }
  return { state, notifications };
}

function openIncident(state, id) {
  return [...state.day.incidents].reverse().find((i) => i.id === id && i.endedAt === null);
}

/**
 * Re-apply the current quiet-hours policy to messages that failed to deliver
 * earlier: warnings wait for the morning batch again, recoveries take the
 * current loudness. Returns the ones to send now.
 */
export function routeRetries(state, retries, now, config) {
  const quiet = inQuietHours(now, config);
  const now_ = [];
  for (const n of retries) {
    if (quiet && n.severity === 'warning' && n.kind !== 'digest') state.deferred.push({ ...n, at: n.at ?? now });
    else now_.push({ ...n, quiet: n.kind === 'resolve' ? quiet : n.quiet });
  }
  return now_;
}

function message(kind, severity, title, body, quiet) {
  return { kind, severity, title, body: body ?? '', quiet };
}

/** Whether the daily summary is due now (once per local date, at/after digestHour). */
export function digestDue(state, now, config) {
  const { date, hour } = localParts(now, config.timezone);
  return hour >= (config.digestHour ?? 9) && state.lastDigestDate !== date;
}

/** Mark the summary sent and start a new day of accumulators. */
export function rollDigest(state, now, config) {
  const next = structuredClone(state);
  next.lastDigestDate = localParts(now, config.timezone).date;
  next.day = newDay(now);
  return next;
}

/** Add `values` into the day's totals (counters) and peaks (maxima). */
export function accumulate(state, { totals = {}, peaks = {} } = {}) {
  const day = state.day;
  for (const [k, v] of Object.entries(totals)) if (Number.isFinite(v)) day.totals[k] = (day.totals[k] ?? 0) + v;
  for (const [k, v] of Object.entries(peaks)) if (Number.isFinite(v)) day.peaks[k] = Math.max(day.peaks[k] ?? Number.NEGATIVE_INFINITY, v);
}

/** Count a probe outcome for the summary's availability line. */
export function recordProbe(state, name, ok) {
  const p = (state.day.probes[name] ??= { checks: 0, fails: 0 });
  p.checks += 1;
  if (!ok) p.fails += 1;
}
