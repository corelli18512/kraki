/**
 * Remote auth backend — delegates auth to a remote Account Service via REST.
 * Used when head runs in connected mode (--account-url flag).
 */

import type { AuthMethod, DeviceInfo } from '@kraki/protocol';
import type { AuthBackend, AuthOutcome, AuthResult, ChallengeOutcome, AuthInfoConfig } from './auth-backend.js';
import { authLogField, getLogger } from './logger.js';
import { EdgeAuthCache, isDeviceRejection } from './edge-auth-cache.js';
import { metrics } from './metrics.js';
import { REQUEST_ID_HEADER, newRequestId } from './request-id.js';

/** An account service call slower than this logs at info (with its request id). */
export const SLOW_ACCOUNT_REQUEST_MS = 2_000;

/** The device an account service request is about, for its log lines. */
function requestDeviceId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { deviceId, device } = body as { deviceId?: unknown; device?: { deviceId?: unknown } };
  if (typeof deviceId === 'string') return deviceId;
  return typeof device?.deviceId === 'string' ? device.deviceId : undefined;
}

/** A device the account service no longer accepts here. */
export interface EdgeRevocation {
  deviceId: string;
  code: string;
  message: string;
  redirect?: string;
  /** Only an older session is meant: a newer answer for the device is being
   *  applied right now, so keep this edge's device mirror. */
  supersededOnly?: boolean;
}

/** Status poll interval for cached devices (see EdgeAuthCache). */
export const DEVICE_STATUS_POLL_MS = 5 * 60_000;

export interface RemoteAuthBackendOptions {
  /** Account Service base URL (e.g., http://localhost:5000) */
  accountUrl: string;
  /** Service API key for authenticating with Account Service */
  serviceKey: string;
  /** Request timeout in ms. Default: 15000 */
  timeout?: number;
}

export class RemoteAuthBackend implements AuthBackend {
  private accountUrl: string;
  private serviceKey: string;
  private timeout: number;
  private cachedConfig: AuthInfoConfig | null = null;
  /** Edge-local challenge auth (EdgeAuthCache). Off until the account service
   *  has answered a device status poll: without revocations, no local trust. */
  private edgeCache?: EdgeAuthCache;
  /** Kept across stop/start: a nonce this edge issued must stay recognised
   *  (and single-use) even after local auth is switched off. */
  private nonceSource?: EdgeAuthCache;
  private edgeRegion?: string;
  private localAuthReady = false;
  private statusTimer?: ReturnType<typeof setInterval>;
  /** Bumped by start/stop: in-flight status polls and checks of an older
   *  lifecycle are dropped when they land. */
  private lifecycle = 0;
  /** The account service rejected a device that may be connected here. */
  onRevoked?: (revocation: EdgeRevocation) => void;
  /** Whether a device has a live connection here; unset keeps every cached
   *  row in the status poll (see EdgeAuthCache.pruneStale). */
  isConnected?: (deviceId: string) => boolean;

  constructor(options: RemoteAuthBackendOptions) {
    this.accountUrl = options.accountUrl.replace(/\/+$/, '');
    this.serviceKey = options.serviceKey;
    this.timeout = options.timeout ?? 15_000;
  }

  /** Turn on edge-local challenge auth. Starts the device status poll. */
  enableLocalChallenge(cache: EdgeAuthCache, region: string | undefined, pollMs = DEVICE_STATUS_POLL_MS): Promise<void> {
    this.stopLocalChallenge();
    this.edgeCache = cache;
    this.nonceSource = cache;
    this.edgeRegion = region;
    const lifecycle = this.lifecycle;
    this.statusTimer = setInterval(() => { void this.pollDeviceStatus(); }, pollMs);
    this.statusTimer.unref?.();
    return lifecycle === this.lifecycle ? this.pollDeviceStatus() : Promise.resolve();
  }

  /** Turn edge-local auth off. Work still in flight is ignored when it lands. */
  stopLocalChallenge(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = undefined;
    this.localAuthReady = false;
    this.edgeCache = undefined;
    this.lifecycle++;
  }

  get localChallengeActive(): boolean { return this.localAuthReady && this.edgeCache !== undefined; }

