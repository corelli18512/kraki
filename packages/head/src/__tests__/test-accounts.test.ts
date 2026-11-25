/**
 * Operator test accounts (test-accounts.ts, TEST_ACCOUNTS): QA users
 * `test:qa-…` pinned to a configured region, signed in through
 * POST /api/test-login (pairing link) or `{ method: 'apikey', key }`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { AuthMethod } from '@kraki/protocol';
import { Storage } from '../storage.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { RemoteAuthBackend } from '../remote-auth-backend.js';
import { AccountApi } from '../account-api.js';
import { ApiKeyAuthProvider, GitHubAuthProvider, ThrottledAuthProvider, type AuthProvider } from '../auth.js';
import { parseTestAccounts, parseTestLoginAppUrl, TestAccountAuthProvider, type TestAccount } from '../test-accounts.js';
import { metrics, resetMetricsForTests } from '../metrics.js';
import { captureLogs, silenceLogs, type CapturingLogger } from './log-capture.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const QA_USWEST_TOKEN = randomBytes(32).toString('base64url');
const QA_US_TOKEN = randomBytes(32).toString('base64url');
const ACCOUNTS: TestAccount[] = [
  { login: 'qa-uswest', region: 'uswest', tokenSha256: sha256(QA_USWEST_TOKEN) },
  { login: 'qa-us', region: 'us', tokenSha256: sha256(QA_US_TOKEN) },
];
const GITHUB_TOKEN = 'gho_realuser';

describe('parseTestAccounts', () => {
  it('is off when unset or blank', () => {
    expect(parseTestAccounts(undefined)).toEqual([]);
    expect(parseTestAccounts('')).toEqual([]);
    expect(parseTestAccounts('  ')).toEqual([]);
  });

  it('parses and normalizes accounts', () => {
    const hash = sha256('t').toUpperCase();
    expect(parseTestAccounts(JSON.stringify([{ login: 'qa-uswest', region: ' USWest ', tokenSha256: hash }])))
      .toEqual([{ login: 'qa-uswest', region: 'uswest', tokenSha256: hash.toLowerCase() }]);
  });

  it('rejects a login without the qa- prefix', () => {
    expect(() => parseTestAccounts(JSON.stringify([{ login: 'octocat', region: 'us', tokenSha256: sha256('t') }])))
      .toThrow(/must start with "qa-"/);
    expect(() => parseTestAccounts(JSON.stringify([{ login: 'QA-upper', region: 'us', tokenSha256: sha256('t') }])))
      .toThrow(/must start with "qa-"/);
  });

  it('rejects malformed input', () => {
    expect(() => parseTestAccounts('{')).toThrow(/JSON array/);
    expect(() => parseTestAccounts('{}')).toThrow(/JSON array/);
    expect(() => parseTestAccounts(JSON.stringify([{ login: 'qa-a', region: 'us', tokenSha256: 'abc' }]))).toThrow(/tokenSha256/);
    expect(() => parseTestAccounts(JSON.stringify([{ login: 'qa-a', region: '', tokenSha256: sha256('t') }]))).toThrow(/region/);
    expect(() => parseTestAccounts(JSON.stringify([
      { login: 'qa-a', region: 'us', tokenSha256: sha256('t') },
      { login: 'qa-a', region: 'us', tokenSha256: sha256('u') },
    ]))).toThrow(/listed twice/);
    expect(() => parseTestAccounts(JSON.stringify([
      { login: 'qa-a', region: 'us', tokenSha256: sha256('t') },
      { login: 'qa-b', region: 'us', tokenSha256: sha256('t') },
    ]))).toThrow(/shared/);
  });
});

describe('parseTestLoginAppUrl', () => {
  it('is the default app when unset or blank', () => {
    expect(parseTestLoginAppUrl(undefined)).toBeUndefined();
    expect(parseTestLoginAppUrl('  ')).toBeUndefined();
  });

  it('accepts an https URL, with or without a path', () => {
    expect(parseTestLoginAppUrl(' https://app.example.com ')).toBe('https://app.example.com');
    expect(parseTestLoginAppUrl('https://app.example.com/qa/')).toBe('https://app.example.com/qa/');
  });

  it('rejects a URL that is not https', () => {
    expect(() => parseTestLoginAppUrl('http://app.example.com')).toThrow(/https/);
    expect(() => parseTestLoginAppUrl('app.example.com')).toThrow(/https/);
    expect(() => parseTestLoginAppUrl('wss://app.example.com')).toThrow(/https/);
  });

  it('rejects a query or fragment, which would break the link', () => {
    expect(() => parseTestLoginAppUrl('https://app.example.com?x=1')).toThrow(/query or fragment/);
    expect(() => parseTestLoginAppUrl('https://app.example.com/?')).toThrow(/query or fragment/);
    expect(() => parseTestLoginAppUrl('https://app.example.com/#top')).toThrow(/query or fragment/);
  });
});

describe('test accounts on the main head', () => {
  let storage: Storage;
  let server: Server;
  let base: string;
  let githubFetch: ReturnType<typeof vi.fn>;
  let logs: CapturingLogger;

  function makeBackend(withTestAccounts: boolean, opts: { pairingEnabled?: boolean; apiKey?: string } = {}): LocalAuthBackend {
    githubFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      return auth === `Bearer ${GITHUB_TOKEN}`
        ? new Response(JSON.stringify({ id: 4242, login: 'octocat' }))
        : new Response('{}', { status: 401 });
    });
    const providers = new Map<string, AuthProvider>([
      ['github', new GitHubAuthProvider({ fetcher: githubFetch as unknown as typeof fetch })],
    ]);
    if (opts.apiKey) providers.set('apikey', new ThrottledAuthProvider(new ApiKeyAuthProvider(opts.apiKey)));
    if (withTestAccounts) providers.set('test', new ThrottledAuthProvider(new TestAccountAuthProvider(ACCOUNTS)));
    return new LocalAuthBackend({
      storage, authProviders: providers, region: 'us', defaultSignupRegion: 'uswest', pairingEnabled: opts.pairingEnabled,
    });
  }

  async function startApi(backend: LocalAuthBackend): Promise<void> {
    const api = new AccountApi({ authBackend: backend, serviceKey: 'admin-key' });
    server = createServer(async (req, res) => {
      if (!(await api.handleRequest(req, res))) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function testLogin(token: unknown) {
    const res = await fetch(`${base}/api/test-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    return { status: res.status, data: await res.json() as Record<string, unknown> };
  }

  beforeEach(() => {
    logs = captureLogs();
    resetMetricsForTests();
    storage = new Storage(':memory:');
    storage.upsertRegion('us', 'wss://relay.example.com', 'Tokyo');
    storage.upsertRegion('uswest', 'wss://us.relay.example.com', 'US West');
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
    silenceLogs();
  });

  it('is disabled by default: /api/test-login is 404 and a test token is not an API key', async () => {
    const backend = makeBackend(false);
    await startApi(backend);
    const { status, data } = await testLogin(QA_USWEST_TOKEN);
    expect(status).toBe(404);
    expect(data.code).toBe('not_found');

    const auth = await backend.authenticate({ method: 'apikey', key: QA_USWEST_TOKEN }, { name: 'CLI', role: 'tentacle' }, 'uswest');
    expect(auth).toMatchObject({ ok: false, message: 'Auth method apikey not configured' });
    expect(storage.getUser('test:qa-uswest')).toBeUndefined();
  });

  it('throttles and counts wrong apikey tokens on the WebSocket and /api/login/resolve too', async () => {
    const backend = makeBackend(true);
    const cli = { name: 'CLI', role: 'tentacle' as const };
    const wrong = await backend.authenticate({ method: 'apikey', key: 'wrong-token' }, cli, 'us', '203.0.113.7');
    expect(wrong).toMatchObject({ ok: false, code: 'auth_rejected' });
    expect(metrics().get('auth.testAccount.fail')).toBe(1);
    for (let i = 0; i < 2; i++) await backend.authenticate({ method: 'apikey', key: 'wrong-token' }, cli, 'us', '203.0.113.7');
    for (let i = 0; i < 2; i++) await backend.resolveLogin({ method: 'apikey', key: 'wrong-token' }, undefined, '203.0.113.7');
    expect(metrics().get('auth.testAccount.fail')).toBe(5);

    const throttled = await backend.authenticate({ method: 'apikey', key: QA_US_TOKEN }, cli, 'us', '203.0.113.7');
    expect(throttled).toMatchObject({ ok: false, message: expect.stringMatching(/Too many/) });
    const resolve = await backend.resolveLogin({ method: 'apikey', key: QA_US_TOKEN }, undefined, '203.0.113.7');
    expect(resolve).toMatchObject({ ok: false, message: expect.stringMatching(/Too many/) });
    expect(storage.getUser('test:qa-us')).toBeUndefined();
    // Another address is not affected.
    const other = await backend.authenticate({ method: 'apikey', key: QA_US_TOKEN }, cli, 'us', '198.51.100.9');
    expect(other.ok && other.userId).toBe('test:qa-us');
  });

  it('with an apikey provider too, other keys still go to it', async () => {
    const backend = makeBackend(true, { apiKey: 'operator-api-key' });
    const cli = { name: 'CLI', role: 'tentacle' as const };
    // The operator key's account is new: its region comes from the IP.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'success', countryCode: 'JP' }))));
    try {
      const operator = await backend.authenticate({ method: 'apikey', key: 'operator-api-key' }, cli, 'us', '203.0.113.7');
      expect(operator.ok).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    const test = await backend.authenticate({ method: 'apikey', key: QA_US_TOKEN }, cli, 'us', '203.0.113.7');
    expect(test.ok && test.userId).toBe('test:qa-us');
    const wrong = await backend.authenticate({ method: 'apikey', key: 'wrong-token' }, cli, 'us', '203.0.113.7');
    expect(wrong).toMatchObject({ ok: false, message: 'Invalid API key' });
    expect(metrics().get('auth.testAccount.fail')).toBe(0);
  });

  it('refuses a test login link when pairing is disabled', async () => {
    await startApi(makeBackend(true, { pairingEnabled: false }));
    const { status, data } = await testLogin(QA_USWEST_TOKEN);
    expect(status).toBe(401);
    expect(data.code).toBe('pairing_disabled');
    expect(data.pairingToken).toBeUndefined();
    expect(storage.getUser('test:qa-uswest')).toBeUndefined();
  });

  it('treats a malformed apikey payload as not a test account', async () => {
    const backend = makeBackend(true);
    const auth = await backend.authenticate({ method: 'apikey', key: 42 } as unknown as AuthMethod, { name: 'CLI', role: 'tentacle' }, 'us');
    expect(auth).toMatchObject({ ok: false, code: 'auth_rejected' });
  });

  it('rejects a wrong token, counts it and throttles repeated failures', async () => {
    await startApi(makeBackend(true));
    const first = await testLogin('wrong-token');
    expect(first.status).toBe(401);
    expect(first.data.code).toBe('auth_rejected');
    expect(metrics().get('auth.testAccount.fail')).toBe(1);
    for (let i = 0; i < 4; i++) await testLogin('wrong-token');
    const throttled = await testLogin(QA_USWEST_TOKEN);
    expect(throttled.status).toBe(401);
    expect(String(throttled.data.message)).toMatch(/Too many/);
    expect(storage.getUser('test:qa-uswest')).toBeUndefined();
  });

  it('a correct token returns a pairing token for test:qa-… in its configured region', async () => {
    const backend = makeBackend(true);
    await startApi(backend);
    const { status, data } = await testLogin(QA_USWEST_TOKEN);
    expect(status).toBe(200);
    expect(data).toMatchObject({
      ok: true,
      userId: 'test:qa-uswest',
      login: 'qa-uswest',
      region: 'uswest',
      relayUrl: 'wss://us.relay.example.com',
    });
    expect(String(data.pairingToken)).toMatch(/^pt_/);
    const link = new URL(String(data.pairingUrl));
    expect(link.origin).toBe('https://app.kraki.chat');
    expect(link.searchParams.get('relay')).toBe('wss://us.relay.example.com');
    expect(link.searchParams.get('token')).toBe(data.pairingToken);
    expect(storage.getUser('test:qa-uswest')).toMatchObject({ username: 'qa-uswest', provider: 'test', region: 'uswest' });
    expect(metrics().get('auth.testAccount.ok')).toBe(1);

    // The app pairs at the region's relay like any other account…
    const paired = await backend.authenticate({ method: 'pairing', token: String(data.pairingToken) }, { name: 'Phone', role: 'app' }, 'uswest');
    expect(paired.ok && paired.userId).toBe('test:qa-uswest');
    // …and another region's relay redirects it there.
    const again = await testLogin(QA_USWEST_TOKEN);
    const elsewhere = await backend.authenticate({ method: 'pairing', token: String(again.data.pairingToken) }, { name: 'Phone 2', role: 'app' }, 'us');
    expect(elsewhere).toMatchObject({ ok: false, code: 'wrong_region', redirect: 'wss://us.relay.example.com' });
  });

  it('pins the region from config, not the IP or a preferred region', async () => {
    const backend = makeBackend(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'success', countryCode: 'US' }))));
    try {
      const result = await backend.resolveLogin({ method: 'apikey', key: QA_US_TOKEN }, 'uswest', '203.0.113.7');
      expect(result.ok && result.region).toBe('us');
      expect(result.ok && result.user.id).toBe('test:qa-us');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(storage.getUser('test:qa-us')?.region).toBe('us');
  });

  it('keeps the region of an existing test account', async () => {
    storage.upsertUser('test:qa-uswest', 'qa-uswest', 'test', undefined, 'us');
    await startApi(makeBackend(true));
    const { data } = await testLogin(QA_USWEST_TOKEN);
    expect(data.region).toBe('us');
    expect(data.relayUrl).toBe('wss://relay.example.com');
  });

  it('refuses the first sign-in when the configured region is not enabled', async () => {
    storage.upsertRegion('uswest', 'wss://us.relay.example.com', 'US West', false);
    const backend = makeBackend(true);
    await startApi(backend);
    const { status, data } = await testLogin(QA_USWEST_TOKEN);
    expect(status).toBe(401);
    expect(String(data.message)).toMatch(/uswest/);
    const auth = await backend.authenticate({ method: 'apikey', key: QA_USWEST_TOKEN }, { name: 'CLI', role: 'tentacle' }, 'us');
    expect(auth.ok).toBe(false);
    expect(storage.getUser('test:qa-uswest')).toBeUndefined();
  });

  it('a released CLI signs in with --auth apikey through the region\'s edge', async () => {
    const backend = makeBackend(true);
    await startApi(backend);
    const edge = new RemoteAuthBackend({ accountUrl: base, serviceKey: 'admin-key' });
    const device = { name: 'QA laptop', role: 'tentacle' as const, deviceId: 'dev_qa_cli' };
    const result = await edge.authenticate({ method: 'apikey', key: QA_USWEST_TOKEN }, device, 'uswest', '203.0.113.7');
    expect(result.ok && result.user).toMatchObject({ id: 'test:qa-uswest', provider: 'test', region: 'uswest' });
    const tokyo = await edge.authenticate({ method: 'apikey', key: QA_USWEST_TOKEN }, device, 'us', '203.0.113.7');
    expect(tokyo).toMatchObject({ ok: false, code: 'wrong_region', redirect: 'wss://us.relay.example.com' });
  });

  it('`kraki connect` pairing requests with a test token never reach GitHub', async () => {
    const backend = makeBackend(true);
    const result = await backend.requestPairingToken(QA_USWEST_TOKEN, '203.0.113.7', true);
    expect(result.ok && result.userId).toBe('test:qa-uswest');
    expect(githubFetch).not.toHaveBeenCalled();
    expect(storage.getUser('test:qa-uswest')?.region).toBe('uswest');
  });

  it('leaves GitHub users unaffected', async () => {
    const backend = makeBackend(true);
    expect(backend.getAuthInfo().methods).not.toContain('apikey');
    expect(backend.getAuthInfo().methods).not.toContain('test');

    const pairing = await backend.requestPairingToken(GITHUB_TOKEN, '203.0.113.7', true);
    expect(pairing.ok && pairing.userId).toBe('4242');
    const rejected = await backend.requestPairingToken('gho_bad', '203.0.113.7', true);
    expect(rejected).toMatchObject({ ok: false, message: 'GitHub API returned 401' });

    const login = await backend.authenticate({ method: 'github_token', token: GITHUB_TOKEN } as AuthMethod, { name: 'Laptop', role: 'tentacle' }, 'us');
    expect(login.ok && login.user).toMatchObject({ id: '4242', provider: 'github', region: 'us' });
    expect(metrics().get('auth.testAccount.ok')).toBe(0);
    expect(metrics().get('auth.testAccount.fail')).toBe(0);
  });

  it('deletes a test account like any other', async () => {
    const backend = makeBackend(true);
    await startApi(backend);
    const { data } = await testLogin(QA_USWEST_TOKEN);
    const paired = await backend.authenticate({ method: 'pairing', token: String(data.pairingToken) }, { name: 'Phone', role: 'app' }, 'uswest');
    expect(paired.ok).toBe(true);
    const deviceIds = await backend.deleteAccount('test:qa-uswest');
    expect(deviceIds).toHaveLength(1);
    expect(storage.getUser('test:qa-uswest')).toBeUndefined();
    expect(storage.getDevicesByUser('test:qa-uswest')).toEqual([]);
  });

  it('never logs the token', async () => {
    const backend = makeBackend(true);
    await startApi(backend);
    await testLogin('wrong-token-secret');
    await testLogin(QA_USWEST_TOKEN);
    await backend.authenticate({ method: 'apikey', key: QA_US_TOKEN }, { name: 'CLI', role: 'tentacle' }, 'us');
    await backend.requestPairingToken(QA_US_TOKEN, '203.0.113.7');
    const text = JSON.stringify(logs.lines);
    expect(logs.find('Test account signed in').length).toBeGreaterThan(0);
    for (const secret of [QA_USWEST_TOKEN, QA_US_TOKEN, 'wrong-token-secret']) expect(text).not.toContain(secret);
  });
});
