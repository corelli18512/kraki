/**
 * Tests for the edge-mode auth path (authBackend configured).
 *
 * These specifically guard against a bug that was silently active for ~a
 * month after the multi-region migration: the edge path did not merge local
 * user preferences into the auth_ok user response — it returned the backend's
 * user object verbatim. A user updating preferences via an edge would have
 * their local prefs overwritten by the backend's stale view on next reconnect.
 *
 * Now fixed by routing all auth paths through a single
 * `completeAuthHandshake` helper.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { decodeFrame } from '@kraki/pulse';
import type { AuthMethod, DeviceInfo } from '@kraki/protocol';
import { HEAD_PULSE_TARGET } from '@kraki/protocol';
import { Storage } from '../storage.js';
import { HeadServer } from '../server.js';
import type {
  AuthBackend, AuthOutcome, ChallengeOutcome, AuthInfoConfig,
} from '../auth-backend.js';

/** Unwrap head-originated pulse control frames back to their inner control
 *  messages. Head→device control (device_joined/left/pending, preferences) now
 *  rides pulse: each such message arrives as a `unicast` envelope wrapping a
 *  plaintext `{from:'@head', msg}` payload. This maps a raw received-message
 *  array to the control messages a real client would dispatch: head-control
 *  frames yield their inner `msg`; non-pulse envelopes (auth_ok, …) pass
 *  through unchanged; other pulse frames (HELLO/ACK/heartbeat) are dropped. */
function unwrapControl(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (typeof m.pulse === 'string') {
      const frame = decodeFrame(new Uint8Array(Buffer.from(m.pulse as string, 'base64')));
      if (frame?.t === 'data') {
        try {
          const inner = JSON.parse(new TextDecoder().decode(frame.payload)) as {
            from?: string; msg?: Record<string, unknown>;
          };
          if (inner.from === HEAD_PULSE_TARGET && inner.msg) { out.push(inner.msg); continue; }
        } catch { /* fall through */ }
      }
      continue; // non-head pulse frame — a real client hands it to its pulse layer
    }
    out.push(m); // non-pulse message (auth_ok, …) passes through
  }
  return out;
}

// ── Minimal mock auth backend ───────────────────────────────

/**
 * Mock auth backend that always succeeds for `open` and `pairing`
 * (simulating a real edge that delegates auth to a remote backend).
 */
class MockAuthBackend implements AuthBackend {
  private static seq = 0;
  /** User identity returned to the head. */
  user: {
    id: string;
    login: string;
    provider: string;
    email?: string;
    preferences?: Record<string, unknown>;
    region?: string;
  } = {
    id: 'u_remote',
    login: 'remote-user',
    provider: 'open',
    email: 'remote@example.com',
  };

  async authenticate(_auth: AuthMethod, device: DeviceInfo): Promise<AuthOutcome> {
    const deviceId = device.deviceId ?? `dev_remote_${++MockAuthBackend.seq}`;
    return {
      ok: true,
      userId: this.user.id,
      deviceId,
      authMethod: 'open',
      user: { ...this.user },
      devices: [{
        id: deviceId,
        name: device.name,
        role: device.role,
        kind: device.kind,
        publicKey: device.publicKey,
        encryptionKey: device.encryptionKey,
        online: false,
      }],
    };
  }

  async startChallenge(_deviceId: string): Promise<ChallengeOutcome> {
    throw new Error('not implemented for these tests');
  }

  async verifyChallenge(): Promise<AuthOutcome> {
    throw new Error('not implemented for these tests');
  }

  createPairingToken(): { token: string; expiresIn: number } {
    return { token: 'mock-token', expiresIn: 900 };
  }

  async requestPairingToken() {
    return { ok: true as const, userId: this.user.id, pairingToken: 'mock', expiresIn: 900 };
  }

  getAuthInfo(): AuthInfoConfig {
    return { methods: ['open'] };
  }
}

// ── Test rig ────────────────────────────────────────────────

interface EdgeTestEnv {
  port: number;
  storage: Storage;
  server: HeadServer;
  httpServer: Server;
  backend: MockAuthBackend;
  cleanup: () => Promise<void>;
}