  /** This edge dropped a device (removed here, account deleted): never trust
   *  it locally again until the account service vouches for it afresh. */
  forgetLocalTrust(deviceId: string): void {
    this.edgeCache?.forget(deviceId);
  }

  /** Drop local trust unless it is already the new owner's (whose fresh
   *  answer may have been stored just before the old mirror is retired). */
  forgetLocalTrustUnlessOwnedBy(deviceId: string, userId: string): void {
    if (this.edgeCache?.identity(deviceId)?.userId === userId) return;
    this.edgeCache?.forget(deviceId);
  }

  /** Ask the account service about every cached device; forget and kick the
   *  ones it no longer accepts here. */
  async pollDeviceStatus(only?: string): Promise<void> {
    const cache = this.edgeCache;
    if (!cache) return;
    const lifecycle = this.lifecycle;
    // Rows too old for local sign-in only matter while their device is
    // connected (a revocation must still kick it); the rest would be polled forever.
    if (only === undefined) cache.pruneStale((deviceId) => this.isConnected?.(deviceId) ?? true);
    // Identity and epoch captured together, before any request is out.
    const entries = cache.entries().filter((e) => only === undefined || e.deviceId === only)
      .map((e) => ({ ...e, epoch: cache.epoch(e.deviceId) }));
    if (only !== undefined && entries.length === 0) return;
    const statuses = new Map<string, { status: string; redirect?: string; epoch: number }>();
    // Always at least one request (an empty list still proves support).
    // ~130 bytes per device: 300 stays well under the account API body limit.
    for (let i = 0; i === 0 || i < entries.length; i += 300) {
      const chunk = entries.slice(i, i + 300);
      const epochs = chunk.map((e) => e.epoch);
      const res = await this.post<{ ok?: boolean; statuses?: unknown; redirects?: unknown; code?: string }>('/api/devices/status', {
        devices: chunk.map((e) => ({ id: e.deviceId, userId: e.userId, keyFingerprint: e.keyFingerprint })),
        headRegion: this.edgeRegion,
      });
      if (lifecycle !== this.lifecycle) return; // stopped meanwhile
      if (!res || typeof res.statuses !== 'object' || res.statuses === null) {
        // Unreachable or failing keeps the current mode (entries still age
        // out after maxStaleMs); an account service without the endpoint
        // (404/405, or a 200 without statuses) switches local trust off.
        const transient = res?.code === 'service_unavailable' || res?.code === 'internal_error' || res?.code === 'rate_limited';
        if (!transient && this.localAuthReady) {
          getLogger().warn('Account service has no device status endpoint; edge-local auth off', { code: res?.code });
          this.localAuthReady = false;
        }
        return;
      }
      const answered = res.statuses as Record<string, unknown>;
      const redirects = (typeof res.redirects === 'object' && res.redirects !== null ? res.redirects : {}) as Record<string, unknown>;
      chunk.forEach((e, j) => {
        // Only answers for exactly what was asked (own properties: an id like
        // `__proto__` must not slip through), and only if the device was not
        // dropped while the request was out.
        if (epochs[j] !== cache.epoch(e.deviceId)) return;
        const raw = Object.prototype.hasOwnProperty.call(answered, e.deviceId) ? answered[e.deviceId] : undefined;
        const redirect = Object.prototype.hasOwnProperty.call(redirects, e.deviceId) ? redirects[e.deviceId] : undefined;
        statuses.set(e.deviceId, {
          // No answer for a device: not proof of anything, but no basis to
          // keep trusting it locally either.
          status: typeof raw === 'string' ? raw : 'unanswered',
          redirect: typeof redirect === 'string' ? redirect : undefined,
          epoch: epochs[j],
        });
      });
    }
    if (!this.localAuthReady) getLogger().info('Edge-local challenge auth enabled', { cached: entries.length });
    this.localAuthReady = true;
    for (const [deviceId, { status, redirect, epoch }] of statuses) {
      // Re-authenticated or dropped while later chunks were out: newer facts win.
      if (epoch !== cache.epoch(deviceId)) continue;
      if (status === 'ok') continue;
      cache.forget(deviceId);
      if (status === 'unanswered') continue;
      metrics().inc('auth.localRevoked');
      this.onRevoked?.({ deviceId, code: status, message: 'Device no longer accepted', redirect });
    }
  }

