// ------------------------------------------------------------
// Auth abstraction — extensible for multiple providers
// ------------------------------------------------------------

import { timingSafeEqual } from 'crypto';
import { getLogger } from './logger.js';

/** Timing-safe string comparison to prevent timing attacks on secrets */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export interface AuthUser {
  id: string;
  login: string;
  provider: string;
  email?: string;
}

export interface AuthSuccess {
  ok: true;
  user: AuthUser;
}

export interface AuthFailure {
  ok: false;
  message: string;
}

export type AuthOutcome = AuthSuccess | AuthFailure;

/**
 * Abstract auth provider. Extend this to support different auth methods.
 * The head calls `authenticate()` with whatever credentials the device sends.
 */
export interface AuthProvider {
  /** Unique provider name (e.g., 'github', 'open', 'apikey') */
  readonly name: string;
  /** Validate credentials and return user info */
  authenticate(credentials: AuthCredentials): Promise<AuthOutcome>;
}

/** Credentials a device can send */
export interface AuthCredentials {
  token?: string;
  channelKey?: string;
  /** GitHub OAuth authorization code (exchanged for access token) */
  githubCode?: string;
  /** IP address of the connecting device (set by the server, not the client) */
  ip?: string;
}

// --- Built-in providers ---

/**
 * GitHub OAuth token provider.
 * Validates token against api.github.com/user.
 * Optionally exchanges an OAuth authorization code for an access token.
 */
export class GitHubAuthProvider implements AuthProvider {
  readonly name = 'github';
  private fetcher: typeof fetch;
  private clientId?: string;
  private clientSecret?: string;

  constructor(opts?: { fetcher?: typeof fetch; clientId?: string; clientSecret?: string }) {
    this.fetcher = opts?.fetcher ?? globalThis.fetch;
    this.clientId = opts?.clientId;
    this.clientSecret = opts?.clientSecret;
  }

  /** Whether OAuth code exchange is configured */
  get oauthConfigured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  /** Get the configured OAuth client ID (for auth_info_response) */
  getClientId(): string | undefined {
    return this.clientId;
  }

  /**
   * Exchange a GitHub OAuth authorization code for an access token.
   * Requires clientId and clientSecret to be configured.
   */
  async exchangeCode(code: string): Promise<{ ok: true; token: string } | { ok: false; message: string }> {
    if (!this.clientId || !this.clientSecret) {
      return { ok: false, message: 'GitHub OAuth not configured (missing client_id/client_secret)' };
    }

    try {
      const res = await this.fetcher('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code,
        }),
      });

      if (!res.ok) {
        return { ok: false, message: `GitHub OAuth token exchange returned ${res.status}` };
      }

      const data = await res.json() as Record<string, unknown>;
      if (data.error) {
        return { ok: false, message: `GitHub OAuth error: ${data.error_description || data.error}` };
      }
      if (typeof data.access_token !== 'string') {
        return { ok: false, message: 'GitHub OAuth response missing access_token' };
      }

      return { ok: true, token: data.access_token };
    } catch (err) {
      return { ok: false, message: `GitHub OAuth exchange failed: ${(err as Error).message}` };
    }
  }

  async authenticate(credentials: AuthCredentials): Promise<AuthOutcome> {
    let token = credentials.token;

    // If a GitHub OAuth code is provided, exchange it for an access token first
    if (!token && credentials.githubCode) {
      const exchange = await this.exchangeCode(credentials.githubCode);
      if (!exchange.ok) {
        return { ok: false, message: exchange.message };
      }
      token = exchange.token;
    }

    if (!token) {
      return { ok: false, message: 'Token required for GitHub auth' };
    }

    try {
      const res = await this.fetcher('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'kraki-head',
        },
      });

      if (!res.ok) {
        getLogger().warn('GitHub auth failed', { status: res.status, ip: credentials.ip });
        return { ok: false, message: `GitHub API returned ${res.status}` };
      }

      const data = await res.json() as Record<string, unknown>;
      if (!data.id || !data.login) {
        return { ok: false, message: 'Unexpected GitHub API response' };
      }
      return {
        ok: true,
        user: { id: String(data.id), login: String(data.login), provider: 'github', email: typeof data.email === 'string' ? data.email : undefined },
      };
    } catch (err) {
      return { ok: false, message: `GitHub API request failed: ${(err as Error).message}` };
    }
  }
}

/**
 * Open provider for self-hosted mode. No validation — all connections accepted.
 * Optionally accepts a shared key so tentacles, head, and apps can use the same
 * secret to form a trusted group without full OAuth.
 *
 * TODO: Support multi-user on self-hosted without OAuth (e.g., local user registry)
 */
export class OpenAuthProvider implements AuthProvider {
  readonly name = 'open';
  private sharedKey?: string;

  constructor(sharedKey?: string) {
    this.sharedKey = sharedKey;
  }

  async authenticate(credentials: AuthCredentials): Promise<AuthOutcome> {
    if (this.sharedKey) {
      if (!credentials.token || !safeEqual(credentials.token, this.sharedKey)) {
        getLogger().warn('Open auth failed: invalid shared key', { ip: credentials.ip });
        return { ok: false, message: 'Invalid shared key' };
      }
    }
    return {
      ok: true,
      user: { id: 'local', login: 'local', provider: 'open' },
    };
  }
}

/**
 * Static API key provider for self-hosted relays that want basic protection.
 * Set a key in env/config, devices must send matching key.
 */
export class ApiKeyAuthProvider implements AuthProvider {
  readonly name = 'apikey';
  private validKey: string;

  constructor(validKey: string) {
    this.validKey = validKey;
  }

  async authenticate(credentials: AuthCredentials): Promise<AuthOutcome> {
    if (!credentials.token || !safeEqual(credentials.token, this.validKey)) {
      getLogger().warn('API key auth failed', { ip: credentials.ip });
      return { ok: false, message: 'Invalid API key' };
    }
    return {
      ok: true,
      user: { id: 'apikey-user', login: 'apikey-user', provider: 'apikey' },
    };
  }
}

// --- Auth throttle ---

/**
 * Simple per-IP throttle for auth attempts.
 * Wraps any AuthProvider and rejects after maxAttempts failures within windowMs.
 */
export class ThrottledAuthProvider implements AuthProvider {
  get name() { return this.inner.name; }
  private inner: AuthProvider;
  private maxAttempts: number;
  private windowMs: number;
  private failures = new Map<string, { count: number; firstAt: number }>();

  constructor(inner: AuthProvider, maxAttempts = 5, windowMs = 60_000) {
    this.inner = inner;
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  async authenticate(credentials: AuthCredentials): Promise<AuthOutcome> {
    const ip = credentials.ip ?? 'unknown';
    const now = Date.now();
    const record = this.failures.get(ip);

    if (record) {
      if (now - record.firstAt > this.windowMs) {
        this.failures.delete(ip);
      } else if (record.count >= this.maxAttempts) {
        getLogger().warn('Auth throttled', { ip, attempts: record.count });
        return { ok: false, message: 'Too many auth attempts. Try again later.' };
      }
    }

    const result = await this.inner.authenticate(credentials);

    if (!result.ok) {
      const existing = this.failures.get(ip);
      if (existing) {
        existing.count++;
      } else {
        this.failures.set(ip, { count: 1, firstAt: now });
      }
    } else {
      this.failures.delete(ip);
    }

    return result;
  }

  /** Remove stale entries to prevent memory growth on long-running servers. */
  cleanup(): void {
    const now = Date.now();
    for (const [ip, record] of this.failures) {
      if (now - record.firstAt > this.windowMs) {
        this.failures.delete(ip);
      }
    }
  }
}
