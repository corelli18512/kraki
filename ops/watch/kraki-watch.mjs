#!/usr/bin/env node
// kraki-watch: alerting for the Kraki relays. See ops/watch/README.md.
//
//   kraki-watch                   one check run (systemd timer, every minute)
//   kraki-watch maintenance 10    silence local checks for 10 minutes (deploys)
//   kraki-watch test-notify       send one critical and one normal test message
//   kraki-watch digest-now        send today's summary now (does not reset it)
//
// Environment (from /etc/kraki/watch.env, mode 600):
//   BARK_KEY, BARK_SERVER (default https://api.day.app), HC_PING_URL,
//   KRAKI_WATCH_NOTIFY=1 to send (otherwise shadow mode: log only),
//   KRAKI_WATCH_CONFIG (default /etc/kraki/watch.json),
//   KRAKI_WATCH_STATE_DIR (default /var/lib/kraki-watch).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sendBark } from './lib/bark.mjs';
import * as collect from './lib/collect.mjs';
import { formatDigest } from './lib/digest.mjs';
import { accumulate, digestDue, emptyState, evaluate, localParts, recordProbe, rollDigest } from './lib/engine.mjs';
import { evaluateRules } from './lib/rules.mjs';

const env = process.env;
const STATE_DIR = env.KRAKI_WATCH_STATE_DIR ?? '/var/lib/kraki-watch';
const STATE_FILE = join(STATE_DIR, 'state.json');
const MAINT_FILE = join(STATE_DIR, 'maintenance-until');
const NOTIFY = env.KRAKI_WATCH_NOTIFY === '1';

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return emptyState(); }
}

async function saveState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, STATE_FILE);
}

async function deliver(n) {
  const line = `${n.kind}/${n.severity}: ${n.title}${n.body ? ` | ${n.body.replace(/\n/g, ' ¶ ')}` : ''}`;
  if (!NOTIFY || !env.BARK_KEY) {
    console.log(`[shadow] ${line}`);
    return { ok: true };
  }
  const r = await sendBark(n, { server: env.BARK_SERVER || undefined, deviceKey: env.BARK_KEY });
  console.log(`[${r.ok ? 'sent' : `FAILED ${r.error}`}] ${line}`);
  return r;
}

async function inMaintenance(now) {
  try { return Number(await readFile(MAINT_FILE, 'utf8')) > now; } catch { return false; }
}

async function collectSnapshot(config, state, now) {
  const tasks = (config.probes ?? []).map(async (p) => ({ ...p, ...(await (p.kind === 'ws' ? collect.probeWs(p) : collect.probeHttp(p))) }));
  const units = (config.units ?? []).map(async (u) => ({ ...u, ...(await collect.unitStatus(u.unit)) }));
  const certDue = (config.certs ?? []).length > 0 && !(state.lastCertAt && now - state.lastCertAt < 3600_000);
  const [probes, unitList, disk, memHost, logs, metrics, certs, backup] = await Promise.all([
    Promise.all(tasks),
    Promise.all(units),
    collect.diskUsage(config.disk?.path ?? '/'),
    collect.hostMemory(),
    config.relayUnit ? collect.relayLogs(config.relayUnit, state.lastRunAt) : null,
    config.metricsUrl ? collect.relayMetrics(config.metricsUrl) : null,
    certDue ? Promise.all(config.certs.map((h) => collect.certDaysLeft(h))) : undefined,
    config.backupStatus ? collect.readJson(config.backupStatus) : undefined,
  ]);
  return { now, maintenance: await inMaintenance(now), probes, units: unitList, disk, memHost, logs, metrics, certs, backup, certDue };
}

async function runOnce(config) {
  const now = Date.now();
  let state = await loadState();
  const snap = await collectSnapshot(config, state, now);
  const { results, mem, digest } = evaluateRules(snap, state.rules, config);
  state.rules = mem;
  if (snap.certDue) state.lastCertAt = now;

  const out = evaluate(state, results, now, config);
  state = out.state;
  accumulate(state, digest);
  for (const p of digest.probes) recordProbe(state, p.name, p.ok);
  Object.assign(state.day.notes, digest.notes);

  // First run on a host: start counting today, no near-empty summary right away.
  state.lastDigestDate ??= localParts(now, config.timezone).date;
  const queue = [...(state.undelivered ?? []), ...out.notifications];
  if (digestDue(state, now, config)) {
    queue.push(formatDigest(state, now, config));
    state = rollDigest(state, now, config);
  }
  const undelivered = [];
  for (const n of queue) {
    const r = await deliver(n);
    if (!r.ok) undelivered.push({ ...n, title: n.title.startsWith('[延迟送达]') ? n.title : `[延迟送达] ${n.title}` });
  }
  state.undelivered = undelivered.slice(-20);
  state.lastRunAt = now;
  await saveState(state);

  const firing = Object.entries(state.alerts).filter(([, a]) => a.status === 'firing').map(([id]) => id);
  console.log(`run ok: ${results.length} checks, firing [${firing.join(', ')}]${snap.maintenance ? ' (maintenance)' : ''}`);
  await collect.ping(env.HC_PING_URL);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'maintenance') {
    const minutes = Number(arg ?? 10);
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(MAINT_FILE, String(Date.now() + minutes * 60_000));
    console.log(`maintenance for ${minutes} min`);
    return;
  }
  const config = JSON.parse(await readFile(env.KRAKI_WATCH_CONFIG ?? '/etc/kraki/watch.json', 'utf8'));
  if (cmd === 'test-notify') {
    const label = config.label ?? config.host;
    await deliver({ kind: 'fire', severity: 'critical', title: `${label}：测试紧急告警`, body: '这是 kraki-watch 的测试消息（紧急级别，静音也会响）', quiet: false });
    await deliver({ kind: 'fire', severity: 'warning', title: `${label}：测试警告`, body: '这是 kraki-watch 的测试消息（警告级别）', quiet: false });
    return;
  }
  if (cmd === 'digest-now') {
    await deliver(formatDigest(await loadState(), Date.now(), config));
    return;
  }
  await runOnce(config);
}

main().catch((err) => {
  console.error(`kraki-watch failed: ${err?.stack ?? err}`);
  process.exit(1);
});
