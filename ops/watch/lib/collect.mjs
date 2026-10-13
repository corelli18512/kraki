// Collectors for kraki-watch: everything that touches the network, systemd,
// journald or the filesystem. Each collector returns plain data and never
// throws (a failure is data too).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, statfs } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { summarize } from './logs.mjs';

function run(cmd, args, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), error: err?.message });
    });
  });
}

/** The generic root answer of a relay that predates `/health/ready`. */
export function isLegacyRelayRoot(body) {
  try {
    const j = JSON.parse(body);
    return j.name === '@kraki/head' && j.status === 'ok';
  } catch {
    return false;
  }
}

/** HTTP(S) probe: status, optional body substring, optional redirect check. */
export async function probeHttp(p) {
  const started = performance.now();
  try {
    const res = await fetch(p.url, {
      method: p.method ?? 'GET',
      redirect: p.expectRedirect ? 'manual' : 'follow',
      headers: { 'User-Agent': 'kraki-watch' },
      signal: AbortSignal.timeout(p.timeoutMs ?? 10_000),
    });
    const ms = Math.round(performance.now() - started);
    const body = p.method === 'HEAD' ? '' : await res.text();
    if (p.expectRedirect) {
      const loc = res.headers.get('location') ?? '';
      const ok = res.status >= 300 && res.status < 400 && new RegExp(p.expectRedirect).test(loc);
      return { ok, ms, detail: ok ? '' : `HTTP ${res.status} → ${loc || '(无跳转)'}` };
    }
    const statusOk = (p.expectStatus ?? [200]).includes(res.status);
    if (p.readiness && statusOk && isLegacyRelayRoot(body)) {
      // Relay older than /health/ready answers every path with its root JSON.
      return { ok: true, ms, legacy: true, detail: 'relay 版本没有就绪检查' };
    }
    const bodyOk = !p.expectBody || body.includes(p.expectBody);
    let version = null;
    if (p.relay) {
      try { const j = JSON.parse(body); if (j.name === '@kraki/head') version = j.version; } catch { /* not JSON */ }
    }
    return { ok: statusOk && bodyOk, ms, version, detail: statusOk && bodyOk ? '' : `HTTP ${res.status}${bodyOk ? '' : '，内容不对'}：${body.slice(0, 120)}` };
  } catch (err) {
    const detail = err?.name === 'TimeoutError' ? `超时 ${(p.timeoutMs ?? 10_000) / 1000} 秒` : (err?.cause?.code ?? err?.message ?? String(err));
    return { ok: false, ms: Math.round(performance.now() - started), detail };
  }
}

/** WebSocket handshake probe: expects 101 Switching Protocols. */
export function probeWs(p) {
  return new Promise((resolve) => {
    const url = new URL(p.url);
    const lib = url.protocol === 'wss:' ? https : http;
    const started = performance.now();
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'wss:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'User-Agent': 'kraki-watch' },
      timeout: p.timeoutMs ?? 10_000,
    });
    const done = (r) => { resolve({ ms: Math.round(performance.now() - started), ...r }); req.destroy(); };
    req.on('upgrade', (res, socket) => { socket.destroy(); done({ ok: res.statusCode === 101, detail: '' }); });
    req.on('response', (res) => { res.resume(); done({ ok: false, detail: `握手失败：HTTP ${res.statusCode}` }); });
    req.on('timeout', () => done({ ok: false, detail: '握手超时' }));
    req.on('error', (err) => done({ ok: false, detail: err.code ?? err.message }));
    req.end();
  });
}

export async function unitStatus(unit) {
  const r = await run('systemctl', ['show', unit, '-p', 'ActiveState', '-p', 'InvocationID', '-p', 'ActiveEnterTimestamp', '-p', 'NRestarts', '--timestamp=unix']);
  if (!r.ok) return { active: 'unknown' };
  const kv = Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const ts = /@(\d+)/.exec(kv.ActiveEnterTimestamp ?? '');
  const nRestarts = Number(kv.NRestarts);
  return { active: kv.ActiveState || 'unknown', invocationId: kv.InvocationID || null, activeSince: ts ? Number(ts[1]) * 1000 : null,
    nRestarts: kv.NRestarts !== undefined && Number.isFinite(nRestarts) ? nRestarts : undefined };
}

export async function diskUsage(path) {
  try {
    const s = await statfs(path);
    const total = s.blocks * s.bsize;
    const avail = s.bavail * s.bsize;
    const used = total - s.bfree * s.bsize;
    return { usedPct: Math.round((used / (used + avail)) * 100) };
  } catch {
    return null;
  }
}

export async function hostMemory() {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const get = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(text)?.[1]);
    return { availPct: Math.round((get('MemAvailable') / get('MemTotal')) * 100) };
  } catch {
    return null;
  }
}

/**
 * Relay log lines after the previous run's journal cursor (first run: the
 * last 2 minutes). Cursor-based, so no line is counted twice. Returns the
 * summary plus the new cursor (`cursor`).
 */
export async function relayLogs(unit, cursor) {
  // At most the newest 20,000 lines per run: a huge backlog (log storm) is
  // skipped rather than blocking every later run on an oversized read.
  const args = ['-u', unit, '-o', 'cat', '--no-pager', '-q', '--show-cursor', '-n', '20000'];
  args.push(...(cursor ? ['--after-cursor', cursor] : ['--since', '-2min']));
  const r = await run('journalctl', args);
  if (!r.ok) return null;
  const lines = r.stdout.split('\n');
  let next = cursor ?? null;
  const at = lines.findLastIndex((l) => l.startsWith('-- cursor: '));
  if (at >= 0) { next = lines[at].slice('-- cursor: '.length).trim(); lines.splice(at, 1); }
  return { ...summarize(lines), cursor: next };
}

export async function relayMetrics(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null; // older relay without the endpoint
    return await res.json();
  } catch {
    return null;
  }
}

export function certDaysLeft(host) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.destroy();
      if (!cert?.valid_to) return resolve({ host, error: '没有证书' });
      resolve({ host, daysLeft: Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86_400_000) });
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ host, error: '连接超时' }); });
    socket.on('error', (err) => resolve({ host, error: err.code ?? err.message }));
  });
}

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function ping(url) {
  if (!url) return;
  try { await fetch(url, { signal: AbortSignal.timeout(10_000) }); } catch { /* the heartbeat service alerts on silence */ }
}
