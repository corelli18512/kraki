import assert from 'node:assert/strict';
import { test } from 'node:test';
import { barkPayload } from '../lib/bark.mjs';
import { isLegacyRelayRoot } from '../lib/collect.mjs';
import { formatDigest } from '../lib/digest.mjs';
import { accumulate, emptyState, evaluate, recordProbe } from '../lib/engine.mjs';
import { parseLine, summarize } from '../lib/logs.mjs';
import { counterDeltas, evaluateRules } from '../lib/rules.mjs';

const config = { host: 'cn', label: '国内', timezone: 'Asia/Shanghai', relayUnit: 'kraki-relay' };
const T0 = Date.parse('2026-10-13T06:00:00Z');
const MIN = 60_000;
const byId = (results, id) => results.find((r) => r.id === id);

// Real lines from the China relay (device ids shortened).
const REAL = [
  '◈ [2026-10-13T14:39:54.763Z] health {"conns":3,"endpoints":2,"durableRows":0,"rssMb":136,"heapUsedMb":19,"heapTotalMb":22}',
  '◈ [2026-10-13T14:40:06.996Z] Device authenticated (via backend) {"deviceId":"dev_x","user":"u","method":"challenge","ip":"1.2.3.4"}',
  '❌ [2026-10-12T13:24:41.233Z] APNs request error {"error":"read ECONNRESET","tokenSuffix":"66af8f64"}',
  '⚠️ [2026-10-13T14:41:00.000Z] APNs send failed {"status":403,"reason":"InvalidProviderToken","tokenSuffix":"1"}',
  '❌ [2026-10-13T14:41:01.000Z] Something new broke {"x":1}',
  '❌ [2026-10-13T14:41:02.000Z] Uncaught exception — exiting {"error":"TypeError: x is undefined\\n    at foo"}',
  'garbage line',
];

test('parses the relay log format', () => {
  assert.deepEqual(parseLine(REAL[0]), { level: 'info', at: Date.parse('2026-10-13T14:39:54.763Z'), message: 'health', data: { conns: 3, endpoints: 2, durableRows: 0, rssMb: 136, heapUsedMb: 19, heapTotalMb: 22 } });
  assert.equal(parseLine(REAL[3]).level, 'warn');
  assert.equal(parseLine('◈ [2026-10-13T14:39:54.763Z] Shutting down...').message, 'Shutting down...');
  assert.equal(parseLine(REAL[6]), null);
});

test('summarizes categories, push auth errors, unknown errors and crashes', () => {
  const s = summarize(REAL);
  assert.deepEqual(s.counts, { login: 1, pushFail: 2, crash: 1 });
  assert.equal(s.pushAuth, 1);
  assert.deepEqual(s.errorsByMessage, { 'Something new broke': 1 });
  assert.equal(s.health.rssMb, 136);
  assert.equal(s.lastCrash, 'TypeError: x is undefined');
});

function snap(over = {}) {
  return {
    now: T0, maintenance: false, probes: [], disk: { usedPct: 50 }, memHost: { availPct: 50 },
    units: [{ unit: 'kraki-relay', name: 'relay', severity: 'critical', active: 'active', invocationId: 'a', activeSince: T0 - 3600_000 }],
    logs: summarize([`◈ [${new Date(T0).toISOString()}] health {"conns":3,"durableRows":0,"rssMb":100}`]),
    metrics: null,
    ...over,
  };
}

test('a healthy snapshot produces no failing checks', () => {
  const { results } = evaluateRules(snap(), {}, config);
  assert.deepEqual(results.filter((r) => !r.ok), []);
});

test('unplanned restart is an event; three in an hour is critical flapping', () => {
  let mem = evaluateRules(snap(), {}, config).mem;
  let failing = [];
  for (let i = 1; i <= 3; i++) {
    const s = snap({ now: T0 + i * MIN, units: [{ ...snap().units[0], invocationId: `inv${i}` }], logs: summarize([`❌ [x] Uncaught exception — exiting {"error":"Error: boom ${i}"}`]) });
    const out = evaluateRules(s, mem, config);
    mem = out.mem;
    failing = out.results.filter((r) => !r.ok);
  }
  const restart = byId(failing, 'K-SVC-RESTART@kraki-relay');
  assert.equal(restart.event, true);
  assert.match(restart.detail, /Error: boom 3/);
  assert.equal(byId(failing, 'K-SVC-FLAP@kraki-relay').detail, '1 小时内重启 3 次');
});

