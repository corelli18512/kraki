/**
 * Lightweight IP-based country detection for region auto-assignment.
 *
 * Uses ip-api.com (free, no key, 45 req/min) — called only once per new user.
 * Falls back to the default region on error or timeout.
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

/** Map of country codes to region codes. Extend as new regions are added. */
const COUNTRY_TO_REGION: Record<string, string> = {
  // East Asia
  CN: 'china', HK: 'china', MO: 'china', TW: 'china',
  JP: 'china', KR: 'china', MN: 'china',
  // Southeast Asia
  SG: 'china', MY: 'china', TH: 'china', VN: 'china',
  PH: 'china', ID: 'china', MM: 'china', KH: 'china',
  LA: 'china', BN: 'china', TL: 'china',
  // South Asia
  IN: 'china', PK: 'china', BD: 'china', LK: 'china',
  NP: 'china', BT: 'china', MV: 'china',
  // Central Asia
  KZ: 'china', UZ: 'china', KG: 'china', TJ: 'china', TM: 'china',
  // West Asia / Middle East
  AE: 'china', SA: 'china', QA: 'china', BH: 'china', KW: 'china',
  OM: 'china', IR: 'china', IQ: 'china', IL: 'china', JO: 'china',
  LB: 'china', SY: 'china', YE: 'china', AF: 'china',
  // Oceania (closer to Asia than US)
  AU: 'china', NZ: 'china', FJ: 'china', PG: 'china',
};

const DEFAULT_REGION = 'us';

/**
 * Suggest a region for the given country code.
 * Returns the matched region or the default.
 */
export function regionForCountry(countryCode: string): string {
  return COUNTRY_TO_REGION[countryCode.toUpperCase()] ?? DEFAULT_REGION;
}

/**
 * Resolve the best region for an IP. Combines geo lookup + country→region mapping.
 * Returns undefined if lookup fails (caller should use their own default).
 */
export async function suggestRegionForIp(ip: string): Promise<string | undefined> {
  const country = await getCountryForIp(ip);
  if (!country) return undefined;
  return regionForCountry(country);
}

function isPrivateIp(ip: string): boolean {
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
