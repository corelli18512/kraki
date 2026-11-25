/**
 * Region of a new account (ip-geo.ts COUNTRY_TO_REGION + LocalAuthBackend.
 * resolveLogin): Greater China → china, the rest of Asia-Pacific → us (the
 * Tokyo relay's legacy code), everything else → DEFAULT_SIGNUP_REGION, only
 * when that region is enabled. Existing accounts never move.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AuthMethod } from '@kraki/protocol';
import { Storage } from '../storage.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { OpenAuthProvider } from '../auth.js';
import { regionForCountry, suggestRegionForIp } from '../ip-geo.js';
import { silenceLogs } from './log-capture.js';

silenceLogs();

const OPEN: AuthMethod = { method: 'open', sharedKey: 'k' };
const PUBLIC_IP = '203.0.113.7';

/** ip-api.com answers with this country. */
function geoCountry(countryCode: string): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'success', countryCode }))));
}

describe('regionForCountry — mapping table', () => {
  it('maps CN, HK, MO, TW to china', () => {
    for (const cc of ['CN', 'HK', 'MO', 'TW']) expect(regionForCountry(cc, 'uswest')).toBe('china');
  });

  it('maps the rest of Asia-Pacific, the Middle East, South/Central Asia and Oceania to us', () => {
    const asiaPacific = [
      'JP', 'KR', 'MN', 'SG', 'MY', 'TH', 'VN', 'PH', 'ID', 'MM', 'KH', 'LA', 'BN', 'TL',
      'IN', 'PK', 'BD', 'LK', 'NP', 'BT', 'MV', 'KZ', 'UZ', 'KG', 'TJ', 'TM',
      'AE', 'SA', 'QA', 'BH', 'KW', 'OM', 'IR', 'IQ', 'IL', 'JO', 'LB', 'SY', 'YE', 'AF',
      'AU', 'NZ', 'FJ', 'PG',
    ];
    for (const cc of asiaPacific) expect(regionForCountry(cc, 'uswest'), cc).toBe('us');
  });

  it('maps the Americas, Europe and Africa to the default signup region', () => {
    for (const cc of ['US', 'CA', 'MX', 'BR', 'AR', 'GB', 'DE', 'FR', 'RU', 'ZA', 'NG', 'EG']) {
      expect(regionForCountry(cc, 'uswest'), cc).toBe('uswest');
    }
  });

  it('maps an unknown country to the default signup region', () => {
    expect(regionForCountry('XX', 'uswest')).toBe('uswest');
    expect(regionForCountry('', 'uswest')).toBe('uswest');
  });

  it('keeps us as the default when none is given', () => {
    expect(regionForCountry('US')).toBe('us');
  });

  it('suggestRegionForIp passes the default region through', async () => {
    geoCountry('DE');
    try {
      expect(await suggestRegionForIp(PUBLIC_IP, 'uswest')).toBe('uswest');
      expect(await suggestRegionForIp(PUBLIC_IP)).toBe('us');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('LocalAuthBackend.resolveLogin — default signup region', () => {
  let storage: Storage;

  function backend(defaultSignupRegion?: string): LocalAuthBackend {
    return new LocalAuthBackend({
      storage,
      authProviders: new Map([['open', new OpenAuthProvider()]]),
      region: 'us',
      defaultSignupRegion,
    });
  }

  beforeEach(() => {
    storage = new Storage(':memory:');
    storage.upsertRegion('us', 'wss://relay.example.com', 'Tokyo');
    storage.upsertRegion('china', 'wss://cn.relay.example.com', 'China');
    storage.upsertRegion('uswest', 'wss://us.relay.example.com', 'US West');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    storage.close();
  });

  it('assigns a new user from the US to the configured default region', async () => {
    geoCountry('US');
    const result = await backend('uswest').resolveLogin(OPEN, undefined, PUBLIC_IP);
    expect(result.ok && result.region).toBe('uswest');
    expect(result.ok && result.relayUrl).toBe('wss://us.relay.example.com');
    expect(storage.getUser('local')?.region).toBe('uswest');
  });

  it('assigns a new user from an unknown country to the default region', async () => {
    geoCountry('XX');
    const result = await backend('uswest').resolveLogin(OPEN, undefined, PUBLIC_IP);
    expect(result.ok && result.region).toBe('uswest');
  });

  it('assigns a new user from Japan to us (Tokyo)', async () => {
    geoCountry('JP');
    const result = await backend('uswest').resolveLogin(OPEN, undefined, PUBLIC_IP);
    expect(result.ok && result.region).toBe('us');
  });

  it('assigns a new user from China to china', async () => {
    geoCountry('CN');
    const result = await backend('uswest').resolveLogin(OPEN, undefined, PUBLIC_IP);
    expect(result.ok && result.region).toBe('china');
  });

  it('without a configured default, a new user from the US gets us', async () => {
    geoCountry('US');
    const result = await backend().resolveLogin(OPEN, undefined, PUBLIC_IP);
    expect(result.ok && result.region).toBe('us');
  });

  it('falls back to this relay\'s region when the default region is disabled', async () => {
    storage.upsertRegion('uswest', 'wss://us.relay.example.com', 'US West', false);
    geoCountry('US');
    const result = await backend('uswest').resolveLogin(OPEN, undefined, PUBLIC_IP);
    expect(result.ok && result.region).toBe('us');
    expect(storage.getUser('local')?.region).toBe('us');
  });

  it('falls back to this relay\'s region when the default region does not exist', async () => {
    geoCountry('US');
    const result = await backend('euwest').resolveLogin(OPEN, undefined, PUBLIC_IP);
    expect(result.ok && result.region).toBe('us');
  });

  it('keeps an existing user in their region', async () => {
    storage.upsertUser('local', 'local', 'open', undefined, 'us');
    geoCountry('US');
    const result = await backend('uswest').resolveLogin(OPEN, undefined, PUBLIC_IP);
    expect(result.ok && result.region).toBe('us');
    expect(storage.getUser('local')?.region).toBe('us');
  });
});
