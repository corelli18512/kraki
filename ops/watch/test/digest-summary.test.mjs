import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDigestDelivery } from '../lib/digest-summary.mjs';
import { formatDigest } from '../lib/digest.mjs';
import { emptyState } from '../lib/engine.mjs';
import { barkPayload } from '../lib/bark.mjs';

const NOW = Date.parse('2026-10-15T06:00:00Z');
const DATE = '2026-10-14';
const config = { host: 'tokyo', label: 'Tokyo', timezone: 'Asia/Shanghai', insightsPath: '/private/summary.json',
  probes: [{ id: 'K-RELAY-DOWN', target: 'tokyo', name: 'Tokyo relay' }], units: [{ unit: 'kraki-relay' }] };
const cohort = over => ({ id: 'ready/ios/1.0(1)/warm:wifi', metric: 'ready', title: 'Content ready', platform: 'ios', version: '1.0(1)',
  kind: 'warm:wifi', samples: 26, success: 26, failures: 2, total: 28, failureRate: 2 / 28, targetMs: 3000,
  p50Ms: 1260, p95Ms: 5120, p99Ms: 5230, ...over });
function fixture() {
  const state = emptyState(); state.lastRunAt = NOW;
  state.alerts = { 'K-RELAY-DOWN@tokyo': { status: 'ok', fails: 0 }, 'K-SVC-FAILED@kraki-relay': { status: 'ok', fails: 0 },
    'K-BACKUP': { status: 'firing', severity: 'critical', title: 'Database backup status missing' } };
  state.day.notes.backup = { status: 'missing' };
  state.day.notes.insights = { schema: 1, host: 'tokyo', asOf: NOW, daily: { date: DATE, metrics: [] }, quality: { scan: {} },
    product: { registration: { total: 10, newByDay: { [DATE]: 0 } }, days: { [DATE]: { observedDau: null, hostsComplete: true, dayComplete: false } } } };
  return state;
}

test('phone briefing uses plain English and keeps the original full report intact', () => {
  const state = fixture(), before = structuredClone(state);
  const { notification, report } = formatDigestDelivery(state, NOW, config);
  assert.equal(notification.title, 'Kraki Daily · Tokyo');
  assert.equal(notification.body, [
    'Needs attention: verify scheduled backups.', 'Services: latest recorded checks passed.', '', 'Oct 14 · Beijing time',
    'Accounts now: 10 · New: 0', 'Active: unavailable (new clients only).', 'Experience: no uploaded samples.',
  ].join('\n'));
  assert.deepEqual(report, formatDigest(state, NOW, config));
  assert.match(report.body, /Database backup status missing/);
  assert.deepEqual(state, before, 'presentation must not modify state or severity');
  const payload = barkPayload(notification, 'test');
  assert.equal(payload.level, 'passive'); assert.equal(payload.sound, 'silence');
  assert.equal(payload.call, undefined); assert.equal(payload.volume, undefined);
});

test('missing, failed and stale backups do not become the same assertion', () => {
  for (const [status, expected] of [['missing', 'verify scheduled backups'], ['invalid', 'verify scheduled backups'],
    ['failed', 'latest backup job failed'], ['stale', 'successful backup is overdue']]) {
    const state = fixture(); state.day.notes.backup.status = status;
    const { notification } = formatDigestDelivery(state, NOW, config);
    assert.ok(notification.body.includes(expected));
    if (status === 'missing' || status === 'invalid') assert.doesNotMatch(notification.body, /job failed/);
  }
});

test('unknown activity stays unknown; observed zero remains coverage-limited', () => {
  const state = fixture(); const day = state.day.notes.insights.product.days[DATE];
  day.observedDau = 0; day.dayComplete = false;
  assert.match(formatDigestDelivery(state, NOW, config).notification.body, /Active: 0 \(new clients only; partial day\)/);
  day.hostsComplete = false;
  assert.match(formatDigestDelivery(state, NOW, config).notification.body, /Active: unavailable/);
  state.day.notes.insights.product.registration = null;
  assert.match(formatDigestDelivery(state, NOW, config).notification.body, /Accounts now: unavailable · New: unavailable/);
});

test('stale, future, missing and wrong-host statistics never produce reassuring counts', () => {
  for (const modify of [s => { s.asOf = NOW - 180001; }, s => { s.asOf = NOW + 1; }, s => { s.host = 'wrong'; }]) {
    const state = fixture(); modify(state.day.notes.insights);
    const body = formatDigestDelivery(state, NOW, config).notification.body;
    assert.match(body, /fresh statistics unavailable/); assert.doesNotMatch(body, /Accounts now: 10|Active: 0/);
  }
  const state = fixture(); delete state.day.notes.insights;
  assert.match(formatDigestDelivery(state, NOW, config).notification.body, /fresh statistics unavailable/);
});

