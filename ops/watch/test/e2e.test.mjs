// End to end: the real kraki-watch.mjs process, run minute after minute,
// against a fake relay, a fake Bark server, a fake heartbeat endpoint and
// fake systemctl/journalctl on PATH.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../kraki-watch.mjs', import.meta.url));
let dir;
let server;
let port;
let relayStatus = 200;
const bark = [];
let pings = 0;
let barkHangs = false;
let barkCode = 200;
let metricsCalls = 0;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kraki-watch-e2e-'));
  server = createServer((req, res) => {
    if (req.url === '/push' && barkHangs) return; // never answers
    if (req.url === '/push') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { bark.push(JSON.parse(body)); res.end(JSON.stringify({ code: barkCode })); });
      return;
    }
    if (req.url === '/ping') { pings++; res.end('OK'); return; }
    if (req.url === '/health/ready') { res.end('{"status":"ready"}'); return; }
    if (req.url === '/internal/metrics') {
      metricsCalls++;
      res.end(JSON.stringify({ uptimeSec: metricsCalls, counters: { 'push.attempted': 5 * metricsCalls, 'push.sent': 5 * metricsCalls, 'auth.ok': 2 * metricsCalls } }));
      return;
    }
    res.writeHead(relayStatus, { 'Content-Type': 'application/json' });
    res.end(relayStatus === 200 ? '{"name":"@kraki/head","version":"0.21.0","status":"ok"}' : 'Bad Gateway');
  });
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  await writeFile(join(dir, 'systemctl'), '#!/bin/sh\nprintf "ActiveState=active\\nInvocationID=abc\\nActiveEnterTimestamp=@1760000000\\n"\n');
  // Records its arguments; prints one line and a cursor like journalctl --show-cursor.
  await writeFile(join(dir, 'journalctl'), `#!/bin/sh\necho "$@" >> ${join(dir, 'journal-args')}\necho '◈ [2026-10-13T00:00:00.000Z] health {"conns":2,"durableRows":0,"rssMb":80}'\necho '-- cursor: s=abc;i=42'\n`);
  await chmod(join(dir, 'systemctl'), 0o755);
  await chmod(join(dir, 'journalctl'), 0o755);
  await writeFile(join(dir, 'backup.json'), JSON.stringify({ ok: true, at: new Date().toISOString(), sizeBytes: 100, prevSizeBytes: 100, copied: true }));
  await writeFile(join(dir, 'watch.json'), JSON.stringify({
    host: 'test', label: 'Test', timezone: 'Asia/Shanghai', quietHours: [0, 0], digestHour: 0,
    // The test machine's real disk must not trip the disk alert.
    disk: { path: '/', warning: 101, critical: 102 },
    relayUnit: 'kraki-relay', metricsUrl: `http://127.0.0.1:${port}/internal/metrics`, backupStatus: join(dir, 'backup.json'),
    units: [{ unit: 'kraki-relay', name: 'Relay process', severity: 'critical' }],
    probes: [
      { id: 'K-RELAY-DOWN', target: 't', name: 'Test relay', url: `http://127.0.0.1:${port}/`, expectBody: '"status":"ok"', relay: true, severity: 'critical', failAfter: 3, local: true },
      { id: 'K-RELAY-WS', target: 't', kind: 'ws', name: 'Test WebSocket', url: `ws://127.0.0.1:${port}/`, severity: 'critical', failAfter: 3 },
      { id: 'K-RELAY-READY', target: 't', name: 'Readiness', url: `http://127.0.0.1:${port}/health/ready`, expectBody: '"status":"ready"', severity: 'critical', failAfter: 3 },
    ],
  }));
});

after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

function run(...args) {
  return runEnv({}, ...args);
}

function runEnv(extra, ...args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SCRIPT, ...args], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        KRAKI_WATCH_CONFIG: join(dir, 'watch.json'),
        KRAKI_WATCH_STATE_DIR: join(dir, 'state'),
        KRAKI_WATCH_NOTIFY: '1',
        BARK_KEY: 'test-key',
        BARK_SERVER: `http://127.0.0.1:${port}`,
        HC_PING_URL: `http://127.0.0.1:${port}/ping`,
        ...extra,
      },
      timeout: 30_000,
    }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
  });
}

test('healthy runs send nothing and ping the heartbeat', async () => {
  const out = await run();
  assert.match(out, /run ok: \d+ checks, firing \[\]/);
  assert.equal(bark.length, 0);
  assert.equal(pings, 1);
  const state = JSON.parse(await readFile(join(dir, 'state', 'state.json'), 'utf8'));
  assert.ok(state.lastDigestDate, 'first run starts the day without sending a summary');
});

test('relay down: one critical after three runs, then recovery', async () => {
  relayStatus = 502;
  await run();
  await run();
  assert.equal(bark.length, 0);
  await run();
  assert.equal(bark.length, 1);
  assert.deepEqual(
    { title: bark[0].title, level: bark[0].level, call: bark[0].call, key: bark[0].device_key },
    { title: 'Test: Test relay unreachable', level: 'critical', call: '1', key: 'test-key' },
  );
  assert.match(bark[0].body, /HTTP 502/);
  await run();
  assert.equal(bark.length, 1, 'no repeat within 30 minutes');

  relayStatus = 200;
  await run();
  assert.equal(bark.length, 2);
  assert.match(bark[1].title, /^Test: Recovered · /);
  assert.equal(pings, 6);
});

test('maintenance silences local probes', async () => {
  await run('maintenance', '5');
  relayStatus = 502;
  for (let i = 0; i < 4; i++) await run();
  assert.equal(bark.length, 2);
  relayStatus = 200;
  const state = JSON.parse(await readFile(join(dir, 'state', 'state.json'), 'utf8'));
  assert.equal(state.alerts['K-RELAY-DOWN@t'].status, 'ok');
});