test('a restart during maintenance is not reported', () => {
  const mem = evaluateRules(snap(), {}, config).mem;
  const out = evaluateRules(snap({ now: T0 + MIN, maintenance: true, units: [{ ...snap().units[0], invocationId: 'new' }] }), mem, config);
  assert.equal(out.results.filter((r) => !r.ok).length, 0);
  assert.equal(out.mem.units['kraki-relay'].restarts.length, 0);
});

test('a stopped unit fails; a failed one fails at once', () => {
  const stopped = evaluateRules(snap({ units: [{ ...snap().units[0], active: 'inactive' }] }), {}, config).results;
  assert.equal(byId(stopped, 'K-SVC-FAILED@kraki-relay').failAfter, 2);
  const failed = evaluateRules(snap({ units: [{ ...snap().units[0], active: 'failed' }] }), {}, config).results;
  assert.equal(byId(failed, 'K-SVC-FAILED@kraki-relay').failAfter, 1);
});

test('health silence: relay running but no health line for 3 minutes', () => {
  let mem = evaluateRules(snap(), {}, config).mem;
  const quiet = (m) => snap({ now: T0 + m * MIN, logs: summarize([]) });
  let r = evaluateRules(quiet(2), mem, config);
  assert.equal(byId(r.results, 'K-HEALTH-SILENT').ok, true);
  mem = r.mem;
  r = evaluateRules(quiet(4), mem, config);
  assert.equal(byId(r.results, 'K-HEALTH-SILENT').ok, false);
});

test('a health line counts by arrival, even with an old or skewed timestamp', () => {
  const old = summarize(['◈ [2020-01-01T00:00:00.000Z] health {"conns":1,"rssMb":50}']);
  const r = evaluateRules(snap({ logs: old }), {}, config);
  assert.equal(byId(r.results, 'K-HEALTH-SILENT').ok, true);
});

test('log windows: push failures need volume and share; auth errors are critical', () => {
  const lines = Array.from({ length: 12 }, () => '❌ [x] APNs request error {"error":"read ECONNRESET"}');
  let r = evaluateRules(snap({ logs: summarize(lines) }), {}, config);
  assert.equal(byId(r.results, 'K-PUSH-FAIL').ok, false);
  // With metrics showing 1000 attempts, 12 failures is 1.2% → fine.
  r = evaluateRules(snap({ logs: summarize(lines), metrics: { counters: { 'push.attempted': 1000 } } }), {}, config);
  assert.equal(byId(r.results, 'K-PUSH-FAIL').ok, true);
  const auth = Array.from({ length: 3 }, () => '⚠️ [x] APNs send failed {"status":403,"reason":"ExpiredProviderToken"}');
  r = evaluateRules(snap({ logs: summarize(auth) }), {}, config);
  assert.equal(byId(r.results, 'K-PUSH-AUTH').ok, false);
  assert.equal(byId(r.results, 'K-PUSH-AUTH').severity, 'critical');
});

test('log windows span 10 minutes of runs, then clear', () => {
  let mem = {};
  const one = '❌ [x] pulse-hub gc tick failed {"error":"x"}';
  let r = evaluateRules(snap({ logs: summarize([one]) }), mem, config);
  assert.equal(byId(r.results, 'K-PULSE').ok, false);
  mem = r.mem;
  r = evaluateRules(snap({ now: T0 + 9 * MIN, logs: summarize([]) }), mem, config);
  assert.equal(byId(r.results, 'K-PULSE').ok, false);
  r = evaluateRules(snap({ now: T0 + 10 * MIN, logs: summarize([]) }), r.mem, config);
  assert.equal(byId(r.results, 'K-PULSE').ok, true);
});

