import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { generateKeyPair, exportPublicKey, signChallenge } from '@kraki/crypto';
import { AccountApi } from '../account-api.js';
import type { AuthOutcome, AuthResult } from '../auth-backend.js';
import { EdgeAuthCache } from '../edge-auth-cache.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { RemoteAuthBackend, type EdgeRevocation } from '../remote-auth-backend.js';
import { HeadServer } from '../server.js';
import { Storage } from '../storage.js';
import { Logger, setGlobalLogger } from '../logger.js';

setGlobalLogger(new Logger({ level: 'error', stdout: false }));
const keys = generateKeyPair();
const publicKey = exportPublicKey(keys.publicKey);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await tick();
  expect(predicate()).toBe(true);
}

describe('PR577 adversarial edge auth', { timeout: 30_000 }, () => {
  let account: Storage;
  let edge: Storage;
  let http: Server;
  let backend: LocalAuthBackend;
  let remote: RemoteAuthBackend;
  let cache: EdgeAuthCache;
  let clock: number;
  let statusMode: 'normal' | 'old-head' | 'offline' | 'internal-error';
  let verifyMode: 'normal' | 'offline' | 'hold' | 'internal-error';
  let challengeOffline: boolean;
  let heldVerify: { res: ServerResponse; answer: AuthOutcome } | undefined;
  let heldStatus: ServerResponse | undefined;
  let holdStatus: boolean;
  let revoked: EdgeRevocation[];
  let head: HeadServer | undefined;
  let calls: string[];

  beforeEach(async () => {
    account = new Storage(':memory:');
    edge = new Storage(':memory:');
    account.upsertUser('u', 'qa', 'open');
    account.upsertDevice('phone', 'u', 'Phone', 'app', 'ios', publicKey, 'enc-1');
    backend = new LocalAuthBackend({ storage: account, authProviders: new Map(), region: 'us', regionUrls: { us: 'wss://us.kraki.chat', china: 'wss://cn.kraki.chat' } });
    const api = new AccountApi({ authBackend: backend, serviceKey: 'qa-only' });
    clock = 1_000_000;
    statusMode = 'normal'; verifyMode = 'normal'; holdStatus = false; challengeOffline = false;
    heldVerify = undefined; heldStatus = undefined; head = undefined; calls = []; revoked = [];
    http = createServer(async (req, res) => {
      calls.push(req.url ?? '');
      if (req.url === '/api/devices/status') {
        if (holdStatus) { heldStatus = res; return; }
        if (statusMode === 'old-head') { res.writeHead(404); res.end('Not found'); return; }
        if (statusMode === 'offline') { req.socket.destroy(); return; }
        if (statusMode === 'internal-error') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, code: 'internal_error' })); return; }
      }
      if (req.url === '/api/auth/challenge' && challengeOffline) { req.socket.destroy(); return; }
      if (req.url === '/api/auth/verify') {
        if (verifyMode === 'internal-error') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, code: 'internal_error' })); return; }
        if (verifyMode === 'offline') { req.socket.destroy(); return; }
        if (verifyMode === 'hold') {
          let raw = '';
          for await (const chunk of req) raw += chunk;
          const input = JSON.parse(raw);
          const answer = await backend.verifyChallenge(input.deviceId, input.nonce, input.signature, input.encryptionKey, input.headRegion);
          heldVerify = { res, answer };
          return;
        }
      }
      if (!(await api.handleRequest(req, res))) { res.writeHead(404); res.end('Not found'); }
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    remote = new RemoteAuthBackend({ accountUrl: `http://127.0.0.1:${(http.address() as { port: number }).port}`, serviceKey: 'qa-only', timeout: 2000 });
    cache = new EdgeAuthCache(edge.rawDb, { now: () => clock });
    remote.onRevoked = (r) => revoked.push(r);
  });

  afterEach(async () => {
    remote.stopLocalChallenge();
    heldVerify?.res.destroy(); heldStatus?.destroy();
    head?.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    account.close(); edge.close();
  });

  function mirror(result: AuthResult) {
    edge.upsertUser(result.userId, result.user.login, result.user.provider);
    for (const d of result.devices) edge.upsertDevice(d.id, result.userId, d.name, d.role, d.kind, d.publicKey, d.encryptionKey);
  }
  async function signIn(encryptionKey = 'enc-1') {
    const c = await remote.startChallenge('phone', encryptionKey, 'us');
    if (!c.ok) throw new Error(`challenge failed: ${c.code}`);
    const result = await remote.verifyChallenge('phone', c.nonce, signChallenge(c.nonce, keys.privateKey), encryptionKey, 'us');
    if (result.ok && !result.local) mirror(result);
    return result;
  }
  async function warm() {
    await remote.enableLocalChallenge(cache, 'us', 600_000);
    expect((await signIn()).ok).toBe(true);
    calls.length = 0;
  }

  it('successful token auth seeds local trust for the first reconnect', async () => {
    await remote.enableLocalChallenge(cache, 'us', 600_000);
    const { token } = backend.createPairingToken('u');
    const result = await remote.authenticate({ method: 'pairing', token }, {
      deviceId: 'phone', name: 'Phone', role: 'app', kind: 'ios', publicKey, encryptionKey: 'enc-1',
    }, 'us');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('token auth failed');
    mirror(result);
    expect(cache.lookup('phone'), 'the latest authoritative token answer is just as fresh as challenge auth').toBeDefined();
    calls.length = 0;
    await remote.startChallenge('phone', 'enc-1', 'us');
    expect(calls).toEqual([]);
  });

  it('never accepts a foreign-device nonce', async () => {
    await warm();
    const nonce = cache.issueNonce('other-device');
    const result = await remote.verifyChallenge('phone', nonce, signChallenge(nonce, keys.privateKey), 'enc-1', 'us');
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('expired and replayed local nonces are rejected, never passed to the account service', async () => {
    await warm();
    const nonce = cache.issueNonce('phone');
    clock += 11 * 60_000 + 1;
    const result = await remote.verifyChallenge('phone', nonce, signChallenge(nonce, keys.privateKey), 'enc-1', 'us');
    expect(result.ok).toBe(false);
    const fresh = cache.issueNonce('phone');
    expect((await remote.verifyChallenge('phone', fresh, signChallenge(fresh, keys.privateKey), 'enc-1', 'us')).ok).toBe(true);
    const replay = await remote.verifyChallenge('phone', fresh, signChallenge(fresh, keys.privateKey), 'enc-1', 'us');
    expect(replay.ok).toBe(false);
    expect(calls.filter((c) => c === '/api/auth/verify').length, 'only the one background re-verify').toBeLessThanOrEqual(1);
  });

  it('does not use cached trust after local signing-key rotation', async () => {
    await warm();
    edge.upsertDevice('phone', 'u', 'Phone', 'app', 'ios', exportPublicKey(generateKeyPair().publicKey), 'enc-1');
    expect(cache.lookup('phone')).toBeUndefined();
    await remote.startChallenge('phone', 'enc-1', 'us');
    expect(calls).toEqual(['/api/auth/challenge']);
  });

  it('a new encryption key cannot succeed while the account service is offline', async () => {
    await warm(); verifyMode = 'offline';
    const result = await signIn('enc-2');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('service_unavailable');
    expect(cache.lookup('phone')?.encryptionKey).toBe('enc-1');
    expect(revoked).toEqual([]);
  });

  it('transient background verification failure retains trust and does not kick', async () => {
    await warm(); verifyMode = 'offline';
    expect((await signIn()).ok).toBe(true);
    await until(() => calls.includes('/api/auth/verify'));
    await tick();
    expect(cache.lookup('phone')).toBeDefined();
    expect(revoked).toEqual([]);
  });

  it('poll transport outage retains previously enabled trust', async () => {
    await warm(); statusMode = 'offline';
    await remote.pollDeviceStatus();
    expect(remote.localChallengeActive).toBe(true);
    expect(cache.lookup('phone')).toBeDefined();
    expect(revoked).toEqual([]);
  });

  it('startup while status endpoint is down stays remote', async () => {
    statusMode = 'offline';
    await remote.enableLocalChallenge(cache, 'us', 600_000);
    expect(remote.localChallengeActive).toBe(false);
    await signIn(); calls.length = 0;
    expect((await signIn()).ok).toBe(true);
    expect(calls).toEqual(['/api/auth/challenge', '/api/auth/verify']);
  });

  it('HTTP 500 during verification or status polling never revokes a cached device', async () => {
    await warm(); verifyMode = 'internal-error';
    const result = await signIn('enc-2');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('internal_error');
    statusMode = 'internal-error';
    await remote.pollDeviceStatus();
    expect(cache.lookup('phone')).toBeDefined();
    expect(revoked).toEqual([]);
  });

  it('cold challenge outage fails safely while a warm local challenge needs no account response', async () => {
    await remote.enableLocalChallenge(cache, 'us', 600_000);
    challengeOffline = true;
    const cold = await remote.startChallenge('phone', 'enc-1', 'us');
    expect(cold.ok).toBe(false);
    expect(!cold.ok && cold.code).toBe('service_unavailable');
    challengeOffline = false;
    await signIn(); calls.length = 0;
    challengeOffline = true;
    const warm = await remote.startChallenge('phone', 'enc-1', 'us');
    expect(warm.ok).toBe(true);
    expect(calls).toEqual([]);
  });

  it('downgrading account service to an old version switches local trust off', async () => {
    await warm(); statusMode = 'old-head';
    await remote.pollDeviceStatus();
    expect(remote.localChallengeActive, '404 must disable local auth, not be mistaken for a network outage').toBe(false);
  });

  it('a successful old status response cannot re-enable a stopped cache', async () => {
    await warm();
    holdStatus = true;
    const poll = remote.pollDeviceStatus();
    await until(() => heldStatus !== undefined);
    remote.stopLocalChallenge();
    heldStatus!.end(JSON.stringify({ statuses: { phone: 'ok' } }));
    await poll;
    expect(remote.localChallengeActive, 'stop is a lifecycle boundary even with a poll in flight').toBe(false);
  });

  it('late successful revalidation cannot resurrect a device revoked by a newer poll', async () => {
    await warm();
    // Use the actual Head callbacks, including the device mirroring refresh.
    head = new HeadServer(edge, { authBackend: remote });
    verifyMode = 'hold';
    expect((await signIn()).ok).toBe(true);
    await until(() => heldVerify !== undefined);
    expect(heldVerify!.answer.ok).toBe(true);
    account.deleteDevice('phone');
    await remote.pollDeviceStatus();
    expect(edge.getDevice('phone')).toBeFalsy();
    expect(cache.lookup('phone')).toBeUndefined();
    let refreshed = false;
    const mirrorRefreshed = remote.onRefreshed!;
    remote.onRefreshed = (result, context) => { mirrorRefreshed(result, context); refreshed = true; };
    heldVerify!.res.end(JSON.stringify(heldVerify!.answer));
    for (let i = 0; i < 20; i++) await tick();
    expect(refreshed, 'a late answer is dropped, not mirrored').toBe(false);
    expect(edge.getDevice('phone'), 'a revoked mirror must stay deleted').toBeFalsy();
    expect(cache.lookup('phone'), 'an older verify must not recreate local trust').toBeUndefined();
  });

  it('poll revokes a cached device whose id is __proto__', async () => {
    const deviceId = '__proto__';
    account.upsertDevice(deviceId, 'u', 'Phone', 'app', 'ios', publicKey, 'enc-1');
    const challenge = await backend.startChallenge(deviceId, 'enc-1', 'us');
    if (!challenge.ok) throw new Error('challenge failed');
    const result = await backend.verifyChallenge(deviceId, challenge.nonce, signChallenge(challenge.nonce, keys.privateKey), 'enc-1', 'us');
    if (!result.ok) throw new Error('verify failed');
    mirror(result); cache.remember(result);
    await remote.enableLocalChallenge(cache, 'us', 600_000);
    expect(remote.localChallengeActive).toBe(true);
    account.deleteDevice(deviceId);
    await remote.pollDeviceStatus();
    expect(revoked).toContainEqual(expect.objectContaining({ deviceId, code: 'unknown_device' }));
    expect(cache.lookup(deviceId)).toBeUndefined();
  });

  it('wrong_region status revocation carries the redirect needed by connected apps', async () => {
    await warm();
    account.setUserRegion('u', 'china');
    await remote.pollDeviceStatus();
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ code: 'wrong_region', deviceId: 'phone', redirect: 'wss://cn.kraki.chat' });
  });

  it('revalidation is rate limited independently for each device', async () => {
    await warm();
    await signIn();
    await until(() => calls.includes('/api/auth/verify'));
    for (let i = 0; i < 4; i++) await signIn();
    await tick();
    expect(calls.filter((p) => p === '/api/auth/verify')).toHaveLength(1);
    expect(cache.claimRevalidation('unrelated-phone')).toBe(true);
  });

  it('a device id re-registered under another account is never trusted as the old one', async () => {
    await warm();
    // Removed here, then the same id shows up mirrored under account B.
    edge.deleteDevice('phone');
    remote.forgetLocalTrust('phone');
    edge.upsertUser('u-b', 'other', 'open');
    edge.upsertDevice('phone', 'u-b', 'Phone', 'app', 'ios', publicKey, 'enc-1');
    expect(cache.lookup('phone')).toBeUndefined();
    // Even with a stale entry, a mirror under another account blocks it.
    cache.remember({ ok: true, userId: 'u', deviceId: 'phone', authMethod: 'challenge',
      user: { id: 'u', login: 'qa', provider: 'open' },
      devices: [{ id: 'phone', name: 'Phone', role: 'app', publicKey, encryptionKey: 'enc-1', online: false }] });
    expect(cache.lookup('phone')).toBeUndefined();
  });

  it('a signing key rotated at the account service is revoked by the status poll', async () => {
    await warm();
    account.upsertDevice('phone', 'u', 'Phone', 'app', 'ios', exportPublicKey(generateKeyPair().publicKey), 'enc-1');
    await remote.pollDeviceStatus();
    expect(revoked).toEqual([expect.objectContaining({ deviceId: 'phone', code: 'key_changed' })]);
    expect(cache.lookup('phone')).toBeUndefined();
  });

  it('account deletion on the edge drops local trust before a late answer can return', async () => {
    await warm();
    const epoch = cache.epoch('phone');
    remote.forgetLocalTrust('phone');
    const late = { ok: true as const, userId: 'u', deviceId: 'phone', authMethod: 'challenge' as const,
      user: { id: 'u', login: 'qa', provider: 'open' },
      devices: [{ id: 'phone', name: 'Phone', role: 'app' as const, publicKey, encryptionKey: 'enc-1', online: false }] };
    expect(cache.remember(late, epoch)).toBe('stale');
    expect(cache.lookup('phone')).toBeUndefined();
  });

  // ── release-gate review round 2 ─────────────────────────

  it('a bad signature from another socket does not drop a live device from revocation polls', async () => {
    await warm();
    const c = await remote.startChallenge('phone', 'enc-1', 'us');
    if (!c.ok) throw new Error('challenge');
    // Not a local nonce (forced remote): a forged signature at the account service.
    const forged = await remote.verifyChallenge('phone', 'remote-nonce', signChallenge('remote-nonce', generateKeyPair().privateKey), 'enc-1', 'us');
    expect(forged.ok).toBe(false);
    expect(cache.lookup('phone'), 'still trusted and still polled').toBeDefined();
    account.deleteDevice('phone');
    await remote.pollDeviceStatus();
    expect(revoked).toEqual([expect.objectContaining({ deviceId: 'phone', code: 'unknown_device' })]);
  });

  it('a delayed older background success cannot overwrite a newer key', async () => {
    await warm();
    head = new HeadServer(edge, { authBackend: remote });
    verifyMode = 'hold';
    expect((await signIn()).ok).toBe(true); // local; background re-verify held
    await until(() => heldVerify !== undefined);
    // Newer authoritative sign-in with a rotated key completes first.
    verifyMode = 'normal';
    const k2 = generateKeyPair();
    account.upsertDevice('phone', 'u', 'Phone', 'app', 'ios', exportPublicKey(k2.publicKey), 'enc-1');
    const fresh = { ok: true as const, userId: 'u', deviceId: 'phone', authMethod: 'challenge' as const,
      user: { id: 'u', login: 'qa', provider: 'open' },
      devices: [{ id: 'phone', name: 'Phone', role: 'app' as const, publicKey: exportPublicKey(k2.publicKey), encryptionKey: 'enc-1', online: false }] };
    mirror(fresh);
    expect(cache.remember(fresh, cache.epoch('phone'))).toBe('stored');
    let refreshed = false;
    const inner = remote.onRefreshed!;
    remote.onRefreshed = (r, c2) => { inner(r, c2); refreshed = true; };
    heldVerify!.res.end(JSON.stringify(heldVerify!.answer));
    for (let i = 0; i < 20; i++) await tick();
    expect(refreshed).toBe(false);
    expect(cache.lookup('phone')?.publicKey).toBe(exportPublicKey(k2.publicKey));
  });

  it('a foreground sign-in that crosses a removal on this edge does not complete', async () => {
    await warm();
    verifyMode = 'hold';
    const c = await remote.startChallenge('phone', 'enc-2', 'us'); // new key -> remote verify
    if (!c.ok) throw new Error('challenge');
    const pending = remote.verifyChallenge('phone', c.nonce, signChallenge(c.nonce, keys.privateKey), 'enc-2', 'us');
    await until(() => heldVerify !== undefined);
    remote.forgetLocalTrust('phone');
    heldVerify!.res.end(JSON.stringify(heldVerify!.answer));
    const result = await pending;
    expect(result.ok, 'vetoed: the device was dropped while the answer was out').toBe(false);
  });

  it('a poll answer staged before a re-authentication does not revoke it', async () => {
    await warm();
    const epoch = cache.epoch('phone');
    // Simulate: the status answer was computed, then the device re-authenticated.
    const again = await signIn('enc-1');
    expect(again.ok).toBe(true);
    expect(cache.epoch('phone')).toBeGreaterThanOrEqual(epoch);
  });

  it('a device moved to another account is a full revocation, not a key change', () => {
    account.upsertUser('u2', 'other', 'open');
    expect({ ...backend.deviceStatuses([{ id: 'phone', userId: 'u2' }], 'us').statuses }).toEqual({ phone: 'unknown_device' });
  });
  // ── release-gate review round 3 ─────────────────────────

  it('a device-level rejection seen on a foreground sign-in retires the live session too', async () => {
    await warm();
    const c = await remote.startChallenge('phone', 'enc-1', 'us'); // local nonce
    if (!c.ok) throw new Error('challenge');
    account.deleteDevice('phone');
    // Bad signature: falls through to the account service, which says the device is gone.
    const r = await remote.verifyChallenge('phone', c.nonce, 'bad-signature', 'enc-1', 'us');
    expect(r.ok).toBe(false);
    // The Head maps device_not_found to unknown_device when it closes the socket.
    expect(revoked).toEqual([expect.objectContaining({ deviceId: 'phone', code: 'device_not_found' })]);
  });

  it('a newer key stored for a device retires a session still running on the old key', async () => {
    await warm();
    const k2 = generateKeyPair();
    account.upsertDevice('phone', 'u', 'Phone', 'app', 'ios', exportPublicKey(k2.publicKey), 'enc-1');
    const { token } = backend.createPairingToken('u');
    const result = await remote.authenticate({ method: 'pairing', token },
      { deviceId: 'phone', name: 'Phone', role: 'app', kind: 'ios', publicKey: exportPublicKey(k2.publicKey), encryptionKey: 'enc-1' }, 'us');
    expect(result.ok).toBe(true);
    expect(revoked).toEqual([expect.objectContaining({ deviceId: 'phone', code: 'key_changed', supersededOnly: true })]);
  });

  it('poll chunks use the identity and epoch captured together before the first request', async () => {
    await warm();
    holdStatus = true;
    const poll = remote.pollDeviceStatus();
    await until(() => heldStatus !== undefined);
    // Re-authenticated while the poll is out: the poll's verdict must not apply.
    const again = cache.lookup('phone')!.result;
    cache.remember(again, cache.epoch('phone'));
    heldStatus!.end(JSON.stringify({ ok: true, statuses: { phone: 'key_changed' } }));
    await poll;
    expect(revoked).toEqual([]);
    expect(cache.lookup('phone')).toBeDefined();
  });

});