test('test-notify sends one critical and one warning', async () => {
  await run('test-notify');
  assert.deepEqual(bark.slice(-2).map((b) => b.level), ['critical', 'timeSensitive']);
});

test('digest-now sends the summary', async () => {
  await run('digest-now');
  const d = bark[bark.length - 1];
  assert.equal(d.group, 'Kraki Daily');
  assert.match(d.title, /^Kraki Daily · Test · /);
  assert.match(d.body, /Availability  Test relay/);
  // First metrics sample is a baseline; each later run adds 5.
  assert.match(d.body, /Push  sent \d+ \/ failed 0/);
  assert.doesNotMatch(d.body, /Push  sent 0 /);
});

test('journal reads continue from the saved cursor (no line counted twice)', async () => {
  const args = (await readFile(join(dir, 'journal-args'), 'utf8')).trim().split('\n');
  assert.match(args[0], /--since -2min/);
  assert.match(args[args.length - 1], /--after-cursor s=abc;i=42/);
});

test('a hanging Bark cannot lose alert state: saved first, retried next run', async () => {
  await run('maintenance', '0'); // end the earlier test's window
  relayStatus = 502;
  await run();
  await run(); // two failures: not yet firing
  barkHangs = true;
  // Third failure fires; Bark never answers; systemd would kill the run at
  // its timeout. Kill it mid-delivery ourselves.
  const child = execFile(process.execPath, [SCRIPT], { env: {
    PATH: `${dir}:${process.env.PATH}`, KRAKI_WATCH_CONFIG: join(dir, 'watch.json'), KRAKI_WATCH_STATE_DIR: join(dir, 'state'),
    KRAKI_WATCH_NOTIFY: '1', BARK_KEY: 'test-key', BARK_SERVER: `http://127.0.0.1:${port}`, HC_PING_URL: `http://127.0.0.1:${port}/ping`,
  } });
  await new Promise((r) => setTimeout(r, 3000));
  child.kill('SIGKILL');
  const state = JSON.parse(await readFile(join(dir, 'state', 'state.json'), 'utf8'));
  assert.equal(state.alerts['K-RELAY-DOWN@t'].status, 'firing', 'state saved before delivery');
  assert.ok(state.undelivered.some((n) => /Test relay unreachable/.test(n.title)), 'critical queued for retry');
  const before = bark.length;
  barkHangs = false;
  relayStatus = 200;
  await run();
  assert.ok(bark.slice(before).some((b) => /\[Delayed\].*Test relay unreachable/.test(b.title) && b.level === 'critical'), 'retried as critical');
});

test('a new critical is never pushed out of the outbox by older retries', async () => {
  await run('maintenance', '0');
  const statePath = join(dir, 'state', 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.undelivered = Array.from({ length: 25 }, (_, i) => ({ kind: 'repeat', severity: 'critical', title: `[Delayed] old ${i}`, body: '', quiet: false }));
  state.alerts = {};
  await writeFile(statePath, JSON.stringify(state));
  barkHangs = true;
  relayStatus = 502;
  for (let i = 0; i < 3; i++) await runEnv({ KRAKI_WATCH_RUN_BUDGET_MS: '2500' });
  const after = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(after.undelivered.length, 20);
  assert.match(after.undelivered[0].title, /Test relay unreachable/, 'fresh critical first');
  barkHangs = false;
  relayStatus = 200;
  await run();
});

test('check-config is offline, redacted, and does not change state', async () => {
  const before = await readFile(join(dir, 'state', 'state.json'), 'utf8');
  const sent = bark.length;
  const heartbeats = pings;
  const out = await run('check-config');
  assert.match(out, /Phone delivery is NOT verified/);
  assert.doesNotMatch(out, /test-key|\/ping/);
  assert.equal(bark.length, sent);
  assert.equal(pings, heartbeats);
  assert.equal(await readFile(join(dir, 'state', 'state.json'), 'utf8'), before);
});

test('enabled notifications with no key fail instead of silently clearing the queue as shadow', async () => {
  const before = await readFile(join(dir, 'state', 'state.json'), 'utf8');
  const heartbeats = pings;
  await assert.rejects(runEnv({ BARK_KEY: '' }), /BARK_KEY is required/);
  assert.equal(pings, heartbeats, 'a broken configuration must not send a healthy heartbeat');
  assert.equal(await readFile(join(dir, 'state', 'state.json'), 'utf8'), before);
});

test('test-notify cannot claim success in shadow mode or with a rejected push', async () => {
  const sent = bark.length;
  await assert.rejects(runEnv({ KRAKI_WATCH_NOTIFY: '0' }, 'test-notify'), /shadow mode sends nothing/);
  assert.equal(bark.length, sent);
  barkCode = 400;
  try {
    await assert.rejects(run('test-notify'), /Bark test failed/);
    await assert.rejects(run('digest-now'), /Bark digest delivery failed/);
  } finally { barkCode = 200; }
});

test('Bark application-level failure remains queued and is retried on recovery', async () => {
  const statePath = join(dir, 'state', 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.undelivered = [{ kind: 'fire', severity: 'critical', title: 'retry-me', body: '', quiet: false }];
  await writeFile(statePath, JSON.stringify(state));
  barkCode = 400;
  try {
    await run();
    const failed = JSON.parse(await readFile(statePath, 'utf8'));
    assert.ok(failed.undelivered.some((n) => n.title.includes('retry-me')));
  } finally { barkCode = 200; }
  const sent = bark.length;
  await run();
  assert.ok(bark.slice(sent).some((n) => n.title.includes('retry-me')));
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).undelivered, []);
});
