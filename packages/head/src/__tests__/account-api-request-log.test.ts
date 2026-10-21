/**
 * Log audit 2026-10-22 (a): the account service logged nothing per request,
 * and an edge's failure could not be matched to the account service's side.
 * Every account API request now logs one line under the edge's request id.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { generateKeyPair, exportPublicKey, signChallenge } from '@kraki/crypto';
import { Storage } from '../storage.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { RemoteAuthBackend } from '../remote-auth-backend.js';
import { AccountApi } from '../account-api.js';
import { metrics, resetMetricsForTests } from '../metrics.js';
import { LogThrottle } from '../logger.js';
import { captureLogs, silenceLogs, type CapturingLogger } from './log-capture.js';

const SERVICE_KEY = 'request-log-key';

describe('account API request log', () => {
  let account: Storage;
  let server: Server;
  let url: string;
  let logs: CapturingLogger;
  const keys = generateKeyPair();

  beforeEach(async () => {
    resetMetricsForTests();
    account = new Storage(':memory:');
    account.upsertUser('u1', 'alice', 'open');
    account.upsertDevice('phone', 'u1', 'iPhone', 'app', 'ios', exportPublicKey(keys.publicKey), 'enc-1');
    const api = new AccountApi({ authBackend: new LocalAuthBackend({ storage: account, authProviders: new Map() }), serviceKey: SERVICE_KEY });
    server = createServer(async (req, res) => {
      if (!(await api.handleRequest(req, res))) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `http://localhost:${(server.address() as AddressInfo).port}`;
    logs = captureLogs();
  });

  afterEach(async () => {
    silenceLogs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    account.close();
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('logs each request with the edge request id, status, duration, caller and device', async () => {
    const remote = new RemoteAuthBackend({ accountUrl: url, serviceKey: SERVICE_KEY });
    const challenge = await remote.startChallenge('phone');
    if (!challenge.ok) throw new Error('challenge failed');
    const result = await remote.verifyChallenge('phone', challenge.nonce, signChallenge(challenge.nonce, keys.privateKey));
    expect(result.ok).toBe(true);
    await settle();

    const edgeSide = logs.find('Account service request');
    const serviceSide = logs.find('Account API request');
    expect(serviceSide.map((l) => l.data.path)).toEqual(['/api/auth/challenge', '/api/auth/verify']);
    for (const line of serviceSide) {
      expect(line.level).toBe('info');
      expect(line.data).toMatchObject({ method: 'POST', status: 200, caller: 'admin', deviceId: 'phone' });
      expect(typeof line.data.ms).toBe('number');
    }
    // Same id on both hosts.
    expect(edgeSide.map((l) => l.data.reqId)).toEqual(serviceSide.map((l) => l.data.reqId));
    expect(edgeSide[0].data).toMatchObject({ path: '/api/auth/challenge', status: 200, deviceId: 'phone' });
    expect(metrics().get('api.requests')).toBe(2);
    expect(metrics().accountApi.total).toBe(2);
  });

  it('logs a rejected request with its error code; a malformed request id is replaced', async () => {
    const res = await fetch(`${url}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong', 'X-Kraki-Request-Id': 'bad id!' },
      body: JSON.stringify({ deviceId: 'phone' }),
    });
    expect(res.status).toBe(401);
    const echoed = res.headers.get('x-kraki-request-id');
    expect(echoed).toMatch(/^[0-9a-f]{12}$/);
    await settle();
    const [line] = logs.find('Account API request');
    expect(line).toMatchObject({ level: 'info', data: { status: 401, code: 'unauthorized', reqId: echoed } });
  });

  it('rejected (401 / 429) request lines are capped per IP and in total, with suppression counts', async () => {
    let now = 0;
    const api = new AccountApi({
      authBackend: new LocalAuthBackend({ storage: account, authProviders: new Map() }),
      serviceKey: SERVICE_KEY,
      publicRateLimit: 2,
      rejectedRequestLog: new LogThrottle(5, 60, 60_000, () => now),
    });
    const limited = createServer(async (req, res) => {
      if (!(await api.handleRequest(req, res))) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => limited.listen(0, resolve));
    const base = `http://localhost:${(limited.address() as AddressInfo).port}`;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push((await fetch(`${base}/api/auth/challenge`, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' })).status);
      }
      for (let i = 0; i < 6; i++) statuses.push((await fetch(`${base}/api/config`)).status);
      expect(statuses.filter((s) => s === 401)).toHaveLength(6);
      expect(statuses.filter((s) => s === 429)).toHaveLength(4);
      await settle();
      const rejected = logs.find('Account API request').filter((l) => l.data.status === 401 || l.data.status === 429);
      expect(rejected).toHaveLength(5);
      now = 60_000;
      await fetch(`${base}/api/auth/challenge`, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' });
      await settle();
      const last = logs.find('Account API request').at(-1)!;
      expect(last.data).toMatchObject({ status: 401, suppressed: 5 });
    } finally {
      await new Promise<void>((resolve) => limited.close(() => resolve()));
    }
  });

  it('routine status polls log at debug', async () => {
    const remote = new RemoteAuthBackend({ accountUrl: url, serviceKey: SERVICE_KEY });
    await remote.refreshConfig();
    await settle();
    const [line] = logs.find('Account API request');
    expect(line).toMatchObject({ level: 'debug', data: { path: '/api/config', status: 200 } });
  });

  it('an edge failure logs request id, elapsed time, phase and device', async () => {
    // Accepts the connection, never answers.
    const hung = createServer(() => { /* no response */ });
    await new Promise<void>((resolve) => hung.listen(0, resolve));
    try {
      const remote = new RemoteAuthBackend({ accountUrl: `http://localhost:${(hung.address() as AddressInfo).port}`, serviceKey: SERVICE_KEY, timeout: 100 });
      const result = await remote.startChallenge('phone');
      expect(result).toMatchObject({ ok: false, code: 'service_unavailable' });
      const [line] = logs.find('Account service request failed');
      expect(line.data).toMatchObject({ path: '/api/auth/challenge', phase: 'headers', deviceId: 'phone' });
      expect(line.data.reqId).toMatch(/^[0-9a-f]{12}$/);
      expect(line.data.ms as number).toBeGreaterThanOrEqual(90);
    } finally {
      hung.closeAllConnections();
      await new Promise<void>((resolve) => hung.close(() => resolve()));
    }
  });
});