test('unknown errors are summed and the top ones named', () => {
  const lines = [...Array(15).fill('❌ [x] Disk I/O error'), ...Array(6).fill('❌ [x] Something else')];
  const r = evaluateRules(snap({ logs: summarize(lines) }), {}, config);
  const e = byId(r.results, 'K-ERRORS');
  assert.equal(e.ok, false);
  assert.equal(e.detail, '10 分钟 21 条：Disk I/O error ×15；Something else ×6');
});

test('connection drop and durable backlog', () => {
  let mem = {};
  const health = (conns, rows, m) => snap({ now: T0 + m * MIN, logs: summarize([`◈ [x] health {"conns":${conns},"durableRows":${rows},"rssMb":100}`]) });
  for (let m = 0; m < 4; m++) mem = evaluateRules(health(10, 2000 + m, m), mem, config).mem;
  let r = evaluateRules(health(2, 2004, 4), mem, config);
  assert.equal(byId(r.results, 'K-CONN-DROP').ok, false);
  for (let m = 5; m <= 31; m++) r = evaluateRules(health(10, 2000 + m, m), r.mem, config);
  assert.equal(byId(r.results, 'K-DURABLE').ok, false);
  assert.equal(byId(r.results, 'K-CONN-DROP').ok, true);
});

test('certificates and backups', () => {
  const certs = [{ host: 'a', daysLeft: 20 }, { host: 'b', daysLeft: 10 }, { host: 'c', daysLeft: 2 }, { host: 'd', error: 'ECONNREFUSED' }];
  const r = evaluateRules(snap({ certs, backup: null }), {}, config).results;
  assert.equal(byId(r, 'K-CERT@a').ok, true);
  assert.deepEqual([byId(r, 'K-CERT@b').ok, byId(r, 'K-CERT@b').severity], [false, 'warning']);
  assert.equal(byId(r, 'K-CERT@c').severity, 'critical');
  assert.equal(byId(r, 'K-CERT@d').failAfter, 3);
  assert.equal(byId(r, 'K-BACKUP').ok, false); // no record yet

  const at = new Date(T0 - 3600_000).toISOString();
  const ok = (b) => evaluateRules(snap({ backup: { ok: true, at, sizeBytes: 100, prevSizeBytes: 90, copied: true, ...b } }), {}, config).results;
  assert.deepEqual(ok({}).filter((x) => x.id.startsWith('K-BACKUP') && !x.ok), []);
  assert.equal(byId(ok({ copied: false, copyError: 'timeout' }), 'K-BACKUP-COPY').ok, false);
  assert.equal(byId(ok({ copied: null }), 'K-BACKUP-COPY').ok, true);
  assert.equal(byId(ok({ sizeBytes: 40 }), 'K-BACKUP-SIZE').ok, false);
  assert.equal(byId(ok({ at: new Date(T0 - 27 * 3600_000).toISOString() }), 'K-BACKUP').ok, false);
  assert.equal(byId(evaluateRules(snap({ backup: { ok: false, at, error: 'integrity' } }), {}, config).results, 'K-BACKUP').ok, false);
});

test('slow probe uses the median of the last 10', () => {
  let mem = {};
  let r;
  for (let i = 0; i < 6; i++) {
    r = evaluateRules(snap({ probes: [{ id: 'K-RELAY-DOWN', target: 'cn', name: '国内 relay', severity: 'critical', slow: true, ok: true, ms: i < 2 ? 100 : 3000 }] }), mem, config);
    mem = r.mem;
  }
  assert.equal(byId(r.results, 'K-SLOW@cn').ok, false);
});

test('local probes are skipped during maintenance, remote ones are not', () => {
  const probes = [
    { id: 'K-RELAY-DOWN', target: 'cn', name: 'a', severity: 'critical', local: true, ok: false },
    { id: 'K-PEER-DOWN', target: 'tokyo', name: 'b', severity: 'critical', ok: false },
  ];
  const r = evaluateRules(snap({ maintenance: true, probes }), {}, config).results;
  assert.equal(byId(r, 'K-RELAY-DOWN@cn'), undefined);
  assert.equal(byId(r, 'K-PEER-DOWN@tokyo').ok, false);
});

