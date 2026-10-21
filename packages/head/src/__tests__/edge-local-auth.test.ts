/**
 * Edge-local challenge auth (EdgeAuthCache): a device the account service
 * already verified signs in at the edge without a round trip; the account
 * service stays the authority (background re-verify + device status poll).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { generateKeyPair, exportPublicKey, signChallenge } from '@kraki/crypto';
import { Storage } from '../storage.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { RemoteAuthBackend, type EdgeRevocation } from '../remote-auth-backend.js';
import { AccountApi } from '../account-api.js';
import { EdgeAuthCache, keyFingerprint } from '../edge-auth-cache.js';
import type { AuthResult } from '../auth-backend.js';
import { Logger, setGlobalLogger } from '../logger.js';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import { HeadServer } from '../server.js';

setGlobalLogger(new Logger({ level: 'error', stdout: false }));

const SERVICE_KEY = 'edge-local-key';

describe('edge-local challenge auth', () => {
  let account: Storage;
  let edge: Storage;
  let server: Server;
  let calls: string[];
  let withStatusEndpoint: boolean;
  let remote: RemoteAuthBackend;
  let cache: EdgeAuthCache;
  let clock: number;
  let revoked: EdgeRevocation[];
  let refreshed: AuthResult[];
  const keys = generateKeyPair();

  beforeEach(async () => {
    account = new Storage(':memory:');
    edge = new Storage(':memory:');
    account.upsertUser('u1', 'alice', 'open');
    account.upsertDevice('phone', 'u1', 'iPhone', 'app', 'ios', exportPublicKey(keys.publicKey), 'enc-1');
    calls = [];
    withStatusEndpoint = true;
    const api = new AccountApi({ authBackend: new LocalAuthBackend({ storage: account, authProviders: new Map() }), serviceKey: SERVICE_KEY });
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      calls.push(req.url ?? '');
      if (!withStatusEndpoint && req.url === '/api/devices/status') { res.writeHead(404); res.end('Not found'); return; }
      if (!(await api.handleRequest(req, res))) { res.writeHead(404); res.end('Not found'); }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    remote = new RemoteAuthBackend({ accountUrl: `http://localhost:${port}`, serviceKey: SERVICE_KEY });
    clock = 1_000_000;
    cache = new EdgeAuthCache(edge.rawDb, { now: () => clock });
    revoked = [];
    refreshed = [];
    remote.onRevoked = (r) => revoked.push(r);
    remote.onRefreshed = (r) => refreshed.push(r);
  });

  afterEach(() => {
    remote.stopLocalChallenge();
    server.close();
    account.close();
    edge.close();
  });

  /** What the Head does with a successful remote result: mirror it. */
  function mirror(result: AuthResult) {
    edge.upsertUser(result.user.id, result.user.login, result.user.provider);
    for (const d of result.devices) edge.upsertDevice(d.id, result.userId, d.name, d.role, d.kind, d.publicKey, d.encryptionKey);
  }

  async function signIn(encryptionKey = 'enc-1') {
    const challenge = await remote.startChallenge('phone', encryptionKey);
    expect(challenge.ok).toBe(true);
    if (!challenge.ok) throw new Error('challenge failed');
    const result = await remote.verifyChallenge('phone', challenge.nonce, signChallenge(challenge.nonce, keys.privateKey), encryptionKey);
    if (result.ok && !result.local) mirror(result);
    return result;
  }

  const settle = () => new Promise((r) => setTimeout(r, 50));

  it('asks the account service once, then signs a known device in locally', async () => {
    await remote.enableLocalChallenge(cache, undefined, 60_000);
    expect(remote.localChallengeActive).toBe(true);

    const first = await signIn();
    expect(first.ok && first.local).toBeFalsy();
    expect(calls.filter((c) => c.startsWith('/api/auth/'))).toEqual(['/api/auth/challenge', '/api/auth/verify']);

    calls = [];
    const second = await signIn();
    expect(second.ok).toBe(true);
    expect(second.ok && second.local).toBe(true);
    expect(second.ok && second.deviceId).toBe('phone');
    expect(calls, 'nothing before auth_ok').toEqual([]);
    await settle();
    expect(calls, 'one background re-verify').toEqual(['/api/auth/verify']);
    expect(refreshed).toHaveLength(1);

    calls = [];
    await signIn();
    await settle();
    expect(calls, 're-verify is rate limited').toEqual([]);
  });

  it('a wrong signature never passes locally', async () => {
    await remote.enableLocalChallenge(cache, undefined, 60_000);
    await signIn();
    const challenge = await remote.startChallenge('phone', 'enc-1');
    if (!challenge.ok) throw new Error('challenge failed');
    const other = generateKeyPair();
    const result = await remote.verifyChallenge('phone', challenge.nonce, signChallenge(challenge.nonce, other.privateKey), 'enc-1');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('invalid_signature');
  });

  it('a nonce is single-use and bound to its device', async () => {
    await remote.enableLocalChallenge(cache, undefined, 60_000);
    await signIn();
    const challenge = await remote.startChallenge('phone', 'enc-1');
    if (!challenge.ok) throw new Error('challenge failed');
    const signature = signChallenge(challenge.nonce, keys.privateKey);
    expect((await remote.verifyChallenge('phone', challenge.nonce, signature, 'enc-1')).ok).toBe(true);
    calls = [];
    const replay = await remote.verifyChallenge('phone', challenge.nonce, signature, 'enc-1');
    expect(replay.ok, 'a replayed local nonce is rejected').toBe(false);
    expect(calls, 'and never handed to the account service').toEqual([]);
  });

  it('a new encryption key goes to the account service before auth_ok', async () => {
    await remote.enableLocalChallenge(cache, undefined, 60_000);
    await signIn();
    calls = [];
    const result = await signIn('enc-2');
    expect(result.ok && result.local).toBeFalsy();
    expect(calls).toEqual(['/api/auth/verify']);
    expect(account.getDevice('phone')?.encryptionKey).toBe('enc-2');
  });

  it('a device removed at the account service is revoked by the status poll', async () => {
    await remote.enableLocalChallenge(cache, undefined, 60_000);
    await signIn();
    account.deleteDevice('phone');
    await remote.pollDeviceStatus();
    expect(revoked).toEqual([expect.objectContaining({ deviceId: 'phone', code: 'unknown_device' })]);
    expect(cache.lookup('phone')).toBeUndefined();
    calls = [];
    const again = await remote.startChallenge('phone', 'enc-1');
    expect(again.ok).toBe(false);
    expect(calls).toEqual(['/api/auth/challenge']);
  });

  it('a revocation the poll has not seen yet is caught by the background re-verify', async () => {
    await remote.enableLocalChallenge(cache, undefined, 60_000);
    await signIn();
    account.deleteDevice('phone');
    clock += 120_000; // past the re-verify interval
    const local = await signIn();
    expect(local.ok && local.local).toBe(true);
    await settle();
    expect(revoked).toEqual([expect.objectContaining({ deviceId: 'phone', code: 'device_not_found' })]);
    expect(cache.lookup('phone')).toBeUndefined();
  });

  it('stays remote with an account service that cannot report revocations', async () => {
    withStatusEndpoint = false;
    await remote.enableLocalChallenge(cache, undefined, 60_000);
    expect(remote.localChallengeActive).toBe(false);
    await signIn();
    calls = [];
    const second = await signIn();
    expect(second.ok && second.local).toBeFalsy();
    expect(calls).toEqual(['/api/auth/challenge', '/api/auth/verify']);
  });

  it('trust expires when the account service has not confirmed a device for a week', async () => {
    await remote.enableLocalChallenge(cache, undefined, 60_000);
    await signIn();
    clock += 8 * 24 * 3600_000;
    calls = [];
    const result = await signIn();
    expect(result.ok && result.local).toBeFalsy();
    expect(calls).toEqual(['/api/auth/challenge', '/api/auth/verify']);
  });

  it('no local mirror (removed on this edge), no local trust', async () => {
    await remote.enableLocalChallenge(cache, undefined, 60_000);
    await signIn();
    edge.deleteDevice('phone');
    expect(cache.lookup('phone')).toBeUndefined();
  });

  it('the account service reports device status per region', async () => {
    account.upsertRegion('us', 'wss://us.example.com', 'US', true);
    account.upsertRegion('china', 'wss://cn.example.com', 'China');
    account.setUserRegion('u1', 'china');
    const backend = new LocalAuthBackend({ storage: account, authProviders: new Map(), region: 'us',
      regionUrls: { us: 'wss://us.example.com', china: 'wss://cn.example.com' } });
    const st = (devices: Array<{ id: string; userId?: string; keyFingerprint?: string }>, region: string) =>
      ({ ...backend.deviceStatuses(devices, region).statuses });
    expect(st([{ id: 'phone' }, { id: 'missing' }], 'china')).toEqual({ phone: 'ok', missing: 'unknown_device' });
    expect(st([{ id: 'phone' }], 'us')).toEqual({ phone: 'wrong_region' });
    expect({ ...backend.deviceStatuses([{ id: 'phone' }], 'us').redirects }).toEqual({ phone: 'wss://cn.example.com' });
    expect(st([{ id: 'phone', userId: 'someone-else' }], 'china')).toEqual({ phone: 'unknown_device' });
    expect(st([{ id: 'phone', keyFingerprint: 'other' }], 'china')).toEqual({ phone: 'key_changed' });
    expect(st([{ id: 'phone', userId: 'u1', keyFingerprint: keyFingerprint(exportPublicKey(keys.publicKey)) }], 'china')).toEqual({ phone: 'ok' });
    account.deleteUser('u1');
    expect(st([{ id: 'phone' }], 'china')).toEqual({ phone: 'account_deleted' });
  });
});