  async authenticate(
    auth: AuthMethod,
    device: DeviceInfo,
    headRegion?: string,
    clientIp?: string,
  ): Promise<AuthOutcome> {
    const cache = this.edgeCache;
    const epoch = device.deviceId && cache ? cache.epoch(device.deviceId) : undefined;
    const drops = device.deviceId && cache ? cache.dropCount(device.deviceId) : undefined;
    const clock = cache?.clock() ?? 0;
    // The account service throttles failed logins per client IP; forward the
    // end user's address, not this edge's.
    const result = await this.post<AuthOutcome>('/api/auth', { auth, device, headRegion, ...(clientIp && { clientIp }) });
    // A token / pairing sign-in is as authoritative as a verified challenge:
    // the next reconnect of this device can be local.
    // A request that did not name the device (first pairing: the account
    // service assigns the id) is fenced by the trust clock instead.
    const unnamedButStale = result.ok && cache && device.deviceId !== result.deviceId && cache.changedSince(result.deviceId, clock);
    if (unnamedButStale || (result.ok && cache && cache === this.edgeCache
      && this.storeAuthoritative(cache, result, device.deviceId === result.deviceId ? epoch : undefined) === 'stale')) {
      // The device was dropped here (removed, account deleted) while this
      // sign-in was out: do not let it complete. Retryable (a retry gets the
      // account service's current answer) unless the account is gone.
      if (cache?.isTombstoned(result.ok ? result.deviceId : '')) {
        return { ok: false, code: 'account_deleted', message: 'This Kraki account was deleted.' };
      }
      const newer = result.ok && !unnamedButStale && drops !== undefined ? cache?.newerAnswerFor(result, drops) : undefined;
      if (newer) return { ...newer, authMethod: result.authMethod };
      return { ok: false, code: 'service_unavailable', message: 'Device changed during sign-in, try again' };
    }
    return result;
  }

  async startChallenge(
    deviceId: string,
    encryptionKey?: string,
    headRegion?: string,
    signingKey?: string,
  ): Promise<ChallengeOutcome> {
    const cached = this.localChallengeActive ? this.edgeCache!.lookup(deviceId) : undefined;
    // A new encryption or signing key must reach the account service, which
    // only takes answers to nonces it issued itself: ask it for the challenge
    // too. (A Tentacle with a new signing key needs its real invalid_signature
    // to fall back to token sign-in.)
    const sameEncryption = encryptionKey === undefined || encryptionKey === cached?.encryptionKey;
    const sameSigning = signingKey === undefined || sameKey(signingKey, cached?.publicKey);
    if (cached && sameEncryption && sameSigning) {
      metrics().inc('auth.localChallenge');
      return { ok: true, nonce: this.edgeCache!.issueNonce(deviceId), userId: cached.userId, deviceId };
    }
    return this.post('/api/auth/challenge', { deviceId, encryptionKey, headRegion });
  }