test('version mismatch is info only', () => {
  const probes = [
    { id: 'K-RELAY-DOWN', target: 'cn', name: 'a', severity: 'critical', ok: true, version: '0.21.0' },
    { id: 'K-PEER-DOWN', target: 'tokyo', name: 'b', severity: 'critical', ok: true, version: '0.20.1' },
  ];
  const v = byId(evaluateRules(snap({ probes }), {}, config).results, 'K-VERSION');
  assert.deepEqual([v.ok, v.severity, v.detail], [false, 'info', '0.21.0 / 0.20.1']);
});

test('counter deltas: first sample is a baseline; a restart counts everything new', () => {
  assert.deepEqual(counterDeltas({ a: 10, b: 5 }, { a: 15, b: 5 }), { a: 5, b: 0 });
  assert.deepEqual(counterDeltas(undefined, { a: 3 }), { a: 0 }, 'lifetime totals are not now');
  assert.deepEqual(counterDeltas({ a: 1 }, { a: 3 }, true), { a: 3 }, 'restart detected by uptime, even when the total grew');
});

test('relay restart is detected by uptime going backwards', () => {
  let mem = evaluateRules(snap({ metrics: { uptimeSec: 500, counters: { 'push.authError': 1 } } }), {}, config).mem;
  const r = evaluateRules(snap({ now: T0 + MIN, metrics: { uptimeSec: 20, counters: { 'push.authError': 3 } } }), mem, config);
  assert.equal(byId(r.results, 'K-PUSH-AUTH').ok, false, '3 new credential errors after the restart');
  mem = evaluateRules(snap({ metrics: { uptimeSec: 9999, counters: { 'push.authError': 50 } } }), {}, config).mem;
  assert.equal(byId(evaluateRules(snap({ now: T0 + MIN, metrics: { uptimeSec: 10059, counters: { 'push.authError': 50 } } }), mem, config).results, 'K-PUSH-AUTH').ok, true,
    'old lifetime errors never page');
});

test('with relay counters, push alerts use final results only (no double count with logs)', () => {
  const lines = ['⚠️ [x] APNs send failed {"status":403,"reason":"ExpiredProviderToken"}', '⚠️ [x] APNs send failed {"status":403,"reason":"ExpiredProviderToken"}'];
  let mem = evaluateRules(snap({ metrics: { uptimeSec: 100, counters: { 'push.authError': 0, 'push.attempted': 0, 'push.failed': 0 } } }), {}, config).mem;
  const r = evaluateRules(snap({ now: T0 + MIN, logs: summarize(lines), metrics: { uptimeSec: 160, counters: { 'push.authError': 2, 'push.attempted': 2, 'push.failed': 2 } } }), mem, config);
  assert.equal(byId(r.results, 'K-PUSH-AUTH').ok, true, '2 failures are 2, not 4');
});

test('several automatic restarts between two runs count as flapping', () => {
  const unit = (n, inv) => [{ unit: 'kraki-relay', name: 'relay', severity: 'critical', active: 'active', invocationId: inv, nRestarts: n, activeSince: T0 }];
  const mem = evaluateRules(snap({ units: unit(0, 'a') }), {}, config).mem;
  const r = evaluateRules(snap({ now: T0 + MIN, units: unit(3, 'b') }), mem, config);
  assert.equal(byId(r.results, 'K-SVC-FLAP@kraki-relay').ok, false);
});

test('a deploy does not report a connection drop, before or after', () => {
  let mem = {};
  const h = (conns, m, maintenance = false) => snap({ now: T0 + m * MIN, maintenance, logs: summarize([`◈ [x] health {"conns":${conns},"durableRows":0,"rssMb":100}`]) });
  for (let m = 0; m < 3; m++) mem = evaluateRules(h(10, m), mem, config).mem;
  let r = evaluateRules(h(0, 3, true), mem, config);
  assert.equal(byId(r.results, 'K-CONN-DROP'), undefined);
  r = evaluateRules(h(1, 4), r.mem, config);
  assert.equal(byId(r.results, 'K-CONN-DROP')?.ok ?? true, true);
});

