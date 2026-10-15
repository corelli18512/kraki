import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { sendBark } from '../lib/bark.mjs';
import { deliveryConfig } from '../lib/config.mjs';

const notice = { kind: 'fire', severity: 'critical', title: 'test', body: 'metadata only' };
const options = { deviceKey: 'test-secret', attempts: 1, sleep: async () => {} };

// API contract: https://github.com/Finb/bark-server/blob/master/docs/API_V2.md
// and route_push.go (single-device response code 200).
test('Bark POST uses a JSON body, never a key in the URL; success needs code 200', async () => {
  const result = await sendBark(notice, { ...options, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.day.app/push');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(JSON.parse(init.body).device_key, options.deviceKey);
    return new Response('{"code":200,"message":"success"}');
  } });
  assert.deepEqual(result, { ok: true });
});

test('real HTTP digest requests remain passive and silent for every severity and quiet-hour state', async () => {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.setHeader('Content-Type', 'application/json');
      res.end('{"code":200}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const severity of ['info', 'warning', 'critical']) {
      for (const quiet of [false, true]) {
        const result = await sendBark({ kind: 'digest', severity, quiet, title: '日报', body: '观察数据' }, {
          ...options, server: `http://127.0.0.1:${server.address().port}`,
        });
        assert.deepEqual(result, { ok: true });
      }
    }
    assert.equal(received.length, 6);
    for (const payload of received) {
      assert.equal(payload.level, 'passive');
      assert.equal(payload.sound, 'silence');
      assert.equal(payload.group, 'Kraki 日报');
      assert.equal(payload.isArchive, '1');
      assert.equal(payload.call, undefined);
      assert.equal(payload.volume, undefined);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('HTTP success with a Bark error, HTML, empty or unrelated JSON is a failure', async () => {
  for (const body of ['{"code":400,"message":"test-secret"}', '<html>test-secret</html>', '', '{}', 'null']) {
    const result = await sendBark(notice, { ...options, fetchImpl: async () => new Response(body) });
    assert.equal(result.ok, false, body);
    assert.doesNotMatch(result.error, /test-secret/);
  }
});

test('transport errors and HTTP failures do not expose response or exception secrets', async () => {
  for (const fetchImpl of [async () => { throw new Error('test-secret'); }, async () => new Response('test-secret', { status: 401 })]) {
    const result = await sendBark(notice, { ...options, fetchImpl });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /test-secret/);
  }
});

test('temporary rejection retries and a persistent rejection fails after the bounded attempts', async () => {
  let calls = 0;
  const waits = [];
  const result = await sendBark(notice, { ...options, attempts: 3, sleep: async (ms) => waits.push(ms), fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ code: calls < 3 ? 500 : 200 }));
  } });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
  calls = 0;
  const failed = await sendBark(notice, { ...options, attempts: 2, fetchImpl: async () => {
    calls++;
    return new Response('{"code":500}');
  } });
  assert.equal(failed.ok, false);
  assert.equal(calls, 2);
});

test('missing keys, full URLs pasted as keys, and unsafe endpoints fail before sending', async () => {
  for (const over of [
    { deviceKey: '' }, { deviceKey: 'https://api.day.app/test-secret/' },
    { server: 'http://example.com' }, { server: 'https://test-secret@example.com' },
    { server: 'https://example.com?key=test-secret' }, { server: 'bad-test-secret-url' },
  ]) {
    const result = await sendBark(notice, { ...options, ...over, fetchImpl: async () => assert.fail('must not send') });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /test-secret/);
  }
});

test('configuration checks allow shadow without secrets, warn about missing heartbeat, and reject typos', () => {
  const shadow = deliveryConfig({});
  assert.deepEqual(shadow.errors, []);
  assert.equal(shadow.warnings.length, 2);
  assert.ok(deliveryConfig({}, { requireLive: true }).errors.length);
  assert.ok(deliveryConfig({ KRAKI_WATCH_NOTIFY: 'true' }).errors.length);
  assert.ok(deliveryConfig({ KRAKI_WATCH_NOTIFY: '1' }).errors.length);
  assert.ok(deliveryConfig({ HC_PING_URL: 'http://example.com/secret' }).errors.length);
  assert.deepEqual(deliveryConfig({ KRAKI_WATCH_NOTIFY: '1', BARK_KEY: 'test', HC_PING_URL: 'https://hc-ping.com/secret' }), { errors: [], warnings: [] });
});

test('real fetch refuses a redirect without sending the device key to its target; hanging response times out', async () => {
  let leaked = false;
  const server = createServer((req, res) => {
    if (req.url === '/redirect/push') { res.writeHead(307, { Location: '/sink' }); res.end(); }
    else if (req.url === '/sink') { leaked = true; res.end('{"code":200}'); }
    // /hang/push never responds.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await sendBark(notice, { ...options, server: `${base}/redirect` })).ok, false);
    assert.equal(leaked, false);
    const result = await sendBark(notice, { ...options, server: `${base}/hang`, timeoutMs: 100 });
    assert.deepEqual(result, { ok: false, error: 'Bark request timed out' });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
