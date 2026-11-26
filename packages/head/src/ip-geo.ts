/**
 * Lightweight IP-based country detection for region auto-assignment.
 *
 * Uses ip-api.com (free, no key, 45 req/min) — called only once per new user.
 * On error or timeout there is no suggestion; callers then use their own
 * fallback (the main head's REGION).
 */

import { getLogger } from './logger.js';

const IP_API_TIMEOUT = 3000;

/**
 * Look up the country code for an IP address.
 * Returns ISO 3166-1 alpha-2 code (e.g., 'CN', 'US') or undefined on failure.
 */
export async function getCountryForIp(ip: string): Promise<string | undefined> {
  const logger = getLogger();

  // Skip private/local IPs
  if (isPrivateIp(ip)) return undefined;

  try {
    const response = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode`, {
      signal: AbortSignal.timeout(IP_API_TIMEOUT),
    });
    const data = await response.json() as { status: string; countryCode?: string };
    if (data.status === 'success' && data.countryCode) {
      return data.countryCode;
    }
  } catch (err) {
    logger.debug('IP geo lookup failed', { ip, error: (err as Error).message });
  }
  return undefined;
}

/** Region code of the Tokyo relay. It kept its legacy code `us`. */
const ASIA_PACIFIC_REGION = 'us';

/** Region of countries not in COUNTRY_TO_REGION when the operator configures
 *  none (DEFAULT_SIGNUP_REGION). */
export const DEFAULT_SIGNUP_REGION = 'us';

/**
 * Country → region for new accounts. Countries not listed (the Americas,
 * Europe, Africa) and unknown codes get the default signup region.
 */
const COUNTRY_TO_REGION: Record<string, string> = {
  // Greater China
  CN: 'china', HK: 'china', MO: 'china', TW: 'china',
  // East Asia
  JP: ASIA_PACIFIC_REGION, KR: ASIA_PACIFIC_REGION, MN: ASIA_PACIFIC_REGION,
  // Southeast Asia
  SG: ASIA_PACIFIC_REGION, MY: ASIA_PACIFIC_REGION, TH: ASIA_PACIFIC_REGION, VN: ASIA_PACIFIC_REGION,
  PH: ASIA_PACIFIC_REGION, ID: ASIA_PACIFIC_REGION, MM: ASIA_PACIFIC_REGION, KH: ASIA_PACIFIC_REGION,
  LA: ASIA_PACIFIC_REGION, BN: ASIA_PACIFIC_REGION, TL: ASIA_PACIFIC_REGION,
  // South Asia
  IN: ASIA_PACIFIC_REGION, PK: ASIA_PACIFIC_REGION, BD: ASIA_PACIFIC_REGION, LK: ASIA_PACIFIC_REGION,
  NP: ASIA_PACIFIC_REGION, BT: ASIA_PACIFIC_REGION, MV: ASIA_PACIFIC_REGION,
  // Central Asia
  KZ: ASIA_PACIFIC_REGION, UZ: ASIA_PACIFIC_REGION, KG: ASIA_PACIFIC_REGION, TJ: ASIA_PACIFIC_REGION,
  TM: ASIA_PACIFIC_REGION,
  // West Asia / Middle East
  AE: ASIA_PACIFIC_REGION, SA: ASIA_PACIFIC_REGION, QA: ASIA_PACIFIC_REGION, BH: ASIA_PACIFIC_REGION,
  KW: ASIA_PACIFIC_REGION, OM: ASIA_PACIFIC_REGION, IR: ASIA_PACIFIC_REGION, IQ: ASIA_PACIFIC_REGION,
  IL: ASIA_PACIFIC_REGION, JO: ASIA_PACIFIC_REGION, LB: ASIA_PACIFIC_REGION, PS: ASIA_PACIFIC_REGION,
  SY: ASIA_PACIFIC_REGION, YE: ASIA_PACIFIC_REGION, AF: ASIA_PACIFIC_REGION,
  // Oceania (French Polynesia, nearer the Americas, stays on the default)
  AU: ASIA_PACIFIC_REGION, NZ: ASIA_PACIFIC_REGION, FJ: ASIA_PACIFIC_REGION, PG: ASIA_PACIFIC_REGION,
  GU: ASIA_PACIFIC_REGION, MP: ASIA_PACIFIC_REGION, PW: ASIA_PACIFIC_REGION, FM: ASIA_PACIFIC_REGION,
  MH: ASIA_PACIFIC_REGION, KI: ASIA_PACIFIC_REGION, NR: ASIA_PACIFIC_REGION, TV: ASIA_PACIFIC_REGION,
  NC: ASIA_PACIFIC_REGION, VU: ASIA_PACIFIC_REGION, SB: ASIA_PACIFIC_REGION, TO: ASIA_PACIFIC_REGION,
  WS: ASIA_PACIFIC_REGION,
};

/**
 * Suggest a region for the given country code: its mapped region, or
 * `defaultRegion` for countries not mapped.
 */
export function regionForCountry(countryCode: string, defaultRegion: string = DEFAULT_SIGNUP_REGION): string {
  return COUNTRY_TO_REGION[countryCode.toUpperCase()] ?? defaultRegion;
}

/**
 * Resolve the best region for an IP. Combines geo lookup + country→region mapping.
 * Returns undefined if lookup fails (caller should use their own default).
 */
export async function suggestRegionForIp(ip: string, defaultRegion: string = DEFAULT_SIGNUP_REGION): Promise<string | undefined> {
  const country = await getCountryForIp(ip);
  if (!country) return undefined;
  return regionForCountry(country, defaultRegion);
}

export function isPrivateIp(ip: string): boolean {
  // Strip IPv6 prefix
  const clean = ip.replace(/^::ffff:/, '');
  if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost') return true;
  const parts = clean.split('.');
  if (parts.length !== 4) return false;
  const first = parseInt(parts[0], 10);
  const second = parseInt(parts[1], 10);
  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  return false;
}
