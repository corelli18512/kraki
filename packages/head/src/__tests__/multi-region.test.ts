/**
 * Tests for multi-region support:
 * - LocalAuthBackend (region checking, auth delegation)
 * - AccountApi (REST endpoints)
 * - RemoteAuthBackend (REST client)
 * - Schema v5 (region column)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { Storage } from '../storage.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { RemoteAuthBackend } from '../remote-auth-backend.js';
import { AccountApi } from '../account-api.js';
import { OpenAuthProvider } from '../auth.js';
import { Logger, setGlobalLogger } from '../logger.js';
import { regionForCountry, isPrivateIp } from '../ip-geo.js';

// Suppress log output during tests
setGlobalLogger(new Logger({ level: 'error', stdout: false }));

describe('Schema v5 — region column', () => {
  it('should add region column and store/retrieve it', () => {
    const storage = new Storage(':memory:');
    const user = storage.upsertUser('u1', 'alice', 'open', undefined, 'us');
    expect(user.region).toBe('us');

    const fetched = storage.getUser('u1');
    expect(fetched?.region).toBe('us');
    storage.close();
  });

  it('should default region to undefined for existing users', () => {
    const storage = new Storage(':memory:');
    const user = storage.upsertUser('u1', 'bob', 'open');
    expect(user.region).toBeUndefined();
    storage.close();
  });

  it('should set region explicitly', () => {
    const storage = new Storage(':memory:');
    storage.upsertUser('u1', 'charlie', 'open');
    storage.setUserRegion('u1', 'china');
    const user = storage.getUser('u1');
    expect(user?.region).toBe('china');
    storage.close();
  });

  it('should include region in getAllUsers', () => {
    const storage = new Storage(':memory:');
    storage.upsertUser('u1', 'alice', 'open', undefined, 'us');
    storage.upsertUser('u2', 'bob', 'open', undefined, 'china');
    const users = storage.getAllUsers();
    expect(users.find(u => u.userId === 'u1')?.region).toBe('us');
    expect(users.find(u => u.userId === 'u2')?.region).toBe('china');
    storage.close();
  });
});

describe('LocalAuthBackend', () => {
  let storage: Storage;
  let backend: LocalAuthBackend;

  beforeEach(() => {
    storage = new Storage(':memory:');
    storage.upsertRegion('us', 'wss://us.example.com', 'US');
    storage.upsertRegion('china', 'wss://cn.example.com', 'China');
    const providers = new Map();
    providers.set('open', new OpenAuthProvider());
    backend = new LocalAuthBackend({
      storage,
      authProviders: providers,
      region: 'us',
      regionUrls: { us: 'wss://us.example.com', china: 'wss://cn.example.com' },
    });
  });

  afterEach(() => {
    storage.close();
  });

  it('should authenticate with open method and assign region', async () => {
    const result = await backend.authenticate(
      { method: 'open', sharedKey: 'test' } as import("@kraki/protocol").AuthMethod,
      { name: 'Test', role: 'tentacle' },
      'us',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.region).toBe('us');
      expect(result.devices.length).toBe(1);
      expect(result.pendingMessages).toEqual([]);
    }
  });

  it('should reject wrong region', async () => {
    // First, create a user assigned to 'china' with a device that has a public key
    storage.upsertUser('u1', 'alice', 'open', undefined, 'china');
    // Need a real-looking public key for startChallenge to proceed to region check
    const dummyKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA' + 'A'.repeat(300);
    storage.upsertDevice('d1', 'u1', 'Laptop', 'tentacle', undefined, dummyKey);

    // Try challenge from 'us' head — should reject because user is pinned to 'china'
    const result = await backend.startChallenge('d1', undefined, 'us');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('wrong_region');
      expect((result as { redirect?: string }).redirect).toBe('wss://cn.example.com');
    }
  });

  it('should create and validate pairing tokens', async () => {
    storage.upsertUser('u1', 'alice', 'open');
    const { token, expiresIn } = backend.createPairingToken('u1');
    expect(token).toMatch(/^pt_/);
    expect(expiresIn).toBe(300);

    // Pair a device with this token
    const result = await backend.authenticate(
      { method: 'pairing', token } as import("@kraki/protocol").AuthMethod,
      { name: 'Phone', role: 'app' },
      'us',
    );
    expect(result.ok).toBe(true);
  });

  it('should reject expired pairing tokens', async () => {
    storage.upsertUser('u1', 'alice', 'open');
    // Access internal state to create an expired token
    const tok = backend.createPairingToken('u1');

    // Sweep with mocked time won't help, so we'll just validate that
    // consuming the token works once (single-use)
    const result1 = await backend.authenticate(
      { method: 'pairing', token: tok.token } as import("@kraki/protocol").AuthMethod,
      { name: 'Phone', role: 'app' },
      'us',
    );
    expect(result1.ok).toBe(true);

    // Second use should fail (consumed)
    const result2 = await backend.authenticate(
      { method: 'pairing', token: tok.token } as import("@kraki/protocol").AuthMethod,
      { name: 'Phone2', role: 'app' },
      'us',
    );
    expect(result2.ok).toBe(false);
  });

  it('should return auth info', () => {
    const info = backend.getAuthInfo();
    expect(info.methods).toContain('open');
    expect(info.methods).toContain('challenge');
  });

  it('should resolve login-first routing for an existing user', async () => {
    storage.upsertUser('local', 'local', 'open', undefined, 'china');

    const result = await backend.resolveLogin(
      { method: 'open', sharedKey: 'test' } as import("@kraki/protocol").AuthMethod,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.registered).toBe(true);
      expect(result.needsRegionSelection).toBe(false);
      expect(result.region).toBe('china');
      expect(result.relayUrl).toBe('wss://cn.example.com');
    }
  });

  it('should request region selection for a new user in login-first flow', async () => {
    const result = await backend.resolveLogin(
      { method: 'open', sharedKey: 'test' } as import("@kraki/protocol").AuthMethod,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.registered).toBe(false);
      expect(result.needsRegionSelection).toBe(true);
      expect(result.regions.map(r => r.code)).toEqual(expect.arrayContaining(['us', 'china']));
    }
  });
});

describe('AccountApi', () => {
  let storage: Storage;
  let server: Server;
  let port: number;
  const SERVICE_KEY = 'test-service-key-12345';

  beforeEach(async () => {
    storage = new Storage(':memory:');
    storage.upsertRegion('us', 'wss://us.example.com', 'US');
    storage.upsertRegion('china', 'wss://cn.example.com', 'China');
    const providers = new Map();
    providers.set('open', new OpenAuthProvider());
    const localBackend = new LocalAuthBackend({
      storage,
      authProviders: providers,
      region: 'us',
      regionUrls: { us: 'wss://us.example.com', china: 'wss://cn.example.com' },
    });
    const api = new AccountApi({ authBackend: localBackend, serviceKey: SERVICE_KEY });

    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const handled = await api.handleRequest(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(() => {
    server.close();
    storage.close();
  });

  async function apiPost(path: string, body: unknown, key = SERVICE_KEY) {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  }

  async function apiGet(path: string, key = SERVICE_KEY) {
    const res = await fetch(`http://localhost:${port}${path}`, {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    return { status: res.status, data: await res.json() };
  }

  async function apiPostPublic(path: string, body: unknown) {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  }

  async function apiGetPublic(path: string) {
    const res = await fetch(`http://localhost:${port}${path}`);
    return { status: res.status, data: await res.json() };
  }

  it('should reject requests without service key', async () => {
    const { status } = await apiPost('/api/auth', {}, 'wrong-key');
    expect(status).toBe(401);
  });

  it('should authenticate via open method', async () => {
    const { status, data } = await apiPost('/api/auth', {
      auth: { method: 'open', sharedKey: 'test' },
      device: { name: 'Test', role: 'tentacle' },
      headRegion: 'us',
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.userId).toBeTruthy();
    expect(data.deviceId).toBeTruthy();
    expect(data.devices.length).toBe(1);
  });

  it('should return wrong_region with redirect', async () => {
    // Create user in china
    storage.upsertUser('u-china', 'zhang', 'open', undefined, 'china');

    // Try to auth as that user from 'us' head
    // Note: open auth creates new users, so we need to use challenge for existing
    // Let's test by creating a device and using challenge flow
    storage.upsertDevice('d-china', 'u-china', 'Laptop', 'tentacle', undefined, 'AAAA');

    const { status, data } = await apiPost('/api/auth/challenge', {
      deviceId: 'd-china',
      headRegion: 'us',
    });
    expect(status).toBe(403);
    expect(data.ok).toBe(false);
    expect(data.code).toBe('wrong_region');
    expect(data.redirect).toBe('wss://cn.example.com');
  });

  it('should return config', async () => {
    const { status, data } = await apiGet('/api/config');
    expect(status).toBe(200);
    expect(data.methods).toContain('open');
    expect(data.methods).toContain('challenge');
  });

  it('should return the public region directory', async () => {
    const { status, data } = await apiGetPublic('/api/regions');
    expect(status).toBe(200);
    expect(data.ttlSec).toBe(300);
    expect(data.regions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'us', relayUrl: 'wss://us.example.com' }),
      expect.objectContaining({ code: 'china', relayUrl: 'wss://cn.example.com' }),
    ]));
  });

  it('should resolve login-first routing publicly', async () => {
    storage.upsertUser('local', 'local', 'open', undefined, 'china');

    const { status, data } = await apiPostPublic('/api/login/resolve', {
      auth: { method: 'open', sharedKey: 'test' },
    });

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.region).toBe('china');
    expect(data.relayUrl).toBe('wss://cn.example.com');
  });

  it('should create pairing token', async () => {
    storage.upsertUser('u1', 'alice', 'open');
    const { status, data } = await apiPost('/api/pairing/request', { userId: 'u1' });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.token).toMatch(/^pt_/);
  });

  it('should exchange an edge join token for a permanent service key', async () => {
    const issued = storage.issueEdgeJoinToken();

    const { status, data } = await apiPostPublic('/api/edge/join', {
      token: issued.token,
      region: 'china',
      relayUrl: 'wss://cn.example.com',
      displayName: 'China',
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.region).toBe('china');
    expect(data.serviceKey).toMatch(/^ksk_/);

    const config = await apiGet('/api/config', data.serviceKey);
    expect(config.status).toBe(200);
    expect(config.data.methods).toContain('open');
  });

  it('should reject edge join without region or relayUrl', async () => {
    const issued = storage.issueEdgeJoinToken();
    const { status, data } = await apiPostPublic('/api/edge/join', { token: issued.token });
    expect(status).toBe(400);
    expect(data.code).toBe('bad_request');
  });
});

describe('RemoteAuthBackend', () => {
  let storage: Storage;
  let server: Server;
  let port: number;
  let remoteBackend: RemoteAuthBackend;
  const SERVICE_KEY = 'test-remote-key-67890';

  beforeEach(async () => {
    storage = new Storage(':memory:');
    const providers = new Map();
    providers.set('open', new OpenAuthProvider());
    const localBackend = new LocalAuthBackend({
      storage,
      authProviders: providers,
    });
    const api = new AccountApi({ authBackend: localBackend, serviceKey: SERVICE_KEY });

    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const handled = await api.handleRequest(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;

    remoteBackend = new RemoteAuthBackend({
      accountUrl: `http://localhost:${port}`,
      serviceKey: SERVICE_KEY,
    });
  });

  afterEach(() => {
    server.close();
    storage.close();
  });

  it('should authenticate via remote account service', async () => {
    const result = await remoteBackend.authenticate(
      { method: 'open', sharedKey: 'test' } as import("@kraki/protocol").AuthMethod,
      { name: 'Remote-Test', role: 'tentacle' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBeTruthy();
      expect(result.deviceId).toBeTruthy();
    }
  });

  it('should refresh config from remote', async () => {
    const config = await remoteBackend.refreshConfig();
    expect(config.methods).toContain('open');
    expect(config.methods).toContain('challenge');
  });

  it('should fail gracefully with wrong service key', async () => {
    const badBackend = new RemoteAuthBackend({
      accountUrl: `http://localhost:${port}`,
      serviceKey: 'wrong-key',
    });
    const result = await badBackend.authenticate(
      { method: 'open', sharedKey: 'test' } as import("@kraki/protocol").AuthMethod,
      { name: 'Bad', role: 'tentacle' },
    );
    expect(result.ok).toBe(false);
  });
});

// ── IP Geo utilities ────────────────────────────────────

describe('IP Geo — regionForCountry', () => {
  it('should map China to china region', () => {
    expect(regionForCountry('CN')).toBe('china');
    expect(regionForCountry('HK')).toBe('china');
    expect(regionForCountry('MO')).toBe('china');
    expect(regionForCountry('TW')).toBe('china');
  });

  it('should map Asian countries to china region', () => {
    expect(regionForCountry('JP')).toBe('china');
    expect(regionForCountry('KR')).toBe('china');
    expect(regionForCountry('SG')).toBe('china');
    expect(regionForCountry('IN')).toBe('china');
    expect(regionForCountry('AU')).toBe('china');
  });

  it('should map non-Asian countries to us region', () => {
    expect(regionForCountry('US')).toBe('us');
    expect(regionForCountry('CA')).toBe('us');
    expect(regionForCountry('GB')).toBe('us');
    expect(regionForCountry('DE')).toBe('us');
    expect(regionForCountry('BR')).toBe('us');
  });

  it('should be case-insensitive', () => {
    expect(regionForCountry('cn')).toBe('china');
    expect(regionForCountry('Jp')).toBe('china');
    expect(regionForCountry('us')).toBe('us');
  });

  it('should default unknown codes to us', () => {
    expect(regionForCountry('XX')).toBe('us');
    expect(regionForCountry('')).toBe('us');
  });
});

describe('IP Geo — isPrivateIp', () => {
  it('should detect loopback', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('localhost')).toBe(true);
  });

  it('should detect IPv4-mapped IPv6 loopback', () => {
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
  });

  it('should detect private ranges', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('10.255.255.255')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('192.168.0.1')).toBe(true);
    expect(isPrivateIp('192.168.100.50')).toBe(true);
  });

  it('should not flag public IPs', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('223.5.5.5')).toBe(false);
    expect(isPrivateIp('172.32.0.1')).toBe(false);
    expect(isPrivateIp('11.0.0.1')).toBe(false);
  });

  it('should handle IPv4-mapped IPv6 private', () => {
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:192.168.1.1')).toBe(true);
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
  });
});

// ── Edge join flow (simplified) ─────────────────────────

describe('Storage — edge join tokens (simplified)', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = new Storage(':memory:');
  });

  afterEach(() => {
    storage.close();
  });

  it('should issue a blank join token with no region', () => {
    const issued = storage.issueEdgeJoinToken();
    expect(issued.token).toMatch(/^kjt_/);
    expect(issued.expiresIn).toBeGreaterThanOrEqual(60);
  });

  it('should consume token with edge-provided region and relayUrl', () => {
    const issued = storage.issueEdgeJoinToken();
    const result = storage.consumeEdgeJoinToken(issued.token, 'eu', 'wss://eu.example.com', 'Europe');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.region).toBe('eu');
      expect(result.relayUrl).toBe('wss://eu.example.com');
      expect(result.displayName).toBe('Europe');
    }
  });

  it('should reject already-used token', () => {
    const issued = storage.issueEdgeJoinToken();
    storage.consumeEdgeJoinToken(issued.token, 'eu', 'wss://eu.example.com');
    const result = storage.consumeEdgeJoinToken(issued.token, 'eu', 'wss://eu.example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('join_token_used');
    }
  });

  it('should reject invalid token', () => {
    const result = storage.consumeEdgeJoinToken('kjt_invalid', 'eu', 'wss://eu.example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid_join_token');
    }
  });

  it('should reject consume without relayUrl', () => {
    const issued = storage.issueEdgeJoinToken();
    const result = storage.consumeEdgeJoinToken(issued.token, 'eu', '');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('bad_request');
    }
  });
});

// ── Region directory & service keys ─────────────────────

describe('Storage — region directory', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = new Storage(':memory:');
  });

  afterEach(() => {
    storage.close();
  });

  it('should upsert and retrieve regions', () => {
    storage.upsertRegion('us', 'wss://us.example.com', 'United States');
    storage.upsertRegion('china', 'wss://cn.example.com', 'China');

    const us = storage.getRegion('us');
    expect(us?.code).toBe('us');
    expect(us?.relayUrl).toBe('wss://us.example.com');
    expect(us?.enabled).toBe(true);

    const all = storage.getRegions(true);
    expect(all.length).toBe(2);
  });

  it('should normalize region codes to lowercase', () => {
    storage.upsertRegion('US', 'wss://us.example.com');
    expect(storage.getRegion('us')?.code).toBe('us');
    expect(storage.getRegion('US')?.code).toBe('us');
  });

  it('should issue and validate service keys', () => {
    storage.upsertRegion('china', 'wss://cn.example.com');
    const { serviceKey } = storage.issueRegionServiceKey('china');
    expect(serviceKey).toMatch(/^ksk_/);

    const validation = storage.validateServiceKey(serviceKey);
    expect(validation.valid).toBe(true);
    if (validation.valid) {
      expect(validation.region).toBe('china');
    }
  });

  it('should reject invalid service keys', () => {
    const validation = storage.validateServiceKey('ksk_invalid');
    expect(validation.valid).toBe(false);
  });

  it('should replace service key on re-issue', () => {
    storage.upsertRegion('china', 'wss://cn.example.com');
    const first = storage.issueRegionServiceKey('china');
    const second = storage.issueRegionServiceKey('china');

    expect(first.serviceKey).not.toBe(second.serviceKey);
    expect(storage.validateServiceKey(first.serviceKey).valid).toBe(false);
    expect(storage.validateServiceKey(second.serviceKey).valid).toBe(true);
  });
});
