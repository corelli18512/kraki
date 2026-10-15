import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { experienceChecks, experienceDigest } from '../lib/experience.mjs';
import { emptyState, evaluate } from '../lib/engine.mjs';
import { barkPayload } from '../lib/bark.mjs';
import { deliveryConfig } from '../lib/config.mjs';
import { formatDigest } from '../lib/digest.mjs';

const NOW = Date.parse('2026-10-15T06:00:00Z');
const config = { host: 'tokyo', timezone: 'Asia/Shanghai', quietHours: [23, 8] };
const id = 'send/ios/1.0(1)/typed';
const group = { id, metric: 'send', title: 'Send confirmation', samples: 20, total: 20, success: 20, failures: 0,
  p95Ms: 6000, p50Ms: 1000, p99Ms: 7000, targetMs: 5000, extreme: 0, problems: 0, failureRate: 0, problemRate: 0 };
function snapshot(now, over = {}) {
  return { schema: 1, host: 'tokyo', asOf: now, recent: [{ ...group, latestEventAt: now, ...over }], quality: { scan: {} }, pending: { explicitFailures: 0 } };
}

test('Python aggregation tests run in the existing watch CI lane', () => {
  execFileSync('python3', ['-m', 'unittest', '-v', 'test_insights.py'], { cwd: fileURLToPath(new URL('../../insights/', import.meta.url)), stdio: 'pipe' });
});

test('P95 needs enough samples and sustained breaches; observation never sends', () => {
  let state = emptyState(); const mem = {};
  for (let i = 0; i < 2; i++) {
    const now = NOW + i * 60000;
    state = evaluate(state, experienceChecks(snapshot(now), now, config, mem).rules, now, config).state;
    assert.notEqual(state.alerts[`K-EXP-P95@${id}`].status, 'firing');
  }
  const now = NOW + 120000;
  const out = evaluate(state, experienceChecks(snapshot(now), now, config, mem).rules, now, config);
  assert.equal(out.state.alerts[`K-EXP-P95@${id}`].status, 'firing');
  assert.deepEqual(out.notifications, []);
  assert.equal(experienceChecks(snapshot(now, { samples: 1 }), now, config, mem).rules.find(r => r.id === `K-EXP-P95@${id}`).unknown, true);
});

test('enough new healthy samples recover, but stale/no data does not claim recovery', () => {
  let state = emptyState(); const mem = {};
  for (let i = 0; i < 3; i++) state = evaluate(state, experienceChecks(snapshot(NOW), NOW, config, mem).rules, NOW, config).state;
  state = evaluate(state, experienceChecks(null, NOW+200000, config, mem).rules, NOW+200000, config).state;
  assert.equal(state.alerts[`K-EXP-P95@${id}`].status, 'firing');
  assert.equal(state.alerts[`K-EXP-P95@${id}`].unknown, true);
  for (let i = 0; i < 5; i++) state = evaluate(state, experienceChecks(snapshot(NOW+240000, { p95Ms: 4900 }), NOW+240000, config, mem).rules, NOW+240000, config).state;
  assert.equal(state.alerts[`K-EXP-P95@${id}`].status, 'firing', 'borderline values must not flap');
  for (let i = 0; i < 3; i++) {
    state = evaluate(state, experienceChecks(snapshot(NOW+240000, { p95Ms: 4000 }), NOW+240000, config, mem).rules, NOW+240000, config).state;
    assert.equal(state.alerts[`K-EXP-P95@${id}`].status, i < 2 ? 'firing' : 'ok');
  }
});

test('explicit enable emits a warning, never a critical ring merely for exceeding P95', () => {
  let state = emptyState(); const mem = {}; let out;
  for (let i = 0; i < 3; i++) {
    out = evaluate(state, experienceChecks(snapshot(NOW), NOW, { ...config, experienceNotify: true }, mem).rules, NOW, config);
    state = out.state;
  }
  assert.equal(out.notifications.length, 1);
  assert.equal(out.notifications[0].severity, 'warning');
});

test('agent first-text time is observation-only; low-volume extreme sends still have a rule', () => {
  const mem = {};
  const s = snapshot(NOW, { metric: 'reply', id: 'reply/ios/1/all', targetMs: null, p95Ms: 100000, observedReplies: 1, stalls: 0 });
  assert.ok(!experienceChecks(s, NOW, config, mem).rules.some(r => r.id.startsWith('K-EXP-P95')));
  const r = experienceChecks(snapshot(NOW, { samples: 3, total: 3, extreme: 3 }), NOW, config, {}).rules;
  assert.equal(r.find(x => x.id.startsWith('K-EXP-P95')).unknown, true);
  assert.equal(r.find(x => x.id.startsWith('K-EXP-EXTREME')).ok, false);
});

test('backlog and old uploads pause judgments instead of turning into current slow requests', () => {
  for (const over of [{ scan: { backlog: true } }, { collectionDisabled: true }]) {
    const s = snapshot(NOW); s.quality = over;
    assert.ok(experienceChecks(s, NOW, config, {}).rules.find(r => r.id.startsWith('K-EXP-P95')).unknown);
  }
  assert.ok(experienceChecks(snapshot(NOW, { latestEventAt: NOW-600000 }), NOW, config, {}).rules.find(r => r.id.startsWith('K-EXP-P95')).unknown);
});

test('digest shows unknown versus zero, coverage and bounded Unicode/JSON payloads', () => {
  const s = snapshot(NOW); s.daily = { date: '2026-10-14', metrics: [] };
  s.product = { registration: { total: 5, newByDay: { '2026-10-14': 0 } }, days: { '2026-10-14': { observedDau: null, dayComplete: false } } };
  const body = experienceDigest(s, NOW).join('\n');
  assert.match(body, /Registered 5/); assert.match(body, /new yesterday 0/); assert.match(body, /Active yesterday unknown/); assert.match(body, /No samples/);
  const payload = barkPayload({ kind: 'digest', title: '日报'.repeat(500), body: ('😊中文"\\').repeat(2000) }, 'test-key');
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 3500);
  assert.ok(!payload.body.includes('\uFFFD'));
});

test('digest never titles missing experience coverage all healthy, and puts critical gaps before large stats', () => {
  const state = emptyState();
  const cfg = { ...config, insightsPath: '/private/summary.json' };
  assert.ok(!formatDigest(state, NOW, cfg).title.includes('All checks healthy'));
  state.alerts.backup = { status: 'firing', severity: 'critical', title: 'Backup missing' };
  const note = formatDigest(state, NOW, cfg);
  assert.ok(note.body.startsWith('Critical issues: 1 — Backup missing'));
});

test('digest delivery can be enabled while alarms remain shadow; requires a key', () => {
  assert.ok(deliveryConfig({ KRAKI_WATCH_DIGEST_NOTIFY: '1' }).errors.length);
  const result = deliveryConfig({ KRAKI_WATCH_NOTIFY: '0', KRAKI_WATCH_DIGEST_NOTIFY: '1', BARK_KEY: 'test-key' });
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some(w => w.includes('daily digest delivery is enabled')));
});