test('daily summary text', () => {
  let state = emptyState();
  const now = Date.parse('2026-10-14T01:00:00Z');
  state = evaluate(state, [{ id: 'X', severity: 'critical', failAfter: 1, ok: false, title: '国内 relay无法访问' }], Date.parse('2026-10-13T19:12:00Z'), config).state;
  state = evaluate(state, [{ id: 'X', severity: 'critical', failAfter: 1, ok: true, title: '国内 relay无法访问' }], Date.parse('2026-10-13T19:16:00Z'), config).state;
  for (let i = 0; i < 1000; i++) recordProbe(state, '国内 relay', i !== 0);
  accumulate(state, { totals: { 'm:auth.ok': 12, 'm:push.attempted': 424, 'm:push.sent': 420, 'm:push.failed': 4 }, peaks: { conns: 5, rssMb: 136 } });
  Object.assign(state.day.notes, { disk: 52, backup: { at: '2026-10-13T19:00:00Z', sizeBytes: 9_646_899, copied: true }, 'cert:cn.relay.kraki.chat': 61, 'cert:stt.kraki.chat': 80, 'version:cn': '0.20.1' });
  const d = formatDigest(state, now, config);
  assert.equal(d.title, 'Kraki 日报 · 国内 · 1 个问题');
  assert.equal(d.body, [
    '可用性  国内 relay 99.90%',
    '告警  紧急 1  警告 0  信息 0',
    '  · 03:12 国内 relay无法访问（4 分钟，已恢复）',
    '连接  峰值 5 / 登录 12',
    '推送  成功 420 / 失败 4',
    '资源  relay 内存峰值 136 MB  磁盘 52%',
    '备份  ✓ 03:00 9.2 MB 已复制',
    '证书  最近到期 cn.relay.kraki.chat 还有 61 天',
    '版本  cn 0.20.1',
  ].join('\n'));
  assert.equal(formatDigest(emptyState(), now, config).title, 'Kraki 日报 · 国内 · 全部正常');
});

test('a problem is counted once, whether it is still open or not', () => {
  const now = Date.parse('2026-10-14T01:00:00Z');
  let state = emptyState();
  const r = { id: 'K-BACKUP', severity: 'critical', failAfter: 1, ok: false, title: '数据库备份失败或过期' };
  state = evaluate(state, [r], now - 3600_000, config).state;
  state = evaluate(state, [r], now - 60_000, config).state;
  const d = formatDigest(state, now, config);
  assert.equal(d.title, 'Kraki 日报 · 国内 · 1 个问题');
  assert.match(d.body, /数据库备份失败或过期（仍未恢复）/);
  assert.doesNotMatch(d.body, /仍未恢复：/);
  // Still firing from an earlier day: listed once as open.
  state.day = { ...state.day, incidents: [], fired: { critical: 0, warning: 0, info: 0 } };
  const d2 = formatDigest(state, now, config);
  assert.equal(d2.title, 'Kraki 日报 · 国内 · 1 个问题');
  assert.match(d2.body, /  · 仍未恢复：数据库备份失败或过期/);
});

test('an older relay without /health/ready is not reported as not ready', () => {
  assert.equal(isLegacyRelayRoot('{"name":"@kraki/head","version":"0.20.1","status":"ok"}'), true);
  assert.equal(isLegacyRelayRoot('{"status":"not_ready","checks":{}}'), false);
  assert.equal(isLegacyRelayRoot('Bad Gateway'), false);
});

test('Bark levels: critical rings, warnings are time-sensitive, night recoveries are passive', () => {
  const crit = barkPayload({ kind: 'fire', severity: 'critical', title: 't', body: 'b' }, 'KEY');
  assert.deepEqual(crit, { device_key: 'KEY', title: 't', body: 'b', isArchive: '1', level: 'critical', volume: '8', call: '1', group: 'Kraki 紧急' });
  assert.equal(barkPayload({ kind: 'repeat', severity: 'critical', title: 't' }, 'K').level, 'critical');
  assert.equal(barkPayload({ kind: 'fire', severity: 'warning', title: 't' }, 'K').level, 'timeSensitive');
  assert.equal(barkPayload({ kind: 'resolve', severity: 'critical', title: 't', quiet: true }, 'K').level, 'passive');
  assert.equal(barkPayload({ kind: 'digest', severity: 'info', title: 't', body: '' }, 'K').body, ' ');
});