async function createEdgeTestEnv(): Promise<EdgeTestEnv> {
  const storage = new Storage(':memory:');
  const backend = new MockAuthBackend();
  const server = new HeadServer(storage, { authBackend: backend });

  const httpServer = createServer();
  server.attach(httpServer);
  await new Promise<void>(resolve => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;

  const cleanup = async () => {
    server.close();
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    storage.close();
  };

  return { port, storage, server, httpServer, backend, cleanup };
}

interface Connected {
  ws: WebSocket;
  authOk: Record<string, unknown>;
  deviceId: string;
  raw: Record<string, unknown>[];
}

async function connectEdge(port: number, deviceId: string, role: 'tentacle' | 'app' = 'tentacle'): Promise<Connected> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const raw: Record<string, unknown>[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.on('message', (data) => {
    raw.push(JSON.parse(data.toString()));
  });

  ws.send(JSON.stringify({
    type: 'auth',
    auth: { method: 'open' },
    device: { name: `dev-${deviceId}`, role, deviceId, publicKey: 'pub-' + deviceId },
  }));

  // Wait for auth_ok (~100ms is plenty).
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const ok = raw.find(m => m.type === 'auth_ok');
    if (ok) return { ws, authOk: ok, deviceId, raw };
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`auth_ok timeout for ${deviceId}`);
}

// ── Tests ───────────────────────────────────────────────────

