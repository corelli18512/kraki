import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('PR577 round2 trust epochs and nonce provenance', () => {
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
  /** A challenge nonce issued by the account service itself (it only
   *  verifies answers to nonces it issued). */
  async function accountNonce() {
    const c = await local.startChallenge('phone');
    if (!c.ok) throw new Error('account challenge failed');
    return c.nonce;
  }
  async function seed() {
    const nonce = await accountNonce();
    const result = await local.verifyChallenge('phone', nonce, signChallenge(nonce, keys.privateKey), 'enc');
    if (!result.ok) throw new Error('seed failed');
    mirror(result); cache.remember(result); return result;
  }
  function release(index = 0) {
    const { res, result } = held[index]; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  }
  async function connect(auth: Record<string, unknown>, encryptionKey = 'enc') {
    const ws = new WebSocket(`ws://127.0.0.1:${(edgeHttp.address() as { port: number }).port}`); sockets.push(ws);
    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()); messages.push(m);
      if (m.type === 'auth_challenge') ws.send(JSON.stringify({ type: 'auth_response', signature: signChallenge(m.nonce, keys.privateKey) }));
    });
    await new Promise<void>((r, reject) => { ws.once('open', r); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'auth', auth, device: { ...device, encryptionKey } }));
    return { ws, messages };
  }

  it.each(['challenge', 'pairing'])('a delayed foreground %s success must not sign in or mirror after poll revocation', async (method) => {
    await seed();
    // A changed encryption key forces challenge verification through the account service.
    hold = method === 'challenge' ? '/api/auth/verify' : '/api/auth';
    const auth = method === 'challenge' ? { method, deviceId: 'phone' } : { method, token: local.createPairingToken('u').token };
    const client = await connect(auth, 'enc-new');
    await until(() => held.length === 1);
    account.deleteDevice('phone');
    await remote.pollDeviceStatus();
    expect(edge.getDevice('phone')).toBeUndefined();
    release();
    await until(() => client.messages.some((m) => m.type === 'auth_ok' || m.type === 'auth_error') || client.ws.readyState === WebSocket.CLOSED);
    expect.soft(client.messages.some((m) => m.type === 'auth_ok'), 'the still-open unauthenticated socket crossed a trust epoch').toBe(false);
    expect.soft(edge.getDevice('phone'), 'a rejected cache remember must also reject mirroring').toBeUndefined();
  });

  it('a stale challenge cannot overwrite a newer token sign-in under another account', async () => {
    await seed(); hold = '/api/auth/verify';
    const client = await connect({ method: 'challenge', deviceId: 'phone' }, 'enc-new');
    await until(() => held.length === 1);
    account.deleteDevice('phone'); account.upsertUser('other', 'other', 'open');
    const token = local.createPairingToken('other').token;
    const newer = await remote.authenticate({ method: 'pairing', token }, device);
    if (!newer.ok) throw new Error('new account pairing failed'); mirror(newer);
    expect(cache.lookup('phone')?.userId).toBe('other');
    release(); await until(() => client.messages.some((m) => m.type === 'auth_ok' || m.type === 'auth_error'));
    expect.soft(cache.lookup('phone')?.userId, 'latest authoritative account must win over an older verify response').toBe('other');
    expect.soft(edge.getDevice('phone')?.userId).toBe('other');
    expect(client.messages.some((m) => m.type === 'auth_ok')).toBe(false);
  });

  // The background re-check after a local accept is a status check of that
  // device (/api/devices/status); its late verdict, ok or not, belongs to the
  // old epoch and lifecycle.
  it.each(['ok', 'unknown_device'])('background status %s is fenced across forget and same-cache stop/enable', async (status) => {
    await seed(); hold = '/api/devices/status';
    const nonce = cache.issueNonce('phone');
    expect((await remote.verifyChallenge('phone', nonce, signChallenge(nonce, keys.privateKey), 'enc')).ok).toBe(true);
    await until(() => held.length === 1); hold = undefined;
    if (status !== 'ok') held[0].result = { ok: true, statuses: { phone: status } };
    remote.forgetLocalTrust('phone');
    remote.stopLocalChallenge(); await remote.enableLocalChallenge(cache, undefined, 600_000);
    release(); await sleep(); await sleep();
    expect(cache.deviceIds()).not.toContain('phone');
    expect(revocations).toEqual([]);
  });

  it('a pre-revocation poll cannot revoke a newly authenticated device after a later chunk awaits', async () => {
    const result = await seed();
    for (let i = 0; i < 300; i++) {
      const id = `filler-${i}`;
      cache.remember({ ...result, deviceId: id, devices: [{ ...result.devices[0], id }] });
      account.upsertDevice(id, 'u', id, 'app', 'ios', pub, 'enc');
    }
    account.deleteDevice('phone'); hold = '/api/devices/status';
    const polling = remote.pollDeviceStatus(); await until(() => held.length === 1); release(0);
    await until(() => held.length === 2);
    remote.forgetLocalTrust('phone');
    // Really re-register at the account service after the removal, rather
    // than injecting a fictitious fresh cache entry.
    const fresh = await remote.authenticate({ method: 'pairing', token: local.createPairingToken('u').token }, device);
    if (!fresh.ok) throw new Error('fresh pairing failed'); mirror(fresh);
    release(1); await polling;
    expect(cache.lookup('phone'), 'epoch must be checked at application, not just collection of each chunk').toBeDefined();
    expect(revocations).not.toContainEqual(expect.objectContaining({ deviceId: 'phone' }));
  });

  it('a held old-key status must not revoke trust just refreshed by token auth with the new key', async () => {
    await seed(); const rotated = exportPublicKey(generateKeyPair().publicKey);
    account.upsertDevice('phone', 'u', 'Phone', 'app', 'ios', rotated, 'enc');
    hold = '/api/devices/status'; const polling = remote.pollDeviceStatus(); await until(() => held.length === 1);
    const result = await remote.authenticate({ method: 'pairing', token: local.createPairingToken('u').token }, { ...device, publicKey: rotated });
    if (!result.ok) throw new Error('pairing failed'); mirror(result);
    release(); await polling;
    expect(cache.lookup('phone')?.publicKey).toBe(rotated);
    // Only the old-key session (if any) is retired; the device itself is not revoked.
    expect(revocations.filter((r) => !(r as { supersededOnly?: boolean }).supersededOnly)).toEqual([]);
  });

  it.each([[299_999, true], [300_000, true], [300_001, false], [660_001, false]])('nonce age %s ms has validity %s (5 minute TTL)', async (age, valid) => {
    await seed(); const nonce = cache.issueNonce('phone');
    now += age as number; cache.claimRevalidation('phone');
    const result = await remote.verifyChallenge('phone', nonce, signChallenge(nonce, keys.privateKey), 'enc');
    expect(result.ok).toBe(valid);
  });

  it('single-use rejection survives TTL cleanup, not only the retention window', async () => {
    await seed(); cache.claimRevalidation('phone');
    const nonce = cache.issueNonce('phone'); const sig = signChallenge(nonce, keys.privateKey);
    expect((await remote.verifyChallenge('phone', nonce, sig, 'enc')).ok).toBe(true);
    now += 22 * 60_000 + 1; cache.issueNonce('another-device'); calls.length = 0;
    const result = await remote.verifyChallenge('phone', nonce, sig, 'enc');
    expect(result.ok, 'a swept local nonce must not become a remote nonce').toBe(false);
    expect(calls).not.toContain('/api/auth/verify');
  });

  it('a used local nonce remains recognized when local auth is stopped', async () => {
    await seed(); cache.claimRevalidation('phone'); const nonce = cache.issueNonce('phone');
    expect((await remote.verifyChallenge('phone', nonce, signChallenge(nonce, keys.privateKey), 'enc')).ok).toBe(true);
    remote.stopLocalChallenge(); calls.length = 0;
    const result = await remote.verifyChallenge('phone', nonce, signChallenge(nonce, keys.privateKey), 'enc');
    expect(result.ok, 'disabling the fast path must not erase issued-nonce provenance').toBe(false);
    expect(calls).not.toContain('/api/auth/verify');
  });

  it('new edge with old account stays remote for BOTH challenge steps', async () => {
    await seed(); statusUnsupported = true; await remote.pollDeviceStatus(); calls.length = 0;
    const c = await remote.startChallenge('phone', 'enc'); if (!c.ok) throw new Error('challenge failed');
    const result = await remote.verifyChallenge('phone', c.nonce, signChallenge(c.nonce, keys.privateKey), 'enc');
    expect(result.ok && !result.local).toBe(true);
    expect(calls).toEqual(['/api/auth/challenge', '/api/auth/verify']);
  });

  it('old edge payloads and auth endpoints remain accepted by new account', async () => {
    const url = `http://127.0.0.1:${(accountHttp.address() as { port: number }).port}`;
    // origin/main edge has no status endpoint caller. Its existing challenge/verify format is unchanged.
    const c = await remote.startChallenge('phone', 'enc'); if (!c.ok) throw new Error('challenge failed');
    expect((await remote.verifyChallenge('phone', c.nonce, signChallenge(c.nonce, keys.privateKey), 'enc')).ok).toBe(true);
    const reply = await fetch(`${url}/api/devices/status`, { method: 'POST', headers: { Authorization: 'Bearer qa', 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceIds: ['phone', 'missing'] }) });
    const body = await reply.json() as { statuses: Record<string, string> };
    expect(body.statuses).toEqual({ phone: 'ok', missing: 'unknown_device' });
  });

  it('key_changed closes with retryable 1012 and no credential-destroying auth_error', async () => {
    await seed(); cache.claimRevalidation('phone');
    const client = await connect({ method: 'challenge', deviceId: 'phone' });
    await until(() => client.messages.some((m) => m.type === 'auth_ok'));
    const closed = new Promise<number>((r) => client.ws.once('close', r));
    account.upsertDevice('phone', 'u', 'Phone', 'app', 'ios', exportPublicKey(generateKeyPair().publicKey), 'enc');
    await remote.pollDeviceStatus(); expect(await closed).toBe(1012);
    expect(client.messages.filter((m) => m.type === 'auth_error')).toEqual([]);
    expect(edge.getDevice('phone')).toBeDefined();
    expect(cache.lookup('phone')).toBeUndefined();
  });
});
