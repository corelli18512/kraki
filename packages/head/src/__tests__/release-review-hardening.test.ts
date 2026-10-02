/**
 * Relay hardening from the release review (G1–G4).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, request, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { Storage } from '../storage.js';
import { HeadServer } from '../server.js';
import { GitHubAuthProvider } from '../auth.js';
import { AccountApi, IpRateLimiter, MAX_BODY_BYTES } from '../account-api.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { clientIp } from '../client-ip.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return (server.address() as AddressInfo).port;
}

async function startHead(options: ConstructorParameters<typeof HeadServer>[1]) {
  const storage = new Storage(':memory:');
  const head = new HeadServer(storage, options);
  const http = createServer();
  head.attach(http);
  const port = await listen(http);
  cleanups.push(() => { head.close(); storage.close(); });
  return port;
}

function closeOf(ws: WebSocket): Promise<{ code: number; at: number }> {
  return new Promise((resolve) => ws.on('close', (code) => resolve({ code, at: Date.now() })));
}

describe('G1: unauthenticated sockets are closed', () => {
  it('closes a socket that never authenticates', async () => {
    const port = await startHead({ authProvider: new GitHubAuthProvider(), authTimeoutMs: 150 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const closed = closeOf(ws);
    const start = Date.now();
    const { code, at } = await closed;
    expect(code).toBe(4008);
    expect(at - start).toBeLessThan(2000);
  });

  it('gives an app on its login screen (sent auth_info) the longer deadline', async () => {
    const port = await startHead({ authProvider: new GitHubAuthProvider(), authTimeoutMs: 150, loginScreenAuthTimeoutMs: 60_000 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'auth_info' }));
    await new Promise((r) => setTimeout(r, 400));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

describe('G2: X-Forwarded-For only from a trusted proxy', () => {
  const req = (remoteAddress: string, xff?: string) =>
    ({ socket: { remoteAddress }, headers: xff ? { 'x-forwarded-for': xff } : {} }) as unknown as IncomingMessage;

  it('ignores the header from a direct (untrusted) client', () => {
    expect(clientIp(req('203.0.113.9', '1.2.3.4'), new Set())).toBe('203.0.113.9');
  });

  it('uses the address the local proxy appended (rightmost), not a spoofed one', () => {
    expect(clientIp(req('127.0.0.1', '6.6.6.6, 198.51.100.7'), new Set())).toBe('198.51.100.7');
    expect(clientIp(req('::ffff:127.0.0.1', '198.51.100.7'), new Set())).toBe('198.51.100.7');
  });

  it('trusts configured proxies', () => {
    expect(clientIp(req('10.0.0.5', '198.51.100.7'), new Set(['10.0.0.5']))).toBe('198.51.100.7');
    expect(clientIp(req('127.0.0.1'), new Set())).toBe('127.0.0.1');
  });
});

describe('G3: account API body cap and per-IP limit', () => {
  async function startApi(publicRateLimit = 60) {
    const storage = new Storage(':memory:');
    const backend = new LocalAuthBackend({ storage, authProviders: new Map() });
    const api = new AccountApi({ authBackend: backend, serviceKey: 'svc', publicRateLimit });
    const http = createServer((req, res) => {
      void api.handleRequest(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
    });
    const port = await listen(http);
    cleanups.push(() => storage.close());
    return port;
  }

  function post(port: number, path: string, body: string | Buffer, chunked = false): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path, method: 'POST', headers: chunked ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      r.on('error', reject);
      if (chunked) { r.write(body); r.end(); } else r.end(body);
    });
  }

  it('rejects bodies over 64 KB, declared or streamed', async () => {
    const port = await startApi();
    const big = JSON.stringify({ auth: { method: 'open' }, pad: 'x'.repeat(MAX_BODY_BYTES) });
    expect((await post(port, '/api/login/resolve', big)).status).toBe(413);
    expect((await post(port, '/api/login/resolve', big, true)).status).toBe(413);
  });

  it('limits public routes per IP', async () => {
    const port = await startApi(3);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(port, '/api/login/resolve', '{}')).status);
    expect(statuses.slice(0, 3)).toEqual([400, 400, 400]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it('opens a new window after a minute', () => {
    let now = 0;
    const limiter = new IpRateLimiter(1, 60_000, () => now);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
    expect(limiter.take('b')).toBe(true);
    now = 60_000;
    expect(limiter.take('a')).toBe(true);
  });
});

describe('G4: GitHub outage is not a rejected login', () => {
  it('reports network errors and 5xx as retryable, 401 as a real rejection', async () => {
    const down = new GitHubAuthProvider({ fetcher: async () => { throw new Error('ECONNRESET'); } });
    expect(await down.authenticate({ token: 't' })).toMatchObject({ ok: false, retryable: true });
    const outage = new GitHubAuthProvider({ fetcher: async () => new Response('', { status: 502 }) });
    expect(await outage.authenticate({ token: 't' })).toMatchObject({ ok: false, retryable: true });
    const bad = new GitHubAuthProvider({ fetcher: async () => new Response('', { status: 401 }) });
    const rejected = await bad.authenticate({ token: 't' });
    expect(rejected.ok).toBe(false);
    expect((rejected as { retryable?: boolean }).retryable).toBeFalsy();
  });

  it('inline github_token auth answers service_unavailable during an outage', async () => {
    const provider = new GitHubAuthProvider({ fetcher: async () => { throw new Error('ENOTFOUND api.github.com'); } });
    const port = await startHead({ authProvider: provider });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => ws.on('open', r));
    const reply = new Promise<Record<string, unknown>>((r) => ws.on('message', (d) => r(JSON.parse(d.toString()))));
    ws.send(JSON.stringify({ type: 'auth', auth: { method: 'github_token', token: 'gho_x' }, device: { name: 'd', role: 'tentacle' } }));
    expect(await reply).toMatchObject({ type: 'auth_error', code: 'service_unavailable' });
    ws.close();
  });
});