// ── Through a real edge HeadServer ──────────────────────────


describe('edge HeadServer with local challenge auth', () => {
  it('signs a known app in without the account service and kicks it when the account service revokes it', async () => {
    const keys = generateKeyPair();
    const account = new Storage(':memory:');
    account.upsertUser('u1', 'alice', 'open');
    account.upsertDevice('phone', 'u1', 'iPhone', 'app', 'ios', exportPublicKey(keys.publicKey), 'enc-1');
    const accountCalls: string[] = [];
    const api = new AccountApi({ authBackend: new LocalAuthBackend({ storage: account, authProviders: new Map() }), serviceKey: SERVICE_KEY });
    const accountHttp = createServer(async (req, res) => {
      accountCalls.push(req.url ?? '');
      if (!(await api.handleRequest(req, res))) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => accountHttp.listen(0, r));
    const remote = new RemoteAuthBackend({ accountUrl: `http://localhost:${(accountHttp.address() as AddressInfo).port}`, serviceKey: SERVICE_KEY });
    const edgeStorage = new Storage(':memory:');
    await remote.enableLocalChallenge(new EdgeAuthCache(edgeStorage.rawDb), undefined, 60_000);
    const edge = new HeadServer(edgeStorage, { authBackend: remote });
    const edgeHttp = createServer();
    edge.attach(edgeHttp);
    await new Promise<void>((r) => edgeHttp.listen(0, r));
    const port = (edgeHttp.address() as AddressInfo).port;

    async function connect() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const messages: Record<string, unknown>[] = [];
      let closed = false;
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        messages.push(m);
        if (m.type === 'auth_challenge') {
          ws.send(JSON.stringify({ type: 'auth_response', deviceId: 'phone', signature: signChallenge(m.nonce, keys.privateKey) }));
        }
      });
      ws.on('close', () => { closed = true; });
      await new Promise((r) => ws.on('open', r));
      ws.send(JSON.stringify({ type: 'auth', auth: { method: 'challenge', deviceId: 'phone' }, device: { name: 'iPhone', role: 'app', encryptionKey: 'enc-1' } }));
      const until = async (pred: () => boolean) => {
        for (let i = 0; i < 300 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
        expect(pred()).toBe(true);
      };
      await until(() => messages.some((m) => m.type === 'auth_ok'));
      return { ws, messages, until, isClosed: () => closed };
    }

    try {
      const first = await connect();
      expect(accountCalls.filter((c) => c.startsWith('/api/auth/'))).toEqual(['/api/auth/challenge', '/api/auth/verify']);
      first.ws.close();
      await first.until(() => first.isClosed());

      accountCalls.length = 0;
      const second = await connect();
      const ok = second.messages.find((m) => m.type === 'auth_ok') as { devices: Array<{ id: string }>; features: string[] };
      expect(ok.devices.map((d) => d.id)).toContain('phone');
      expect(ok.features).toContain('app_visibility');
      expect(accountCalls.filter((c) => c.startsWith('/api/auth/challenge')), 'no challenge round trip').toEqual([]);

      account.deleteDevice('phone');
      await remote.pollDeviceStatus();
      await second.until(() => second.isClosed());
      expect(second.messages.some((m) => m.type === 'auth_error' && m.code === 'unknown_device')).toBe(true);
      expect(edgeStorage.getDevice('phone')).toBeFalsy();
    } finally {
      remote.stopLocalChallenge();
      edge.close();
      await new Promise<void>((r) => edgeHttp.close(() => r()));
      await new Promise<void>((r) => accountHttp.close(() => r()));
      edgeStorage.close();
      account.close();
    }
  });
});
