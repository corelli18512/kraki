import { afterEach, describe, expect, it } from 'vitest';
import type { AuthCredentials, AuthOutcome, AuthProvider } from '../auth.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { Storage } from '../storage.js';
import { connectDevice, createTestEnv, type TestEnv } from './integration-helpers.js';

/** Regression: the head must hand each provider the connecting client's IP.
 *  Without it ThrottledAuthProvider keyed every failure under one bucket, so
 *  five bad logins locked out every user. */
describe('auth sees the client IP', () => {
  let env: TestEnv | undefined;
  afterEach(async () => { await env?.cleanup(); env = undefined; });

  it('passes the socket address to the auth provider', async () => {
    const seen: Array<string | undefined> = [];
    const provider: AuthProvider = {
      name: 'open',
      async authenticate(credentials: AuthCredentials): Promise<AuthOutcome> {
        seen.push(credentials.ip);
        return { ok: true, user: { id: 'u1', login: 'u1', provider: 'open' } };
      },
    };
    // Built the way cli.ts builds production (an explicit LocalAuthBackend).
    const backendStorage = new Storage(':memory:');
    const authBackend = new LocalAuthBackend({ storage: backendStorage, authProviders: new Map([['open', provider]]) });
    env = await createTestEnv({ authBackend });
    const device = await connectDevice(env.port, 'phone', 'app');
    device.close();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/127\.0\.0\.1|::1/);
  });
});

describe('auth that outlives its socket', () => {
  let env: TestEnv | undefined;
  afterEach(async () => { await env?.cleanup(); env = undefined; });

  it('a stale auth finishing after its socket closed does not evict the live connection', async () => {
    const { WebSocket } = await import('ws');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const provider: AuthProvider = {
      name: 'open',
      async authenticate(): Promise<AuthOutcome> {
        if (calls++ === 0) await gate; // only the first socket's auth is slow
        return { ok: true, user: { id: 'u1', login: 'u1', provider: 'open' } };
      },
    };
    env = await createTestEnv({ authProvider: undefined, authProviders: new Map([['open', provider]]), authTimeoutMs: 100 });
    const auth = JSON.stringify({ type: 'auth', auth: { method: 'open' }, device: { name: 'phone', role: 'app', deviceId: 'app_1' } });
    const open = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${env!.port}`);
      await new Promise<void>((resolve) => ws.on('open', () => resolve()));
      return ws;
    };

    const stale = await open();
    const staleClosed = new Promise<void>((resolve) => stale.on('close', () => resolve()));
    stale.send(auth);
    await staleClosed; // the auth deadline closed it while its auth was pending

    const live = await open();
    const liveOk = new Promise<void>((resolve) => live.on('message', (d) => {
      if (JSON.parse(d.toString()).type === 'auth_ok') resolve();
    }));
    live.send(auth);
    await liveOk;

    release(); // the stale auth now completes
    await new Promise((r) => setTimeout(r, 100));
    expect(live.readyState).toBe(WebSocket.OPEN);
    live.close();
  });
});
