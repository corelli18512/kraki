/**
 * Tests for the edge-mode auth path (authBackend configured).
 *
 * These specifically guard against bugs that were silently active for ~a
 * month after the multi-region migration:
 *
 *  1. The edge head's local `pending_messages` table was never flushed on
 *     reconnect, because `handleBackendAuthResult` only used the auth
 *     backend's `pendingMessages` (which is always empty in delegated mode).
 *     Any unicasts the edge had queued for an offline device were silently
 *     dropped on reconnect.
 *
 *  2. The edge path also did not merge local user preferences into the
 *     auth_ok user response — it returned the backend's user object verbatim.
 *     A user updating preferences via an edge would have their local prefs
 *     overwritten by the backend's stale view on next reconnect.
 *
 * Both are now fixed by routing all three auth paths through a single
 * `completeAuthHandshake` helper.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import type { AuthMethod, DeviceInfo, UnicastEnvelope } from '@kraki/protocol';
import { Storage } from '../storage.js';
import { HeadServer } from '../server.js';
import type {
  AuthBackend, AuthOutcome, ChallengeOutcome, AuthInfoConfig,
} from '../auth-backend.js';

// ── Minimal mock auth backend ───────────────────────────────

/**
 * Mock auth backend that always succeeds for `open` and `pairing` and reports
 * an empty pendingMessages list (simulating a real edge where the remote
 * backend has no view into the edge's local pending queue).
 */
class MockAuthBackend implements AuthBackend {
  private static seq = 0;
  /** Override per call if needed (default: empty). */
  backendPendingMessages: UnicastEnvelope[] = [];
  /** User identity returned to the head. */
  user = {
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
      pendingMessages: this.backendPendingMessages,
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

describe('Edge-mode auth: local pending_messages flush on reconnect', () => {
  let env: EdgeTestEnv;
  beforeEach(async () => { env = await createEdgeTestEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it('delivers locally-queued pending messages alongside auth_ok', async () => {
    // Pre-condition: head has 3 pending unicasts queued locally for dev_t1.
    // (This is what happens when an arm sends a unicast to a tentacle that
    // happens to be offline. handleUnicast → storage.insertPending.)
    env.storage.insertPending('dev_t1', 'u_remote', JSON.stringify({
      type: 'unicast', to: 'dev_t1', blob: 'envelope_1', keys: { 'dev_t1': 'k' },
    }));
    env.storage.insertPending('dev_t1', 'u_remote', JSON.stringify({
      type: 'unicast', to: 'dev_t1', blob: 'envelope_2', keys: { 'dev_t1': 'k' },
    }));
    env.storage.insertPending('dev_t1', 'u_remote', JSON.stringify({
      type: 'unicast', to: 'dev_t1', blob: 'envelope_3', keys: { 'dev_t1': 'k' },
    }));

    const { authOk } = await connectEdge(env.port, 'dev_t1');

    expect(authOk.pendingMessages).toBeDefined();
    const pending = authOk.pendingMessages as UnicastEnvelope[];
    expect(pending).toHaveLength(3);
    expect(pending.map(p => p.blob)).toEqual(['envelope_1', 'envelope_2', 'envelope_3']);

    // Queue is now empty (flushPendingEnvelopes both reads AND deletes).
    expect(env.storage.flushPending('dev_t1')).toHaveLength(0);
  });

  it('merges backend-supplied and locally-queued pending messages', async () => {
    // Backend hands us one pending message…
    env.backend.backendPendingMessages = [{
      type: 'unicast', to: 'dev_t2', blob: 'from_backend', keys: { 'dev_t2': 'k' },
    }];
    // …and head has two queued locally.
    env.storage.insertPending('dev_t2', 'u_remote', JSON.stringify({
      type: 'unicast', to: 'dev_t2', blob: 'local_1', keys: { 'dev_t2': 'k' },
    }));
    env.storage.insertPending('dev_t2', 'u_remote', JSON.stringify({
      type: 'unicast', to: 'dev_t2', blob: 'local_2', keys: { 'dev_t2': 'k' },
    }));

    const { authOk } = await connectEdge(env.port, 'dev_t2');

    const pending = authOk.pendingMessages as UnicastEnvelope[];
    expect(pending).toHaveLength(3);
    // Backend's contribution comes first (preserving prior behavior),
    // then local entries.
    expect(pending[0].blob).toBe('from_backend');
    expect(pending.slice(1).map(p => p.blob).sort()).toEqual(['local_1', 'local_2']);
  });

  it('omits pendingMessages from auth_ok when both queues are empty', async () => {
    const { authOk } = await connectEdge(env.port, 'dev_t3');
    expect(authOk.pendingMessages).toBeUndefined();
  });
});

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
    // with no preferences set.
    const { authOk } = await connectEdge(env.port, 'dev_t5');
    const user = authOk.user as Record<string, unknown>;
    // preferences should be omitted/undefined, not crash.
    expect(user.preferences).toBeUndefined();
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
    expect(first.raw.find(m => m.type === 'device_joined')).toBeUndefined();

    // Second device connects — first should receive device_joined.
    await connectEdge(env.port, 'dev_second');
    // Allow time for the broadcast.
    await new Promise(r => setTimeout(r, 50));

    const joined = first.raw.find(m => m.type === 'device_joined');
    expect(joined).toBeDefined();
    expect((joined!.device as Record<string, unknown>).id).toBe('dev_second');
  });
});
