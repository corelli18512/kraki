import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LatencyHistogram, LATENCY_BUCKETS_MS, metrics, resetMetricsForTests } from '../metrics.js';
import { handleObservability, readiness, type ReadinessContext } from '../observability.js';
import { PushManager, type PushProvider, type PushPayload, type PushResult } from '../push/index.js';
import { Storage } from '../storage.js';
import { WebSocket } from 'ws';
import { createTestEnv, connectDevice, type TestEnv } from './integration-helpers.js';

describe('LatencyHistogram', () => {
  it('reports bucket upper bounds for quantiles', () => {
    const h = new LatencyHistogram();
    for (let i = 0; i < 90; i++) h.observe(0.5); // ≤ 1 ms
    for (let i = 0; i < 9; i++) h.observe(40); // ≤ 50 ms
    h.observe(4000); // open bucket
    const s = h.snapshot();
    expect(s.count).toBe(100);
    expect(s.p50Ms).toBe(1);
    expect(s.p95Ms).toBe(50);
    expect(s.p99Ms).toBe(50);
    expect(s.maxMs).toBe(4000);
    expect(s.buckets).toHaveLength(LATENCY_BUCKETS_MS.length + 1);
    expect(s.buckets[s.buckets.length - 1]).toBe(1);
  });

  it('is empty until observed and ignores bad samples', () => {
    const h = new LatencyHistogram();
    h.observe(-1);
    h.observe(Number.NaN);
    expect(h.snapshot()).toMatchObject({ count: 0, p95Ms: null, meanMs: null });
  });
});

function context(over: Partial<ReadinessContext> = {}): ReadinessContext {
  return {
    version: '9.9.9',
    startedAt: Date.now(),
    pingDatabase: () => {},
    expectedPushProviders: ['apns'],
    loadedPushProviders: () => ['apns'],
    gauges: () => ({ connections: 2 }),
    ...over,
  };
}

describe('readiness', () => {
  beforeEach(() => { resetMetricsForTests(); });

  it('is ready when the database answers, the loop ticks and push is loaded', () => {
    metrics().lastHealthAt = Date.now();
    expect(readiness(context())).toEqual({ ok: true, checks: { database: 'ok', eventLoop: 'ok', push: 'ok' } });
  });

  it('fails when the database throws', () => {
    const r = readiness(context({ pingDatabase: () => { throw new Error('SQLITE_CORRUPT'); } }));
    expect(r.ok).toBe(false);
    expect(r.checks.database).toBe('fail');
  });

  it('fails when the health tick stopped (event loop stuck)', () => {
    const now = Date.now();
    metrics().lastHealthAt = now - 120_000;
    expect(readiness(context({ startedAt: now - 600_000 }), now).checks.eventLoop).toBe('fail');
  });

  it('gives a fresh process time for its first health tick', () => {
    const now = Date.now();
    expect(readiness(context({ startedAt: now - 10_000 }), now).checks.eventLoop).toBe('ok');
    expect(readiness(context({ startedAt: now - 200_000 }), now).checks.eventLoop).toBe('fail');
  });

  it('names a configured push provider that did not load', () => {
    const r = readiness(context({ expectedPushProviders: ['apns', 'web_push'], loadedPushProviders: () => ['apns'] }));
    expect(r.ok).toBe(false);
    expect(r.checks.push).toBe('fail:web_push');
  });
});

describe('observability endpoints', () => {
  let server: Server;
  let port: number;
  let ctx: ReadinessContext;

  beforeEach(async () => {
    resetMetricsForTests();
    metrics().lastHealthAt = Date.now();
    ctx = context();
    server = createServer((req, res) => {
      if (handleObservability(req, res, ctx)) return;
      res.writeHead(200);
      res.end('other');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('/health/ready answers 200 with the checks and no user data', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ status: 'ready', version: '9.9.9', checks: { database: 'ok', eventLoop: 'ok', push: 'ok' } });
    expect(Object.keys(body).sort()).toEqual(['checks', 'status', 'uptimeSec', 'version']);
  });

  it('/health/ready answers 503 when not ready', async () => {
    ctx = context({ pingDatabase: () => { throw new Error('locked'); } });
    const res = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe('not_ready');
  });

  it('/internal/metrics answers a direct loopback request', async () => {
    metrics().inc('push.sent', 3);
    const res = await fetch(`http://127.0.0.1:${port}/internal/metrics`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counters['push.sent']).toBe(3);
    expect(body.gauges).toEqual({ connections: 2 });
    expect(body.ready.ok).toBe(true);
  });

  it('/internal/metrics refuses requests that came through a reverse proxy', async () => {
    for (const header of ['x-forwarded-for', 'x-real-ip', 'forwarded']) {
      const res = await fetch(`http://127.0.0.1:${port}/internal/metrics`, { headers: { [header]: '203.0.113.9' } });
      expect(res.status, header).toBe(404);
    }
  });

  it('leaves every other path to the caller', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await res.text()).toBe('other');
  });
});

