/**
 * Log audit 2026-10-22 (j): the Head closes a socket that has not signed in
 * within 15 s (4008) while each account service call may take up to 15 s. A
 * slow challenge + verify was cut off by the deadline after the account
 * service had already accepted it. The deadline now waits one more period
 * while the Head's own backend call is out.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { generateKeyPair, exportPublicKey, signChallenge } from '@kraki/crypto';
import { Storage } from '../storage.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { RemoteAuthBackend } from '../remote-auth-backend.js';
import { AccountApi } from '../account-api.js';
import { HeadServer } from '../server.js';
import { silenceLogs } from './log-capture.js';

silenceLogs();

describe('auth deadline with a slow account service', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function listen(server: Server): Promise<number> {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
    return (server.address() as AddressInfo).port;
  }

  async function edgeWithSlowAccount(delayMs: number, authTimeoutMs: number) {
    const keys = generateKeyPair();
    const account = new Storage(':memory:');
    account.upsertUser('u1', 'alice', 'open');
    account.upsertDevice('phone', 'u1', 'iPhone', 'app', 'ios', exportPublicKey(keys.publicKey), 'enc-1');
    const api = new AccountApi({ authBackend: new LocalAuthBackend({ storage: account, authProviders: new Map() }), serviceKey: 'k' });
    const accountPort = await listen(createServer(async (req, res) => {
      await new Promise((r) => setTimeout(r, delayMs));
      if (!(await api.handleRequest(req, res))) { res.writeHead(404); res.end(); }
    }));
    const edge = new Storage(':memory:');
    const head = new HeadServer(edge, {
      authBackend: new RemoteAuthBackend({ accountUrl: `http://127.0.0.1:${accountPort}`, serviceKey: 'k' }),
      authTimeoutMs,
    });
    const http = createServer();
    head.attach(http);
    const port = await listen(http);
    cleanups.push(() => { head.close(); edge.close(); account.close(); });
    return { port, keys };
  }

  it('a challenge + verify slower than the deadline still signs in', async () => {
    const { port, keys } = await edgeWithSlowAccount(600, 700);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.on('open', () => r()));
    const outcome = new Promise<string>((resolve) => {
      ws.on('close', (code) => resolve(`closed ${code}`));
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'auth_challenge') {
          ws.send(JSON.stringify({ type: 'auth_response', deviceId: 'phone', signature: signChallenge(msg.nonce, keys.privateKey) }));
        } else if (msg.type === 'auth_ok' || msg.type === 'auth_error') {
          resolve(msg.type);
        }
      });
    });
    ws.send(JSON.stringify({ type: 'auth', auth: { method: 'challenge', deviceId: 'phone' }, device: { name: 'iPhone', role: 'app', encryptionKey: 'enc-1' } }));
    expect(await outcome).toBe('auth_ok');
    ws.close();
  }, 20_000);

  it('a socket that never sends auth is still closed at the deadline', async () => {
    const { port } = await edgeWithSlowAccount(0, 100);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
    expect(code).toBe(4008);
  }, 20_000);
});