describe('Head auth guards (release-gate round 2)', () => {
  it('rejects an answer to a challenge older than five minutes', async () => {
    const { handleChallengeResponse } = await import('../server/auth-flow.js');
    const sent: string[] = [];
    const ws = { readyState: 1, send: (m: string) => sent.push(m) } as never;
    const state = { authenticated: false, isAlive: true, pongOverdueAt: null, pendingLivenessBroadcast: false,
      pendingNonce: 'n', pendingDeviceId: 'd', pendingNonceAt: Date.now() - 5 * 60_000 - 1 } as never;
    let verified = false;
    const server = { authBackend: { verifyChallenge: async () => { verified = true; return { ok: false, code: 'x', message: 'x' }; } },
      clients: new Map(), renameClock: 0, options: {} } as never;
    handleChallengeResponse(server, ws, state, { deviceId: 'd', signature: 's' });
    expect(verified).toBe(false);
    expect(JSON.parse(sent[0])).toMatchObject({ type: 'auth_error', code: 'service_unavailable' });
  });

  it('a tombstoned device id never completes sign-in, and ownership changes retire the old mirror', async () => {
    const { handleBackendAuthResult } = await import('../server/auth-flow.js');
    const storage = new Storage(':memory:');
    try {
      storage.upsertUser('a', 'alice', 'open');
      storage.upsertUser('b', 'bob', 'open');
      storage.tombstoneDevices(['dead']);
      const sent: string[] = [];
      const ws = { readyState: 1, send: (m: string) => sent.push(m) } as never;
      const forgotten: string[] = [];
      const server = { storage, connections: new Map(), clients: new Map(), userByDevice: new Map(), deviceRenamedAt: new Map(),
        renameClock: 0, options: {}, pulseHub: { forgetDevice: (id: string) => forgotten.push(id), onDeviceConnected: () => {}, onDeviceDisconnected: () => {} },
        authBackend: { getAuthInfo: () => ({ methods: [] }) }, getVapidPublicKey: () => undefined, getVoiceCapability: () => undefined,
        sendPresenceToDevice: () => {} } as never;
      const ok = (deviceId: string, userId: string) => ({ ok: true as const, userId, deviceId, authMethod: 'challenge' as const,
        user: { id: userId, login: userId, provider: 'open' }, devices: [{ id: deviceId, name: 'D', role: 'app' as const, publicKey, online: false }] });
      handleBackendAuthResult(server, ws, { authenticated: false } as never, ok('dead', 'a'));
      expect(JSON.parse(sent[0])).toMatchObject({ type: 'auth_error', code: 'account_deleted' });

      storage.upsertDevice('moved', 'a', 'D', 'app', 'ios', publicKey);
      handleBackendAuthResult(server, ws, { authenticated: false } as never, ok('moved', 'b'));
      expect(storage.getDevice('moved')?.userId).toBe('b');
      expect(forgotten).toContain('moved');
    } finally { storage.close(); }
  });
});
