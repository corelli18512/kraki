import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { WebSocket } from 'ws';
import { generateKeyPair, exportPublicKey, signChallenge } from '@kraki/crypto';
import type { AuthResult } from '../auth-backend.js';
import { AccountApi } from '../account-api.js';
import { EdgeAuthCache } from '../edge-auth-cache.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { RemoteAuthBackend, type EdgeRevocation } from '../remote-auth-backend.js';
import { HeadServer } from '../server.js';
import { Storage } from '../storage.js';
import { Logger, setGlobalLogger } from '../logger.js';

setGlobalLogger(new Logger({ level: 'error', stdout: false }));
const keys = generateKeyPair();
const pub = exportPublicKey(keys.publicKey);
const sleep = () => new Promise<void>((r) => setTimeout(r, 10));
async function until(f: () => boolean) {
  for (let i = 0; i < 300 && !f(); i++) await sleep();
  expect(f()).toBe(true);
}

describe('PR577 round3 foreground and concurrent trust boundaries', () => {
  let account: Storage, edge: Storage, local: LocalAuthBackend, remote: RemoteAuthBackend, cache: EdgeAuthCache;
  let accountHttp: Server, edgeHttp: Server, head: HeadServer;
  let now: number;
  let hold: string | undefined;
  let held: Array<{ res: ServerResponse; result: unknown }>;
  let calls: string[];
  let statusUnsupported: boolean;
  let revocations: EdgeRevocation[];
  const sockets: WebSocket[] = [];
  const device = { deviceId: 'phone', name: 'Phone', role: 'app' as const, kind: 'ios' as const, publicKey: pub, encryptionKey: 'enc' };

  beforeEach(async () => {
    now = 1_000_000; held = []; calls = []; statusUnsupported = false; hold = undefined; revocations = [];
    account = new Storage(':memory:'); edge = new Storage(':memory:');
    account.upsertUser('u', 'qa', 'open');
    account.upsertDevice('phone', 'u', 'Phone', 'app', 'ios', pub, 'enc');
    local = new LocalAuthBackend({ storage: account, authProviders: new Map() });
    const api = new AccountApi({ authBackend: local, serviceKey: 'qa' });
    accountHttp = createServer(async (req, res) => {
      calls.push(req.url!);
      if (req.url === '/api/devices/status' && statusUnsupported) { res.writeHead(404); res.end('old account'); return; }
      if (req.url === hold) {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        let result: unknown;
        if (req.url === '/api/auth/verify') result = await local.verifyChallenge(body.deviceId, body.nonce, body.signature, body.encryptionKey);
        else if (req.url === '/api/auth') result = await local.authenticate(body.auth, body.device);
        else result = { ok: true, ...local.deviceStatuses(body.devices, body.headRegion) };
        held.push({ res, result }); return;
      }
      if (!await api.handleRequest(req, res)) { res.writeHead(404); res.end('not found'); }
    });
    await new Promise<void>((r) => accountHttp.listen(0, '127.0.0.1', r));
    remote = new RemoteAuthBackend({ accountUrl: `http://127.0.0.1:${(accountHttp.address() as { port: number }).port}`, serviceKey: 'qa', timeout: 10_000 });
    cache = new EdgeAuthCache(edge.rawDb, { now: () => now });
    head = new HeadServer(edge, { authBackend: remote });
    const revoke = remote.onRevoked!;
    remote.onRevoked = (r) => { revocations.push(r); revoke(r); };
    edgeHttp = createServer(); head.attach(edgeHttp);
    await new Promise<void>((r) => edgeHttp.listen(0, '127.0.0.1', r));
    await remote.enableLocalChallenge(cache, undefined, 600_000);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    remote.stopLocalChallenge();
    for (const s of sockets.splice(0)) s.terminate();
    for (const h of held) h.res.destroy();
    head.close(); accountHttp.closeAllConnections(); edgeHttp.closeAllConnections();
    await Promise.all([new Promise<void>((r) => accountHttp.close(() => r())), new Promise<void>((r) => edgeHttp.close(() => r()))]);
    account.close(); edge.close();
  });
  function mirror(result: AuthResult) {
    edge.upsertUser(result.userId, result.user.login, result.user.provider);
    for (const d of result.devices) {
      // What the Head does (retireForeignMirror): another account's old copy goes first.
      if (edge.getDevice(d.id) && edge.getDevice(d.id)!.userId !== result.userId) edge.deleteDevice(d.id);
      edge.upsertDevice(d.id, result.userId, d.name, d.role, d.kind, d.publicKey, d.encryptionKey);
    }
  }
  async function seed() {
    const result = await local.verifyChallenge('phone', 'seed', signChallenge('seed', keys.privateKey), 'enc');
    if (!result.ok) throw new Error('seed failed');
    mirror(result); cache.remember(result); return result;
  }
  function release(index = 0) {
    const { res, result } = held[index]; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  }
  async function connect(auth: Record<string, unknown>, encryptionKey = 'enc', autoSign = true, assigned = false) {
    const ws = new WebSocket(`ws://127.0.0.1:${(edgeHttp.address() as { port: number }).port}`); sockets.push(ws);
    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()); messages.push(m);
      if (autoSign && m.type === 'auth_challenge') ws.send(JSON.stringify({ type: 'auth_response', signature: signChallenge(m.nonce, keys.privateKey) }));
    });
    await new Promise<void>((r, reject) => { ws.once('open', r); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'auth', auth, device: { ...device, ...(assigned && { deviceId: undefined }), encryptionKey } }));
    return { ws, messages };
  }

  it.each(['verify', 'token'])('a newer token remember fences an older successful %s even with unchanged identity', async (kind) => {
    await seed(); const epoch = cache.epoch('phone');
    hold = kind === 'verify' ? '/api/auth/verify' : '/api/auth';
    const pending = kind === 'verify'
      ? remote.verifyChallenge('phone', 'remote-nonce', signChallenge('remote-nonce', keys.privateKey), 'enc')
      : remote.authenticate({ method: 'pairing', token: local.createPairingToken('u').token }, device);
    await until(() => held.length === 1); hold = undefined;
    const fresh = await remote.authenticate({ method: 'pairing', token: local.createPairingToken('u').token }, device);
    expect(fresh.ok).toBe(true); expect(cache.epoch('phone')).toBeGreaterThan(epoch);
    const updated = cache.epoch('phone'); release();
    expect(await pending).toMatchObject({ ok: false, code: 'service_unavailable' });
    expect(cache.epoch('phone')).toBe(updated); expect(cache.lookup('phone')).toBeDefined();
  });

  it('a delayed old background key success cannot overwrite a newer authoritative key', async () => {
    await seed(); hold = '/api/auth/verify'; const refreshed = vi.fn(); remote.onRefreshed = refreshed;
    const n = cache.issueNonce('phone');
    expect((await remote.verifyChallenge('phone', n, signChallenge(n, keys.privateKey), 'enc')).ok).toBe(true);
    await until(() => held.length === 1);
    const rotated = exportPublicKey(generateKeyPair().publicKey);
    const fresh = await remote.authenticate({ method: 'pairing', token: local.createPairingToken('u').token }, { ...device, publicKey: rotated });
    if (!fresh.ok) throw new Error('pairing failed'); mirror(fresh);
    release(); await sleep(); await sleep();
    expect(cache.lookup('phone')?.publicKey).toBe(rotated); expect(edge.getDevice('phone')?.publicKey).toBe(rotated);
    expect(refreshed).not.toHaveBeenCalled();
  });

  it('a stale foreground device rejection cannot remove a newer live sign-in from polling', async () => {
    await seed(); account.deleteDevice('phone'); hold = '/api/auth/verify';
    const old = remote.verifyChallenge('phone', 'remote-nonce', signChallenge('remote-nonce', keys.privateKey), 'enc');
    await until(() => held.length === 1);
    expect(held[0].result).toMatchObject({ ok: false, code: 'device_not_found' });
    const current = await connect({ method: 'pairing', token: local.createPairingToken('u').token });
    await until(() => current.messages.some((m) => m.type === 'auth_ok'));
    const epoch = cache.epoch('phone'); expect(cache.lookup('phone')).toBeDefined();
    release(); await old;
    expect.soft(cache.epoch('phone'), 'a pre-enrollment rejection must not change the newer trust epoch').toBe(epoch);
    expect.soft(cache.lookup('phone'), 'live replacement must remain covered by periodic revocation').toBeDefined();
    account.deleteDevice('phone'); await remote.pollDeviceStatus();
    expect(revocations).toContainEqual(expect.objectContaining({ deviceId: 'phone' }));
  });

  it('invalid_signature from another socket preserves live trust and subsequent removal is polled', async () => {
    await seed(); cache.claimRevalidation('phone');
    const current = await connect({ method: 'challenge', deviceId: 'phone' });
    await until(() => current.messages.some((m) => m.type === 'auth_ok'));
    const nonce = cache.issueNonce('phone');
    const invalid = await remote.verifyChallenge('phone', nonce, 'not-a-signature', 'enc');
    expect(invalid).toMatchObject({ ok: false, code: 'invalid_signature' });
    expect(cache.lookup('phone')).toBeDefined();
    account.deleteDevice('phone'); await remote.pollDeviceStatus();
    expect(revocations).toContainEqual(expect.objectContaining({ deviceId: 'phone' }));
    await until(() => current.ws.readyState === WebSocket.CLOSED);
  });

  it.each(['challenge', 'pairing'])('foreground %s epoch veto is retryable and a fresh attempt succeeds', async (method) => {
    await seed(); hold = method === 'challenge' ? '/api/auth/verify' : '/api/auth';
    const auth = () => method === 'challenge' ? { method, deviceId: 'phone' } : { method, token: local.createPairingToken('u').token };
    const old = await connect(auth(), 'enc-new'); await until(() => held.length === 1);
    remote.forgetLocalTrust('phone'); release();
    await until(() => old.messages.some((m) => m.type === 'auth_error'));
    expect(old.messages.find((m) => m.type === 'auth_error')).toMatchObject({ code: 'service_unavailable' });
    expect(old.messages.some((m) => m.type === 'auth_ok')).toBe(false);
    hold = undefined; const retry = await connect(auth(), 'enc-new');
    await until(() => retry.messages.some((m) => m.type === 'auth_ok'));
    expect(edge.getDevice('phone')?.userId).toBe('u');
  });

  it('account deletion tombstones a held server-assigned first-pairing id before it is mirrored', async () => {
    await seed(); cache.claimRevalidation('phone');
    const admin = await connect({ method: 'challenge', deviceId: 'phone' });
    await until(() => admin.messages.some((m) => m.type === 'auth_ok'));
    hold = '/api/auth';
    const first = await connect({ method: 'pairing', token: local.createPairingToken('u').token }, 'enc', true, true);
    await until(() => held.length === 1);
    const assigned = (held[0].result as AuthResult).deviceId;
    expect(assigned).not.toBe('phone'); expect(edge.getDevice(assigned)).toBeUndefined();
    admin.ws.send(JSON.stringify({ type: 'delete_account' }));
    await until(() => admin.messages.some((m) => m.type === 'account_deleted'));
    expect(edge.isDeletedDevice(assigned)).toBe(true); release();
    await until(() => first.messages.some((m) => m.type === 'auth_ok' || m.type === 'auth_error'));
    expect(first.messages.find((m) => m.type === 'auth_error')).toMatchObject({ code: 'account_deleted' });
    expect(first.messages.some((m) => m.type === 'auth_ok')).toBe(false);
    expect(edge.getDevice(assigned)).toBeUndefined(); expect(edge.getUser('u')).toBeUndefined();
    expect(cache.lookup(assigned)).toBeUndefined();
  });

  it('foreign mirror retirement terminates the live old owner and removes push and Pulse state before auth_ok', async () => {
    await seed(); cache.claimRevalidation('phone');
    const old = await connect({ method: 'challenge', deviceId: 'phone' });
    await until(() => old.messages.some((m) => m.type === 'auth_ok'));
    const oldServerSocket = head.connections.get('phone');
    edge.upsertPushToken('phone', 'apns', 'throwaway-push', 'sandbox');
    head.deviceRenamedAt.set('phone', 42);
    const forget = vi.spyOn(head.pulseHub, 'forgetDevice');
    account.deleteDevice('phone'); account.upsertUser('other', 'other', 'open');
    const replacement = await connect({ method: 'pairing', token: local.createPairingToken('other').token });
    await until(() => replacement.messages.some((m) => m.type === 'auth_ok'));
    await until(() => old.ws.readyState === WebSocket.CLOSED);
    expect(head.clients.has(oldServerSocket!)).toBe(false);
    expect(head.userByDevice.get('phone')).toBe('other'); expect(edge.getDevice('phone')?.userId).toBe('other');
    expect(edge.rawDb.prepare('SELECT * FROM push_tokens WHERE device_id = ?').all('phone')).toEqual([]);
    expect(head.deviceRenamedAt.has('phone')).toBe(false); expect(forget).toHaveBeenCalledWith('phone');
    // Delayed close cleanup must not erase the replacement connection.
    await sleep(); expect(head.connections.has('phone')).toBe(true);
  });

  it.each([false, true])('socket enforces five-minute challenge TTL after repeated login auth_info (local=%s)', async (localNonce) => {
    await seed(); cache.claimRevalidation('phone');
    if (!localNonce) { statusUnsupported = true; await remote.pollDeviceStatus(); }
    const client = await connect({ method: 'challenge', deviceId: 'phone' }, 'enc', false);
    await until(() => client.messages.some((m) => m.type === 'auth_challenge'));
    const nonce = client.messages.find((m) => m.type === 'auth_challenge')!.nonce as string;
    const realNow = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(realNow + 300_001);
    client.ws.send(JSON.stringify({ type: 'auth_info' }));
    await until(() => client.messages.some((m) => m.type === 'auth_info_response'));
    calls.length = 0;
    client.ws.send(JSON.stringify({ type: 'auth_response', signature: signChallenge(nonce, keys.privateKey) }));
    await until(() => client.messages.some((m) => m.type === 'auth_error'));
    expect(client.messages.find((m) => m.type === 'auth_error')).toMatchObject({ code: 'service_unavailable' });
    expect(client.messages.some((m) => m.type === 'auth_ok')).toBe(false); expect(calls).not.toContain('/api/auth/verify');
    // The expired attempt cleared this socket's challenge; retrying uses a new one.
    vi.restoreAllMocks(); const count = client.messages.filter((m) => m.type === 'auth_challenge').length;
    client.ws.send(JSON.stringify({ type: 'auth', auth: { method: 'challenge', deviceId: 'phone' }, device }));
    await until(() => client.messages.filter((m) => m.type === 'auth_challenge').length > count);
    const fresh = client.messages.filter((m) => m.type === 'auth_challenge').at(-1)!.nonce as string;
    client.ws.send(JSON.stringify({ type: 'auth_response', signature: signChallenge(fresh, keys.privateKey) }));
    await until(() => client.messages.some((m) => m.type === 'auth_ok'));
  });
});