class ScriptedPush implements PushProvider {
  readonly name = 'apns';
  constructor(private readonly results: Array<PushResult | Error>) {}
  async send(_token: string, _payload: PushPayload): Promise<PushResult> {
    const next = this.results.shift() ?? { success: true };
    if (next instanceof Error) throw next;
    return next;
  }
}

describe('push counters', () => {
  it('counts sent, failed, gone, auth errors and throws', async () => {
    resetMetricsForTests();
    const storage = new Storage(':memory:');
    storage.upsertUser('u1', 'alice');
    const devices = ['d1', 'd2', 'd3', 'd4', 'd5'];
    for (const id of devices) {
      storage.upsertDevice(id, 'u1', id, 'app', 'ios');
      storage.upsertPushToken(id, 'apns', `tok-${id}`, 'production', 'com.kraki');
    }
    const manager = new PushManager(storage, [new ScriptedPush([
      { success: true },
      { success: false, error: 'TooManyRequests' },
      { success: false, gone: true, error: 'Unregistered' },
      { success: false, error: 'ExpiredProviderToken' },
      new Error('boom'),
    ])]);
    await manager.sendToOfflineDevices('u1', [], {
      blob: 'b',
      keys: Object.fromEntries(devices.map((id) => [id, 'k'])),
    });
    const c = metrics().snapshot().counters as Record<string, number>;
    expect(c).toMatchObject({
      'push.attempted': 5, 'push.sent': 1, 'push.failed': 2, 'push.gone': 1, 'push.authError': 1, 'push.threw': 1,
    });
    expect(manager.providerNames()).toEqual(['apns']);
    storage.close();
  });
});

describe('relay counters on a live server', () => {
  let env: TestEnv;
  afterEach(async () => { await env?.cleanup(); });

  it('counts connections, auth and pulse frames, without identities', async () => {
    resetMetricsForTests();
    env = await createTestEnv();
    const app = await connectDevice(env.port, 'Phone', 'app');
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
    // The app's HELLO and head-originated control frames ride pulse.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const s = metrics().snapshot();
    const c = s.counters as Record<string, number>;
    expect(c['conn.opened']).toBe(2);
    expect(c['auth.ok']).toBe(2);
    expect(c['pulse.frames.in']).toBeGreaterThan(0);
    expect(c['pulse.frames.out']).toBeGreaterThan(0);
    expect((s.frameHandling as { count: number }).count).toBe(c['pulse.frames.in']);
    app.close();
    tentacle.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((metrics().snapshot().counters as Record<string, number>)['conn.closed']).toBe(2);
    expect(JSON.stringify(metrics().snapshot())).not.toContain(app.deviceId);
    expect(env.server.getGauges().connections).toBe(0);
  });

  it('counts auth failures by code', async () => {
    resetMetricsForTests();
    env = await createTestEnv();
    const ws = new WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise((resolve) => ws.on('open', resolve));
    const reply = new Promise<Record<string, unknown>>((resolve) => ws.on('message', (d) => resolve(JSON.parse(d.toString()))));
    ws.send(JSON.stringify({ type: 'auth', auth: { method: 'pairing', token: 'nope' }, device: { name: 'Phone', role: 'app' } }));
    expect((await reply).type).toBe('auth_error');
    ws.close();
    const s = metrics().snapshot();
    expect((s.counters as Record<string, number>)['auth.fail']).toBe(1);
    expect(Object.values(s.authFailures as Record<string, number>)).toEqual([1]);
  });
});