  async verifyChallenge(
    deviceId: string,
    nonce: string,
    signature: string,
    encryptionKey?: string,
    headRegion?: string,
  ): Promise<AuthOutcome> {
    const cache = this.edgeCache;
    const check = (cache ?? this.nonceSource)?.checkNonce(nonce, deviceId) ?? 'unknown';
    if (check === 'expired' || check === 'foreign') {
      // Issued by this edge, but stale, reused or for another device. The
      // account service never saw it; retryable so the client asks again.
      return { ok: false, code: 'service_unavailable', message: 'Challenge expired, sign in again' };
    }
    if (check === 'local') {
      const cached = this.localChallengeActive ? cache!.lookup(deviceId) : undefined;
      const sameKeys = cached !== undefined && (encryptionKey === undefined || encryptionKey === cached.encryptionKey);
      if (cached && sameKeys && cache!.verifySignature(cached, nonce, signature)) {
        // Single use (nothing since checkNonce awaited).
        cache!.acceptNonce(nonce);
        metrics().inc('auth.localVerify');
        if (cache!.claimRevalidation(deviceId)) {
          // The account service only verifies nonces it issued, so the
          // background re-check asks for this device's status instead.
          void this.pollDeviceStatus(deviceId);
        }
        return { ...cached.result, authMethod: 'challenge', local: true };
      }
      // A key not announced at startChallenge, a rotated signing key, or
      // trust lapsed meanwhile: the account service decides. It did not
      // issue this nonce, so the best it answers is a device verdict
      // (removed, account deleted) or a retryable refusal.
    }
    const epoch = cache?.epoch(deviceId);
    const drops = cache?.dropCount(deviceId);
    const result = await this.post<AuthOutcome>('/api/auth/verify', { deviceId, nonce, signature, encryptionKey, headRegion });
    if (cache && cache === this.edgeCache) {
      if (result.ok && this.storeAuthoritative(cache, result, epoch) === 'stale') {
        // Lost only to a newer answer for the same identity (the client
        // retried a slow sign-in): sign in with that one.
        const newer = cache.newerAnswerFor(result, drops!);
        if (newer) return { ...newer, authMethod: result.authMethod };
        return { ok: false, code: 'service_unavailable', message: 'Device changed during sign-in, try again' };
      }
      // Only a verdict about the device drops trust (a wrong signature from
      // another socket must not), and then any live session goes with it.
      // ...and only if nothing newer happened to the device while it was out.
      if (!result.ok && isDeviceRejection(result.code) && epoch === cache.epoch(deviceId)) {
        this.rejectDevice(cache, deviceId, result.code, result.message,
          result.code === 'wrong_region' ? (result as { redirect?: string }).redirect : undefined);
      }
    }
    return result;
  }

  /**
   * Store an authoritative answer. If it replaces the account or key a live
   * session may have signed in under, that session must go too (it would
   * otherwise keep running on trust the polls no longer check).
   */
  private storeAuthoritative(cache: EdgeAuthCache, result: AuthResult, epoch: number | undefined): 'stored' | 'stale' | 'skipped' {
    const before = cache.identity(result.deviceId);
    const stored = cache.remember(result, epoch);
    if (stored !== 'stored' || !before) return stored;
    const after = cache.identity(result.deviceId);
    if (after && (after.userId !== before.userId || after.keyFingerprint !== before.keyFingerprint)) {
      this.onRevoked?.({
        deviceId: result.deviceId,
        code: after.userId !== before.userId ? 'unknown_device' : 'key_changed',
        message: 'Device signed in again with another key or account',
        supersededOnly: true,
      });
    }
    return stored;
  }

  /** A device-level rejection seen on a foreground sign-in: drop trust and
   *  retire any session still running on it. */
  private rejectDevice(cache: EdgeAuthCache, deviceId: string, code: string, message: string, redirect?: string): void {
    const trusted = cache.identity(deviceId) !== undefined;
    cache.forget(deviceId);
    if (!trusted) return;
    metrics().inc('auth.localRevoked');
    this.onRevoked?.({ deviceId, code, message, redirect });
  }

  createPairingToken(userId: string): { token: string; expiresIn: number } {
    // Pairing tokens are managed by the remote account service.
    // This synchronous method can't call REST, so we throw.
    // HeadServer should use createPairingTokenAsync instead.
    throw new Error('Use createPairingTokenAsync for remote backend');
  }

  /** Async version of createPairingToken for remote backend. */
  async createPairingTokenAsync(userId: string): Promise<{ token: string; expiresIn: number }> {
    const result = await this.post<{ token: string; expiresIn: number }>('/api/pairing/create', { userId });
    return result;
  }

  async removeDevice(userId: string, deviceId: string): Promise<boolean> {
    const result = await this.post<{ ok: boolean }>('/api/devices/remove', { userId, deviceId });
    return result.ok === true;
  }

  async renameDevice(userId: string, deviceId: string, displayName: string | null): Promise<boolean> {
    const result = await this.post<{ ok: boolean }>('/api/devices/rename', { userId, deviceId, displayName });
    return result.ok === true;
  }

  async deleteAccount(userId: string): Promise<string[]> {
    const result = await this.post<{ ok: boolean; deviceIds?: string[]; message?: string }>('/api/account/delete', { userId });
    if (result.ok !== true) throw new Error(result.message ?? 'Account service did not delete the account');
    return Array.isArray(result.deviceIds) ? result.deviceIds : [];
  }