describe('Edge-mode auth: local preferences merged into user response', () => {
  let env: EdgeTestEnv;
  beforeEach(async () => { env = await createEdgeTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it('returns local preferences even when backend returns user without them', async () => {
    // User exists in local storage with preferences set (the edge mirrored
    // the user during a previous auth, and the user updated prefs since).
    env.storage.upsertUser('u_remote', 'remote-user', 'open');
    env.storage.updatePreferences('u_remote', { theme: 'dark', autoMode: true });

    // Backend's user object doesn't include the preferences.
    env.backend.user = {
      id: 'u_remote', login: 'remote-user', provider: 'open', email: 'remote@example.com',
    };

    const { authOk } = await connectEdge(env.port, 'dev_t4');

    const user = authOk.user as Record<string, unknown>;
    expect(user.preferences).toEqual({ theme: 'dark', autoMode: true });
  });

  it('handles missing local user record gracefully (preferences undefined)', async () => {
    // No upsertUser before connect — head will upsert during mirror, but
    // with no preferences set. Backend also returns no preferences.
    const { authOk } = await connectEdge(env.port, 'dev_t5');
    const user = authOk.user as Record<string, unknown>;
    // preferences should be omitted/undefined, not crash.
    expect(user.preferences).toBeUndefined();
  });

  it('falls back to backend preferences when local has none (first-time auth)', async () => {
    // User authenticating for the first time on this edge — no local record yet.
    // Backend is canonical and supplies preferences.
    env.backend.user = {
      id: 'u_remote',
      login: 'remote-user',
      provider: 'open',
      email: 'remote@example.com',
      preferences: { theme: 'light', autoMode: false, fromBackend: true },
    };

    const { authOk } = await connectEdge(env.port, 'dev_t_first_auth');

    const user = authOk.user as Record<string, unknown>;
    // Backend preferences must reach the client. Without the fallback, they
    // would be silently dropped because storage.upsertUser doesn't persist
    // preferences and the subsequent getUser returns preferences=undefined.
    expect(user.preferences).toEqual({ theme: 'light', autoMode: false, fromBackend: true });
  });

  it('local preferences override backend preferences when both exist', async () => {
    // Local already has prefs (set by user via update_preferences on this edge).
    env.storage.upsertUser('u_remote', 'remote-user', 'open');
    env.storage.updatePreferences('u_remote', { theme: 'dark', source: 'local' });

    // Backend also reports preferences, but stale ones.
    env.backend.user = {
      id: 'u_remote',
      login: 'remote-user',
      provider: 'open',
      preferences: { theme: 'light', source: 'backend' },
    };

    const { authOk } = await connectEdge(env.port, 'dev_t_pref_conflict');

    const user = authOk.user as Record<string, unknown>;
    expect(user.preferences).toEqual({ theme: 'dark', source: 'local' });
  });
});

describe('Edge-mode auth: the account service owns `internal`', () => {
  let env: EdgeTestEnv;
  beforeEach(async () => { env = await createEdgeTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  const backendUser = (preferences?: Record<string, unknown>) => ({
    id: 'u_remote', login: 'remote-user', provider: 'open', email: 'remote@example.com', preferences,
  });

  it('first sign-in on the edge: internal and the backend preferences both arrive', async () => {
    env.backend.user = backendUser({ theme: 'light', internal: true });
    const { authOk, ws } = await connectEdge(env.port, 'dev_int_1', 'app');
    expect((authOk.user as Record<string, unknown>).preferences).toEqual({ theme: 'light', internal: true });
    // Mirrored locally, so the edge's own preferences_updated keeps it.
    expect(env.storage.getUser('u_remote')?.preferences).toEqual({ internal: true });
    ws.close();
  });

  it('a theme change on the edge keeps internal in preferences_updated', async () => {
    env.backend.user = backendUser({ internal: true });
    const { ws } = await connectEdge(env.port, 'dev_int_2', 'app');
    ws.send(JSON.stringify({ type: 'update_preferences', preferences: { theme: 'dark', internal: false } }));
    // preferences_updated carries exactly the stored, merged preferences.
    const start = Date.now();
    while (env.storage.getUser('u_remote')?.preferences?.theme !== 'dark' && Date.now() - start < 2000) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(env.storage.getUser('u_remote')?.preferences).toEqual({ internal: true, theme: 'dark' });
    ws.close();
  });

  it('stale local internal is overridden by the backend (revoked on main)', async () => {
    env.storage.upsertUser('u_remote', 'remote-user', 'open');
    env.storage.updatePreferences('u_remote', { theme: 'dark' });
    env.storage.setInternal('u_remote', true);
    env.backend.user = backendUser({ theme: 'dark' });
    const { authOk, ws } = await connectEdge(env.port, 'dev_int_3', 'app');
    expect((authOk.user as Record<string, unknown>).preferences).toEqual({ theme: 'dark' });
    expect(env.storage.getUser('u_remote')?.preferences).toEqual({ theme: 'dark' });
    ws.close();
  });

  it('a stable account never becomes internal on the edge', async () => {
    env.backend.user = backendUser({ theme: 'light' });
    const { authOk, ws } = await connectEdge(env.port, 'dev_int_4', 'app');
    expect((authOk.user as Record<string, unknown>).preferences).toEqual({ theme: 'light' });
    ws.close();
  });

  it('backend without preferences keeps the local value', async () => {
    env.storage.upsertUser('u_remote', 'remote-user', 'open');
    env.storage.setInternal('u_remote', true);
    env.backend.user = backendUser(undefined);
    const { authOk, ws } = await connectEdge(env.port, 'dev_int_5', 'app');
    expect((authOk.user as Record<string, unknown>).preferences).toEqual({ internal: true });
    ws.close();
  });
});

describe('Edge-mode auth: response shape regression', () => {
  let env: EdgeTestEnv;
  beforeEach(async () => { env = await createEdgeTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it('auth_ok contains all expected fields', async () => {
    const { authOk } = await connectEdge(env.port, 'dev_t6');
    expect(authOk.type).toBe('auth_ok');
    expect(authOk.deviceId).toBe('dev_t6');
    expect(authOk.authMethod).toBe('open');
    expect(authOk.user).toMatchObject({ id: 'u_remote', login: 'remote-user' });
    expect(Array.isArray(authOk.devices)).toBe(true);
  });

  it('device_joined is broadcast to existing peers on new auth', async () => {
    // First device — no peers to notify.
    const first = await connectEdge(env.port, 'dev_first');
    expect(unwrapControl(first.raw).find(m => m.type === 'device_joined')).toBeUndefined();

    // Second device connects — first should receive device_joined.
    await connectEdge(env.port, 'dev_second');
    // Allow time for the broadcast.
    await new Promise(r => setTimeout(r, 50));

    const joined = unwrapControl(first.raw).find(m => m.type === 'device_joined');
    expect(joined).toBeDefined();
    expect((joined!.device as Record<string, unknown>).id).toBe('dev_second');
  });
});
