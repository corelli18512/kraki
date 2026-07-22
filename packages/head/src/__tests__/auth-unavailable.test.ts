/**
 * Regression: a thrown/rejected auth-backend verifyChallenge (network timeout,
 * 5xx, abort) must surface as `auth_unavailable`, NOT `auth_rejected`.
 *
 * The old code mapped the `.catch` onto `auth_rejected`, which the arm treats
 * as a generic failure. For a paired device that meant processAuthError()
 * wiped the persisted deviceId — a 15s account-service timeout permanently
 * logged the user out and forced a fresh QR/GitHub pairing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import type { AuthMethod, DeviceInfo } from '@kraki/protocol';
import { Storage } from '../storage.js';
import { HeadServer } from '../server.js';
import type {
  AuthBackend, AuthOutcome, ChallengeOutcome, AuthInfoConfig,
} from '../auth-backend.js';

class FlakyChallengeBackend implements AuthBackend {
  /** When set, verifyChallenge rejects with this error (simulates timeout). */
  verifyError: Error | null = null;

  async authenticate(): Promise<AuthOutcome> {
    throw new Error('not used');
  }
  async startChallenge(): Promise<ChallengeOutcome> {
    return { ok: true, nonce: 'deadbeef', userId: 'u1', deviceId: 'dev_challenge' };
  }
  async verifyChallenge(): Promise<AuthOutcome> {
    if (this.verifyError) throw this.verifyError;
    return { ok: true, userId: 'u1', deviceId: 'dev_challenge', authMethod: 'challenge', user: { id: 'u1', login: 'x', provider: 'open' }, devices: [] };
  }
  createPairingToken() { return { token: 't', expiresIn: 900 }; }
  async requestPairingToken() { return { ok: true as const, userId: 'u1', pairingToken: 't', expiresIn: 900 }; }
  getAuthInfo(): AuthInfoConfig { return { methods: ['challenge'] }; }
}

async function createEnv() {
  const storage = new Storage(':memory:');
  const backend = new FlakyChallengeBackend();
  const server = new HeadServer(storage, { authBackend: backend });
  const httpServer = createServer();
  server.attach(httpServer);
  await new Promise<void>(r => httpServer.listen(0, r));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    port, backend,
    cleanup: async () => { server.close(); await new Promise<void>(r => httpServer.close(() => r())); storage.close(); },
  };
}

async function challengeAuth(port: number): Promise<Record<string, unknown>[]> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const raw: Record<string, unknown>[] = [];
  await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.on('message', (d) => raw.push(JSON.parse(d.toString())));
  // initiate challenge auth
  ws.send(JSON.stringify({
    type: 'auth',
    auth: { method: 'challenge', deviceId: 'dev_challenge' },
    device: { name: 'dev', role: 'app', deviceId: 'dev_challenge', publicKey: 'pub', encryptionKey: 'enc' },
  }));
  // wait for the challenge nonce
  const nonce = await new Promise<string>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('no challenge')), 2000);
    const iv = setInterval(() => {
      const c = raw.find(m => m.type === 'auth_challenge');
      if (c) { clearTimeout(to); clearInterval(iv); resolve((c as { nonce: string }).nonce); }
    }, 10);
  });
  // respond with a signature
  ws.send(JSON.stringify({ type: 'auth_response', deviceId: 'dev_challenge', signature: 'sig-' + nonce }));
  // collect the next auth_error / auth_ok
  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('no auth response')), 2000);
    const iv = setInterval(() => {
      const e = raw.find(m => m.type === 'auth_error' || m.type === 'auth_ok');
      if (e) { clearTimeout(to); clearInterval(iv); resolve(e); }
    }, 10);
  });
  ws.close();
  return [result, ...raw];
}

describe('Challenge auth: transient backend outage → auth_unavailable (not auth_rejected)', () => {
  let env: Awaited<ReturnType<typeof createEnv>>;
  beforeEach(async () => { env = await createEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it('reports service_unavailable when verifyChallenge rejects (timeout/network)', async () => {
    env.backend.verifyError = new Error('The operation was aborted due to timeout');
    const messages = await challengeAuth(env.port);
    const err = messages.find(m => m.type === 'auth_error') as { code?: string; message?: string } | undefined;
    expect(err).toBeDefined();
    expect(err!.code).toBe('service_unavailable');
    expect(err!.message).toContain('unavailable');
  });

  it('reports service_unavailable on a 5xx backend error too', async () => {
    env.backend.verifyError = new Error('500 internal');
    const messages = await challengeAuth(env.port);
    const err = messages.find(m => m.type === 'auth_error') as { code?: string } | undefined;
    expect(err).toBeDefined();
    expect(err!.code).toBe('service_unavailable');
  });
});