test('one useful cohort replaces six percentile/version tables without hiding failures', () => {
  const state = fixture(); const snapshot = state.day.notes.insights;
  snapshot.daily.metrics = [cohort(), cohort({ id: 'ready/mac/2/cold', platform: 'mac', samples: 1, p95Ms: 99000 }),
    cohort({ id: 'reply/mac/3/all', platform: 'mac', metric: 'reply', targetMs: null, p95Ms: 999999 })];
  const { notification, report } = formatDigestDelivery(state, NOW, config);
  assert.match(notification.body, /Worth a look: content loading on iOS \(one version\)/);
  assert.match(notification.body, /95% of 26 timed successes took ≤5\.2s; 2 failures/);
  assert.doesNotMatch(notification.body, /P50|P95|P99|v1\.0|warm:wifi|99\.0|reply/);
  assert.match(notification.body, /Uploaded samples only—not all users/);
  assert.match(report.body, /P50\/95\/99/); assert.match(report.body, /v1\.0\(1\)/);
  assert.ok(notification.body.length < 650);
  assert.ok(notification.body.split('\n').filter(Boolean).length <= 8);
});

test('failure-only highlights keep cancellations and unfinished outcomes separate', () => {
  const state = fixture(); state.day.notes.insights.daily.metrics = [cohort({ samples: 0, p95Ms: null, success: 17,
    failures: 3, failureRate: .15, cancelled: 4, incomplete: 2 })];
  const body = formatDigestDelivery(state, NOW, config).notification.body;
  assert.match(body, /3 failures; 17 successes/); assert.match(body, /4 cancelled · 2 unfinished/);
  assert.doesNotMatch(body, /95%|NaN|All checks healthy/);
});

test('small samples, processing backlog and disabled collection cannot imply healthy experience', () => {
  for (const [quality, text] of [[{ scan: {} }, 'limited samples; no overall rating'],
    [{ scan: { backlog: true } }, 'data processing is incomplete'], [{ collectionDisabled: true }, 'collection is paused']]) {
    const state = fixture(); const snapshot = state.day.notes.insights;
    snapshot.daily.metrics = [cohort({ samples: 1, success: 1, failures: 0, total: 1, failureRate: 0 })]; snapshot.quality = quality;
    const body = formatDigestDelivery(state, NOW, config).notification.body;
    assert.ok(body.includes(text)); assert.doesNotMatch(body, /Worth a look|All checks healthy/);
  }
});

test('failing, missing and stale service checks cannot render as passing', () => {
  const state = fixture(); state.alerts['K-RELAY-DOWN@tokyo'].fails = 1;
  assert.match(formatDigestDelivery(state, NOW, config).notification.body, /Services: 1 check failing/);
  delete state.alerts['K-RELAY-DOWN@tokyo'];
  assert.match(formatDigestDelivery(state, NOW, config).notification.body, /Services: 1 check unavailable/);
  state.lastRunAt = NOW - 180001;
  assert.match(formatDigestDelivery(state, NOW, config).notification.body, /current check results unavailable/);
});

test('a current outage outranks the backup gap; recovered incidents remain visible', () => {
  const state = fixture(); state.alerts['K-RELAY-DOWN@tokyo'] = { status: 'firing', severity: 'critical', fails: 3, title: 'Tokyo relay unreachable' };
  state.day.incidents = [{ id: 'old', severity: 'warning', title: 'Recovered issue', startedAt: NOW - 60000, endedAt: NOW },
    { id: 'deploy', severity: 'info', title: 'Planned deployment', startedAt: NOW, endedAt: NOW }];
  const body = formatDigestDelivery(state, NOW, config).notification.body;
  assert.ok(body.startsWith('Needs attention: Tokyo relay unreachable (+1 more)'));
  assert.match(body, /1 earlier issue recovered/);
  state.alerts['K-RELAY-DOWN@tokyo'].unknown = true;
  assert.match(formatDigestDelivery(state, NOW, config).notification.body, /unresolved issue needs fresh data/);
});

test('China shows regional experience without inventing or adding mirrored account counts', () => {
  const state = fixture(); const snapshot = state.day.notes.insights; snapshot.host = 'cn'; delete snapshot.product;
  snapshot.daily.metrics = [cohort()];
  const body = formatDigestDelivery(state, NOW, { ...config, host: 'cn', label: 'China' }).notification.body;
  assert.doesNotMatch(body, /Accounts now|Active:/); assert.match(body, /content loading on iOS/);
});
