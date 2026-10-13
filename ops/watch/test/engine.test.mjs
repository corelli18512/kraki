import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digestDue, emptyState, evaluate, inQuietHours, rollDigest, routeRetries } from '../lib/engine.mjs';

const config = { host: 'cn', label: '国内', timezone: 'Asia/Shanghai', quietHours: [23, 8], digestHour: 9 };
// 2026-10-13 14:00 Beijing = 06:00Z
const DAY = Date.parse('2026-10-13T06:00:00Z');
const NIGHT = Date.parse('2026-10-13T17:00:00Z'); // 01:00 Beijing
const MIN = 60_000;

const down = (over = {}) => ({ id: 'K-RELAY-DOWN@cn', severity: 'critical', failAfter: 3, ok: false, title: '国内 relay无法访问', detail: 'HTTP 502', ...over });
const up = (over = {}) => ({ ...down(over), ok: true });

function runSeq(results, start, cfg = config) {
  let state = emptyState();
  const sent = [];
  results.forEach((r, i) => {
    const out = evaluate(state, [].concat(r), start + i * MIN, cfg);
    state = out.state;
    sent.push(...out.notifications.map((n) => ({ ...n, minute: i })));
  });
  return { state, sent };
}

test('fires only after failAfter consecutive failures, once', () => {
  const { sent, state } = runSeq([down(), down(), down(), down(), down()], DAY);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].minute, 2);
  assert.equal(sent[0].kind, 'fire');
  assert.equal(sent[0].title, '国内：国内 relay无法访问');
  assert.equal(sent[0].body, 'HTTP 502');
  assert.equal(state.day.fired.critical, 1);
});

test('a single blip does not fire', () => {
  const { sent } = runSeq([down(), up(), down(), down(), up()], DAY);
  assert.equal(sent.length, 0);
});

test('critical repeats every 30 minutes with the duration, then resolves once', () => {
  const seq = [...Array(65).fill(down()), up(), up()];
  const { sent, state } = runSeq(seq, DAY);
  assert.deepEqual(sent.map((n) => [n.kind, n.minute]), [['fire', 2], ['repeat', 32], ['repeat', 62], ['resolve', 65]]);
  assert.match(sent[1].title, /仍未恢复 · 已持续 32 分钟/);
  assert.match(sent[3].title, /已恢复/);
  assert.equal(sent[3].body, '持续 1 小时 5 分钟');
  assert.equal(state.alerts['K-RELAY-DOWN@cn'].status, 'ok');
  assert.ok(state.day.incidents[0].endedAt);
});

test('critical rings at night; warnings wait for the morning batch', () => {
  const warn = { id: 'K-DISK', severity: 'warning', failAfter: 1, ok: false, title: '磁盘快满了', detail: '已用 88%' };
  let state = emptyState();
  let out = evaluate(state, [down({ failAfter: 1 }), warn], NIGHT, config);
  assert.deepEqual(out.notifications.map((n) => n.severity), ['critical']);
  state = out.state;
  assert.equal(state.deferred.length, 1);
  // 07:59 Beijing still quiet
  out = evaluate(state, [], Date.parse('2026-10-13T23:59:00Z'), config);
  assert.equal(out.notifications.length, 0);
  // 08:00 Beijing: one batch
  out = evaluate(out.state, [], Date.parse('2026-10-14T00:00:00Z'), config);
  assert.equal(out.notifications.length, 1);
  assert.equal(out.notifications[0].kind, 'deferred');
  assert.match(out.notifications[0].title, /夜间 1 条警告/);
  assert.match(out.notifications[0].body, /^01:00 国内：磁盘快满了 — 已用 88%/);
  assert.equal(out.state.deferred.length, 0);
});

test('warning repeats at most every 6 hours', () => {
  const warn = { id: 'K-DISK', severity: 'warning', failAfter: 1, ok: false, title: '磁盘快满了' };
  const { sent } = runSeq(Array(7 * 60).fill(warn), Date.parse('2026-10-13T00:00:00Z')); // 08:00–15:00 Beijing
  assert.deepEqual(sent.map((n) => [n.kind, n.minute]), [['fire', 0], ['repeat', 360]]);
});

test('a warning that turns critical fires again as critical', () => {
  const w = { id: 'K-DISK', severity: 'warning', failAfter: 1, ok: false, title: '磁盘快满了', detail: '88%' };
  const c = { ...w, severity: 'critical', detail: '96%' };
  const { sent } = runSeq([w, w, c, c], DAY);
  assert.deepEqual(sent.map((n) => [n.kind, n.severity, n.minute]), [['fire', 'warning', 0], ['fire', 'critical', 2]]);
});

test('critical easing back to warning stops ringing; one incident, one recovery', () => {
  const w = { id: 'K-DISK', severity: 'warning', failAfter: 1, ok: false, title: '磁盘快满了' };
  const c = { ...w, severity: 'critical' };
  const { sent, state } = runSeq([w, c, ...Array(40).fill(w), { ...w, ok: true }], DAY);
  assert.deepEqual(sent.map((n) => [n.kind, n.severity]), [['fire', 'warning'], ['fire', 'critical'], ['resolve', 'warning']]);
  assert.equal(state.day.incidents.filter((i) => i.endedAt === null).length, 0);
});

test('failed deliveries are re-routed through quiet hours', () => {
  const state = emptyState();
  const retries = [
    { kind: 'fire', severity: 'warning', title: 'w', body: '', quiet: false },
    { kind: 'fire', severity: 'critical', title: 'c', body: '', quiet: false },
    { kind: 'resolve', severity: 'critical', title: 'r', body: '', quiet: false },
  ];
  const now = routeRetries(state, retries, NIGHT, config);
  assert.deepEqual(now.map((n) => n.title), ['c', 'r']);
  assert.equal(now[1].quiet, true, 'a recovery retried at night is quiet');
  assert.deepEqual(state.deferred.map((n) => n.title), ['w']);
});

test('info is never pushed, only counted', () => {
  const info = { id: 'K-AUTH-ABUSE', severity: 'info', failAfter: 1, ok: false, title: '疑似暴力尝试登录' };
  const { sent, state } = runSeq([info, info, { ...info, ok: true }], DAY);
  assert.equal(sent.length, 0);
  assert.equal(state.day.fired.info, 1);
});

test('one-off events notify once and need no recovery', () => {
  const ev = { id: 'K-SVC-RESTART@kraki-relay', event: true, severity: 'warning', ok: false, title: 'relay 意外重启', detail: 'x' };
  const { sent, state } = runSeq([ev, ev], DAY);
  assert.equal(sent.length, 2);
  assert.equal(state.alerts['K-SVC-RESTART@kraki-relay'], undefined);
});

test('quiet hours wrap midnight', () => {
  assert.equal(inQuietHours(NIGHT, config), true);
  assert.equal(inQuietHours(DAY, config), false);
  assert.equal(inQuietHours(Date.parse('2026-10-13T15:00:00Z'), config), true); // 23:00
  assert.equal(inQuietHours(Date.parse('2026-10-13T14:59:00Z'), config), false); // 22:59
});

test('the daily summary is due once per local day from 09:00', () => {
  let state = emptyState();
  assert.equal(digestDue(state, Date.parse('2026-10-13T00:59:00Z'), config), false); // 08:59
  const nine = Date.parse('2026-10-13T01:00:00Z');
  assert.equal(digestDue(state, nine, config), true);
  state = rollDigest(state, nine, config);
  assert.equal(digestDue(state, nine + 5 * MIN, config), false);
  assert.equal(digestDue(state, Date.parse('2026-10-14T01:00:00Z'), config), true);
});