  async requestPairingToken(
    token: string,
    ip?: string,
  ): Promise<{ ok: true; userId: string; pairingToken: string; expiresIn: number } | { ok: false; code: string; message: string }> {
    return this.post('/api/pairing/request', { token, ip });
  }

  getAuthInfo(): AuthInfoConfig {
    if (this.cachedConfig) return this.cachedConfig;
    // Return empty until refreshConfig is called
    return { methods: ['challenge'] };
  }

  /** Fetch config from Account Service. Call on startup and periodically. */
  async refreshConfig(): Promise<AuthInfoConfig> {
    const logger = getLogger();
    try {
      const config = await this.get<AuthInfoConfig>('/api/config');
      this.cachedConfig = config;
      return config;
    } catch (err) {
      logger.warn('Failed to fetch account service config', { error: (err as Error).message });
      return this.getAuthInfo();
    }
  }

  /**
   * Idempotently announce this edge's region + relay URL to the account
   * service. Called on startup so a changed `PUBLIC_RELAY_URL` propagates
   * to `/api/regions` without manual intervention. Does NOT rotate the
   * service key.
   */
  async announceRegion(
    region: string,
    relayUrl: string,
    displayName?: string,
  ): Promise<{ ok: boolean; code?: string; message?: string }> {
    const logger = getLogger();
    try {
      const result = await this.post<{ ok: boolean; code?: string; message?: string }>(
        '/api/edge/announce',
        { region, relayUrl, ...(displayName && { displayName }) },
      );
      if (!result.ok) {
        logger.warn('Edge announce rejected', { region, relayUrl, code: result.code, message: result.message });
      }
      return result;
    } catch (err) {
      logger.warn('Edge announce failed', { error: (err as Error).message });
      return { ok: false, code: 'service_unavailable', message: (err as Error).message };
    }
  }

  // ── HTTP helpers ──────────────────────────────────────

  private async post<T = AuthOutcome>(path: string, body: unknown): Promise<T> {
    const logger = getLogger();
    const url = `${this.accountUrl}${path}`;
    const reqId = newRequestId();
    const startedAt = performance.now();
    const deviceId = requestDeviceId(body);
    // Where a failure happened: before the response headers, or reading the body.
    let phase: 'headers' | 'body' = 'headers';

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.serviceKey}`,
          [REQUEST_ID_HEADER]: reqId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      });

      phase = 'body';
      const text = await response.text();
      const ms = Math.round(performance.now() - startedAt);
      const fields = { path, reqId, status: response.status, ms, ...(deviceId && { deviceId: authLogField(deviceId) }) };
      if (ms >= SLOW_ACCOUNT_REQUEST_MS) logger.info('Account service request slow', fields);
      else logger.debug('Account service request', fields);
      try {
        return JSON.parse(text) as T;
      } catch {
        // Not JSON: an endpoint this account service does not have (404/405)
        // is different from a transient failure.
        const unsupported = response.status === 404 || response.status === 405;
        if (!unsupported) logger.error('Account service returned non-JSON', fields);
        return { ok: false, code: unsupported ? 'not_supported' : 'service_unavailable', message: `HTTP ${response.status}` } as T;
      }
    } catch (err) {
      const cause = (err as { cause?: { code?: unknown } }).cause?.code;
      logger.error('Account service request failed', {
        path, reqId, ms: Math.round(performance.now() - startedAt), phase,
        ...(deviceId && { deviceId: authLogField(deviceId) }),
        error: (err as Error).message,
        ...(typeof cause === 'string' && { cause }),
      });
      return { ok: false, code: 'service_unavailable', message: 'Account service unavailable' } as T;
    }
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.accountUrl}${path}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${this.serviceKey}`, [REQUEST_ID_HEADER]: newRequestId() },
      signal: AbortSignal.timeout(this.timeout),
    });
    return response.json() as Promise<T>;
  }
}

/** Same public key, whatever the armour/whitespace (compact base64 or PEM). */
function sameKey(a: string, b: string | undefined): boolean {
  if (b === undefined) return false;
  const norm = (k: string) => k.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return norm(a) === norm(b);
}
