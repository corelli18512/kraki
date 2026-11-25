/**
 * Operator test accounts (TEST_ACCOUNTS on the main head): QA sign-ins pinned
 * to a chosen region, without GitHub. Off unless configured.
 *
 * Each account is `{ login, region, tokenSha256 }`. Only the SHA-256 of the
 * token is configured; the token itself never reaches config or logs. A test
 * account's user id is `test:<login>` and its provider `test`, so it can never
 * be a GitHub account (numeric ids) and is easy to find and delete.
 */

import { createHash, timingSafeEqual } from 'crypto';
import type { AuthCredentials, AuthOutcome, AuthProvider } from './auth.js';
import { getLogger } from './logger.js';
import { metrics } from './metrics.js';

export interface TestAccount {
  /** `qa-` followed by lowercase letters, digits and dashes. */
  login: string;
  /** Region the account is assigned on its first sign-in. */
  region: string;
  /** Lowercase hex SHA-256 of the account's sign-in token. */
  tokenSha256: string;
}

export const TEST_ACCOUNT_PROVIDER = 'test';
export const TEST_ACCOUNT_LOGIN_PATTERN = /^qa-[a-z0-9][a-z0-9-]{0,36}$/;
const REGION_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function testAccountUserId(login: string): string {
  return `${TEST_ACCOUNT_PROVIDER}:${login}`;
}

/** Parse TEST_ACCOUNTS (a JSON array). Unset or blank: no test accounts.
 *  Throws on anything malformed, so a bad config stops the relay at start. */
export function parseTestAccounts(raw: string | undefined): TestAccount[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TEST_ACCOUNTS must be a JSON array');
  }
  if (!Array.isArray(parsed)) throw new Error('TEST_ACCOUNTS must be a JSON array');

  const accounts: TestAccount[] = [];
  for (const [i, entry] of parsed.entries()) {
    const where = `TEST_ACCOUNTS[${i}]`;
    if (typeof entry !== 'object' || entry === null) throw new Error(`${where} must be an object`);
    const { login, region, tokenSha256 } = entry as Record<string, unknown>;
    if (typeof login !== 'string' || !TEST_ACCOUNT_LOGIN_PATTERN.test(login)) {
      throw new Error(`${where}.login must start with "qa-" and use lowercase letters, digits and dashes (max 40 characters)`);
    }
    const regionCode = typeof region === 'string' ? region.trim().toLowerCase() : '';
    if (!REGION_CODE_PATTERN.test(regionCode)) throw new Error(`${where}.region must be a region code`);
    const hash = typeof tokenSha256 === 'string' ? tokenSha256.trim().toLowerCase() : '';
    if (!SHA256_HEX_PATTERN.test(hash)) throw new Error(`${where}.tokenSha256 must be 64 hex characters (SHA-256 of the token)`);
    if (accounts.some((a) => a.login === login)) throw new Error(`${where}: login "${login}" is listed twice`);
    if (accounts.some((a) => a.tokenSha256 === hash)) throw new Error(`${where}: tokenSha256 is shared with another account`);
    accounts.push({ login, region: regionCode, tokenSha256: hash });
  }
  return accounts;
}

/**
 * Accepts the token of a configured test account. Never advertised in
 * auth_info; reached through `{ method: 'apikey', key }` (released CLIs),
 * `request_pairing_token` and POST /api/test-login.
 */
export class TestAccountAuthProvider implements AuthProvider {
  readonly name = TEST_ACCOUNT_PROVIDER;
  private readonly accounts: Array<TestAccount & { digest: Buffer }>;

  constructor(accounts: TestAccount[]) {
    this.accounts = accounts.map((a) => ({ ...a, digest: Buffer.from(a.tokenSha256, 'hex') }));
  }

  get size(): number {
    return this.accounts.length;
  }

  isOwnSecret(token: string): boolean {
    return this.match(token) !== undefined;
  }

  async authenticate(credentials: AuthCredentials): Promise<AuthOutcome> {
    const account = credentials.token ? this.match(credentials.token) : undefined;
    if (!account) {
      metrics().inc('auth.testAccount.fail');
      getLogger().warn('Test account auth failed', { ip: credentials.ip });
      return { ok: false, message: 'Invalid test account token' };
    }
    metrics().inc('auth.testAccount.ok');
    getLogger().info('Test account signed in', { login: account.login, region: account.region, ip: credentials.ip });
    return {
      ok: true,
      user: {
        id: testAccountUserId(account.login),
        login: account.login,
        provider: TEST_ACCOUNT_PROVIDER,
        region: account.region,
      },
    };
  }

  /** Constant time in which account (if any) matches. */
  private match(token: string): TestAccount | undefined {
    if (typeof token !== 'string') return undefined; // a client's malformed auth payload
    const digest = createHash('sha256').update(token, 'utf8').digest();
    let found: TestAccount | undefined;
    for (const account of this.accounts) {
      if (timingSafeEqual(digest, account.digest) && !found) found = account;
    }
    return found;
  }
}
