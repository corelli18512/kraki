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

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kraki-watch-e2e-'));
  server = createServer((req, res) => {
    if (req.url === '/push') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { bark.push(JSON.parse(body)); res.end('{"code":200}'); });
      return;
    }
    if (req.url === '/ping') { pings++; res.end('OK'); return; }
    if (req.url === '/health/ready') { res.end('{"status":"ready"}'); return; }
    if (req.url === '/internal/metrics') { res.end(JSON.stringify({ counters: { 'push.attempted': 5, 'push.sent': 5, 'auth.ok': 2 } })); return; }
    res.writeHead(relayStatus, { 'Content-Type': 'application/json' });
    res.end(relayStatus === 200 ? '{"name":"@kraki/head","version":"0.21.0","status":"ok"}' : 'Bad Gateway');
  });
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  await writeFile(join(dir, 'systemctl'), '#!/bin/sh\nprintf "ActiveState=active\\nInvocationID=abc\\nActiveEnterTimestamp=@1760000000\\n"\n');
  await writeFile(join(dir, 'journalctl'), `#!/bin/sh\necho '◈ [2026-10-13T00:00:00.000Z] health {"conns":2,"durableRows":0,"rssMb":80}'\n`);
  await chmod(join(dir, 'systemctl'), 0o755);
  await chmod(join(dir, 'journalctl'), 0o755);
  await writeFile(join(dir, 'backup.json'), JSON.stringify({ ok: true, at: new Date().toISOString(), sizeBytes: 100, prevSizeBytes: 100, copied: true }));
  await writeFile(join(dir, 'watch.json'), JSON.stringify({
    host: 'test', label: '测试', timezone: 'Asia/Shanghai', quietHours: [0, 0], digestHour: 0,
    relayUnit: 'kraki-relay', metricsUrl: `http://127.0.0.1:${port}/internal/metrics`, backupStatus: join(dir, 'backup.json'),
    units: [{ unit: 'kraki-relay', name: 'relay 进程', severity: 'critical' }],
    probes: [
      { id: 'K-RELAY-DOWN', target: 't', name: '测试 relay', url: `http://127.0.0.1:${port}/`, expectBody: '"status":"ok"', relay: true, severity: 'critical', failAfter: 3, local: true },
      { id: 'K-RELAY-WS', target: 't', kind: 'ws', name: '测试 WebSocket', url: `ws://127.0.0.1:${port}/`, severity: 'critical', failAfter: 3 },
      { id: 'K-RELAY-READY', target: 't', name: '就绪', url: `http://127.0.0.1:${port}/health/ready`, expectBody: '"status":"ready"', severity: 'critical', failAfter: 3 },
    ],
  }));
});

after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

function run(...args) {
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
    { title: '测试：测试 relay无法访问', level: 'critical', call: '1', key: 'test-key' },
  );
  assert.match(bark[0].body, /HTTP 502/);
  await run();
  assert.equal(bark.length, 1, 'no repeat within 30 minutes');

  relayStatus = 200;
  await run();
  assert.equal(bark.length, 2);
  assert.match(bark[1].title, /^测试：已恢复 · /);
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
  assert.equal(d.group, 'Kraki 日报');
  assert.match(d.title, /^Kraki 日报 · 测试 · /);
  assert.match(d.body, /可用性  测试 relay/);
  assert.match(d.body, /推送  成功 5 \/ 失败 0/);
});