describe('release-gate round 4: hard revocation retires Pulse state at once', () => {
  it('a device revoked while its old socket is still closing does not hand its state to a re-enrolment', async () => {
    const { HeadServer } = await import('../server.js');
    const { Storage } = await import('../storage.js');
    const storage = new Storage(':memory:');
    const server = new HeadServer(storage, {});
    try {
      storage.upsertUser('a', 'alice', 'open');
      storage.upsertDevice('d', 'a', 'D', 'app', 'ios', 'pk');
      const forgotten: string[] = [];
      const realForget = server.pulseHub.forgetDevice.bind(server.pulseHub);
      server.pulseHub.forgetDevice = (id: string) => { forgotten.push(id); realForget(id); };
      // An old socket whose close never completes (held).
      const sent: string[] = [];
      const ws = { readyState: 1, send: (m: string) => sent.push(m), close: () => {}, terminate: () => {}, once: () => {} } as never;
      server.connections.set('d', ws);
      server.userByDevice.set('d', 'a');
      server.clients.set(ws, { deviceId: 'd', userId: 'a', authenticated: true, isAlive: true, pongOverdueAt: null, pendingLivenessBroadcast: false } as never);
      server.revokeDevice({ deviceId: 'd', code: 'device_not_found', message: 'gone' });
      expect(forgotten, 'Pulse state is retired before the close completes').toEqual(['d']);
      expect(server.connections.has('d')).toBe(false);
      expect(server.clients.has(ws)).toBe(false);
      expect(storage.getDevice('d')).toBeFalsy();
      expect(JSON.parse(sent[0])).toMatchObject({ type: 'auth_error', code: 'unknown_device' });
    } finally { server.close(); storage.close(); }
  });
});
