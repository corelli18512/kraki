/**
 * First sign-in straight at the main head (LocalAuthBackend.completeAuth):
 * the web app, iPhone and Mac apps connect to the main relay, so a new
 * account gets its region there the way resolveLogin picks one (IP geo,
 * DEFAULT_SIGNUP_REGION, else the main head's REGION; enabled regions only)
 * and the device is sent on with wrong_region + its registered device id.
 * The redirected device then signs in at its region's edge with what it
 * already holds: its key (challenge) or its GitHub token.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { generateKeyPair, exportPublicKey, signChallenge } from '@kraki/crypto';
import type { AuthMethod, DeviceInfo } from '@kraki/protocol';
import { Storage } from '../storage.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { RemoteAuthBackend } from '../remote-auth-backend.js';
import { AccountApi } from '../account-api.js';
import { GitHubAuthProvider, type AuthProvider } from '../auth.js';
import { silenceLogs } from './log-capture.js';

silenceLogs();

const MAIN = 'us';
const PUBLIC_IP = '203.0.113.7';
const GITHUB_TOKEN = 'gho_newuser';
const OAUTH_CODE = 'oauth-code-single-use';
const USWEST_URL = 'wss://us.relay.example.com';

describe('first sign-in at the main head gets the signup region', () => {
  let storage: Storage;
  let server: Server | undefined;
  let githubFetch: ReturnType<typeof vi.fn>;
  let geoLookups: number;
  let oauthExchanges: number;
  const realFetch = globalThis.fetch;

  /** ip-api.com answers with `countryCode` (or fails); every other request
   *  (edge → main account API) goes out as usual. */
  function geo(countryCode: string | 'fail'): void {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('http://ip-api.com/')) return realFetch(input, init);
      geoLookups++;
      if (countryCode === 'fail') throw new Error('ip-api down');
      return new Response(JSON.stringify({ status: 'success', countryCode }));
    }));
  }

  function mainBackend(): LocalAuthBackend {
    githubFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://github.com/login/oauth/access_token') {
        oauthExchanges++;
        const body = JSON.parse(String(init?.body)) as { code: string };
        // GitHub codes are single use.
        return body.code === OAUTH_CODE && oauthExchanges === 1
          ? new Response(JSON.stringify({ access_token: GITHUB_TOKEN }))
          : new Response(JSON.stringify({ error: 'bad_verification_code' }));
      }
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      return auth === `Bearer ${GITHUB_TOKEN}`
        ? new Response(JSON.stringify({ id: 777, login: 'newbie' }))
        : new Response('{}', { status: 401 });
    });
    const providers = new Map<string, AuthProvider>([
      ['github', new GitHubAuthProvider({ fetcher: githubFetch as unknown as typeof fetch, clientId: 'cid', clientSecret: 'secret' })],
    ]);
    return new LocalAuthBackend({ storage, authProviders: providers, region: MAIN, defaultSignupRegion: 'uswest' });
  }

  /** The US-West edge, talking to main's account API. */
  async function uswestEdge(backend: LocalAuthBackend): Promise<RemoteAuthBackend> {
    const api = new AccountApi({ authBackend: backend, serviceKey: 'admin-key' });
    server = createServer(async (req, res) => {
      if (!(await api.handleRequest(req, res))) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return new RemoteAuthBackend({ accountUrl: base, serviceKey: 'admin-key' });
  }

  function phone(): { device: DeviceInfo; sign: (nonce: string) => string } {
    const keys = generateKeyPair();
    return {
      device: { name: 'iPhone', role: 'app', kind: 'ios', publicKey: exportPublicKey(keys.publicKey), encryptionKey: 'enc-key' },
      sign: (nonce) => signChallenge(nonce, keys.privateKey),
    };
  }

  /** What the iPhone / web app do after wrong_region: challenge auth with
   *  the device id from the redirect, at the region's relay. */
  async function challengeAt(edge: RemoteAuthBackend, deviceId: string, sign: (nonce: string) => string) {
    const start = await edge.startChallenge(deviceId, 'enc-key', 'uswest');
    if (!start.ok) return start;
    return edge.verifyChallenge(deviceId, start.nonce, sign(start.nonce), 'enc-key', 'uswest');
  }

  beforeEach(() => {
    geoLookups = 0;
    oauthExchanges = 0;
    storage = new Storage(':memory:');
    storage.upsertRegion('us', 'wss://relay.example.com', 'Tokyo');
    storage.upsertRegion('china', 'wss://cn.relay.example.com', 'China');
    storage.upsertRegion('uswest', USWEST_URL, 'US West');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    storage.close();
  });

  it('GitHub OAuth (web app, iPhone): code exchanged once on main, then challenge auth at the region relay', async () => {
    geo('US');
    const backend = mainBackend();
    const edge = await uswestEdge(backend);
    const { device, sign } = phone();
    const oauth = { method: 'github_oauth', code: OAUTH_CODE, codeVerifier: 'v', redirectUri: 'https://app.example.com/auth/callback' } as AuthMethod;

    const first = await backend.authenticate(oauth, device, MAIN, PUBLIC_IP);
    expect(first).toMatchObject({ ok: false, code: 'wrong_region', redirect: USWEST_URL });
    const deviceId = (first as { deviceId?: string }).deviceId!;
    expect(deviceId).toBeTruthy();
    expect(storage.getUser('777')?.region).toBe('uswest');
    expect(storage.getDevice(deviceId)?.publicKey).toBe(device.publicKey);

    const atRegion = await challengeAt(edge, deviceId, sign);
    expect(atRegion.ok && atRegion.userId).toBe('777');
    expect(atRegion.ok && atRegion.user.region).toBe('uswest');
    expect(oauthExchanges).toBe(1);
  });

  it('pairing link (iPhone, web app): the token is used up on main, then challenge auth at the region relay', async () => {
    geo('DE');
    const backend = mainBackend();
    const edge = await uswestEdge(backend);
    // `kraki pair` with a GitHub token creates the account without a region.
    const pairing = await backend.requestPairingToken(GITHUB_TOKEN, PUBLIC_IP);
    expect(pairing.ok).toBe(true);
    expect(storage.getUser('777')?.region).toBeUndefined();

    const { device, sign } = phone();
    const first = await backend.authenticate({ method: 'pairing', token: (pairing as { pairingToken: string }).pairingToken }, device, MAIN, PUBLIC_IP);
    expect(first).toMatchObject({ ok: false, code: 'wrong_region', redirect: USWEST_URL });
    expect(storage.getUser('777')?.region).toBe('uswest');

    const atRegion = await challengeAt(edge, (first as { deviceId: string }).deviceId, sign);
    expect(atRegion.ok && atRegion.userId).toBe('777');
  });

  it('GitHub token (Mac app, CLI): signs in again with the same token at the region relay', async () => {
    geo('US');
    const backend = mainBackend();
    const edge = await uswestEdge(backend);
    const auth = { method: 'github_token', token: GITHUB_TOKEN } as AuthMethod;
    const device: DeviceInfo = { name: 'Laptop', role: 'tentacle', deviceId: 'dev_laptop' };

    const first = await backend.authenticate(auth, device, MAIN, PUBLIC_IP);
    expect(first).toMatchObject({ ok: false, code: 'wrong_region', redirect: USWEST_URL, deviceId: 'dev_laptop' });
    const atRegion = await edge.authenticate(auth, device, 'uswest', PUBLIC_IP);
    expect(atRegion.ok && atRegion.deviceId).toBe('dev_laptop');
    expect(storage.getDevicesByUser('777')).toHaveLength(1);
  });

  it('a new user from Japan stays on the main relay', async () => {
    geo('JP');
    const result = await mainBackend().authenticate({ method: 'github_token', token: GITHUB_TOKEN } as AuthMethod, phone().device, MAIN, PUBLIC_IP);
    expect(result.ok && result.user.region).toBe('us');
  });

  it('a new user from China is sent to the china relay', async () => {
    geo('CN');
    const result = await mainBackend().authenticate({ method: 'github_token', token: GITHUB_TOKEN } as AuthMethod, phone().device, MAIN, PUBLIC_IP);
    expect(result).toMatchObject({ ok: false, code: 'wrong_region', redirect: 'wss://cn.relay.example.com' });
  });

  it('falls back to the main head\'s region when the IP lookup fails', async () => {
    geo('fail');
    const result = await mainBackend().authenticate({ method: 'github_token', token: GITHUB_TOKEN } as AuthMethod, phone().device, MAIN, PUBLIC_IP);
    expect(result.ok && result.user.region).toBe('us');
    expect(geoLookups).toBe(1);
  });

  it('falls back to the main head\'s region when the signup region is not enabled', async () => {
    storage.upsertRegion('uswest', USWEST_URL, 'US West', false);
    geo('US');
    const result = await mainBackend().authenticate({ method: 'github_token', token: GITHUB_TOKEN } as AuthMethod, phone().device, MAIN, PUBLIC_IP);
    expect(result.ok && result.user.region).toBe('us');
  });

  it('keeps an existing account in its region without a lookup', async () => {
    storage.upsertUser('777', 'newbie', 'github', undefined, 'us');
    geo('US');
    const result = await mainBackend().authenticate({ method: 'github_token', token: GITHUB_TOKEN } as AuthMethod, phone().device, MAIN, PUBLIC_IP);
    expect(result.ok && result.user.region).toBe('us');
    expect(geoLookups).toBe(0);
  });

  it('a first sign-in at an edge keeps that edge\'s region, without a lookup', async () => {
    geo('JP');
    const backend = mainBackend();
    const edge = await uswestEdge(backend);
    const result = await edge.authenticate({ method: 'github_token', token: GITHUB_TOKEN } as AuthMethod, phone().device, 'uswest', PUBLIC_IP);
    expect(result.ok && result.user.region).toBe('uswest');
    expect(geoLookups).toBe(0);
  });

  it('makes no lookup when the main head\'s region is the only enabled one', async () => {
    storage.upsertRegion('china', 'wss://cn.relay.example.com', 'China', false);
    storage.upsertRegion('uswest', USWEST_URL, 'US West', false);
    geo('US');
    const result = await mainBackend().authenticate({ method: 'github_token', token: GITHUB_TOKEN } as AuthMethod, phone().device, MAIN, PUBLIC_IP);
    expect(result.ok && result.user.region).toBe('us');
    expect(geoLookups).toBe(0);
  });
});
