/**
 * Remote auth backend — delegates auth to a remote Account Service via REST.
 * Used when head runs in connected mode (--account-url flag).
 */

import type { AuthMethod, DeviceInfo } from '@kraki/protocol';
import type { AuthBackend, AuthOutcome, AuthResult, ChallengeOutcome, AuthInfoConfig } from './auth-backend.js';
import { getLogger } from './logger.js';
import { EdgeAuthCache, isDefinitiveRejection } from './edge-auth-cache.js';
import { metrics } from './metrics.js';

/** A device the account service no longer accepts here. */
export interface EdgeRevocation {
  deviceId: string;
  code: string;
  message: string;
  redirect?: string;
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
  private edgeRegion?: string;
  private localAuthReady = false;
  private statusTimer?: ReturnType<typeof setInterval>;
  /** The account service rejected a device that may be connected here. */
  onRevoked?: (revocation: EdgeRevocation) => void;
  /** A background re-verification returned a fresher result (devices, prefs).
   *  `context` is what `revalidationContext` returned when it started. */
  onRefreshed?: (result: AuthResult, context: unknown) => void;
  revalidationContext?: () => unknown;

  constructor(options: RemoteAuthBackendOptions) {
    this.accountUrl = options.accountUrl.replace(/\/+$/, '');
    this.serviceKey = options.serviceKey;
    this.timeout = options.timeout ?? 15_000;
  }

  /** Turn on edge-local challenge auth. Starts the device status poll. */
  enableLocalChallenge(cache: EdgeAuthCache, region: string | undefined, pollMs = DEVICE_STATUS_POLL_MS): Promise<void> {
    this.edgeCache = cache;
    this.edgeRegion = region;
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = setInterval(() => { void this.pollDeviceStatus(); }, pollMs);
    this.statusTimer.unref?.();
    return this.pollDeviceStatus();
  }

  stopLocalChallenge(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = undefined;
    this.localAuthReady = false;
  }

  get localChallengeActive(): boolean { return this.localAuthReady && this.edgeCache !== undefined; }

  /** Ask the account service about every cached device; forget and kick the
   *  ones it no longer accepts here. */
  async pollDeviceStatus(): Promise<void> {
    const cache = this.edgeCache;
    if (!cache) return;
    const deviceIds = cache.deviceIds();
    const statuses: Record<string, string> = {};
    // Always at least one request (an empty list still proves support).
    for (let i = 0; i === 0 || i < deviceIds.length; i += 1000) {
      const res = await this.post<{ ok?: boolean; statuses?: Record<string, string>; code?: string }>(
        '/api/devices/status', { deviceIds: deviceIds.slice(i, i + 1000), headRegion: this.edgeRegion },
      );
      if (!res || typeof res.statuses !== 'object' || res.statuses === null) {
        // Unreachable keeps the current mode (entries still age out after
        // maxStaleMs); an account service without the endpoint never enables it.
        if (res?.code !== 'service_unavailable' && this.localAuthReady) {
          getLogger().warn('Account service has no device status endpoint; edge-local auth off');
          this.localAuthReady = false;
        }
        return;
      }
      Object.assign(statuses, res.statuses);
    }
    if (!this.localAuthReady) getLogger().info('Edge-local challenge auth enabled', { cached: deviceIds.length });
    this.localAuthReady = true;
    for (const [deviceId, status] of Object.entries(statuses)) {
      if (status === 'ok') continue;
      cache.forget(deviceId);
      this.onRevoked?.({ deviceId, code: status, message: 'Device no longer accepted' });
    }
  }

  async authenticate(
    auth: AuthMethod,
    device: DeviceInfo,
    headRegion?: string,
    clientIp?: string,
  ): Promise<AuthOutcome> {
    // The account service throttles failed logins per client IP; forward the
    // end user's address, not this edge's.
    return this.post('/api/auth', { auth, device, headRegion, ...(clientIp && { clientIp }) });
  }

  async startChallenge(
    deviceId: string,
    encryptionKey?: string,
    headRegion?: string,
  ): Promise<ChallengeOutcome> {
    const cached = this.localChallengeActive ? this.edgeCache!.lookup(deviceId) : undefined;
    if (cached) {
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
    if (cache?.takeNonce(nonce, deviceId)) {
      const cached = this.localChallengeActive ? cache.lookup(deviceId) : undefined;
      const sameKeys = cached !== undefined && (encryptionKey === undefined || encryptionKey === cached.encryptionKey);
      if (cached && sameKeys && cache.verifySignature(cached, nonce, signature)) {
        metrics().inc('auth.localVerify');
        if (cache.claimRevalidation(deviceId)) {
          void this.revalidate(deviceId, nonce, signature, encryptionKey, headRegion);
        }
        return { ...cached.result, authMethod: 'challenge', local: true };
      }
      // New encryption key, rotated signing key, or trust lapsed meanwhile:
      // the account service decides (the edge nonce is just as signable).
    }
    const result = await this.post<AuthOutcome>('/api/auth/verify', { deviceId, nonce, signature, encryptionKey, headRegion });
    if (result.ok) cache?.remember(result);
    else if (isDefinitiveRejection(result.code)) cache?.forget(deviceId);
    return result;
  }

  /** Background re-check of a locally accepted signature. */
  private async revalidate(deviceId: string, nonce: string, signature: string, encryptionKey?: string, headRegion?: string): Promise<void> {
    const context = this.revalidationContext?.();
    const result = await this.post<AuthOutcome>('/api/auth/verify', { deviceId, nonce, signature, encryptionKey, headRegion });
    const cache = this.edgeCache;
    if (!cache) return;
    if (result.ok) {
      cache.remember(result);
      this.onRefreshed?.(result, context);
      return;
    }
    if (!isDefinitiveRejection(result.code)) return;
    metrics().inc('auth.localRevoked');
    getLogger().warn('Account service rejected a locally accepted device', { deviceId, code: result.code });
    cache.forget(deviceId);
    this.onRevoked?.({
      deviceId, code: result.code, message: result.message,
      redirect: result.code === 'wrong_region' ? (result as { redirect?: string }).redirect : undefined,
    });
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

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.serviceKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      });

      const data = await response.json();
      return data as T;
    } catch (err) {
      logger.error('Account service request failed', { path, error: (err as Error).message });
      return { ok: false, code: 'service_unavailable', message: 'Account service unavailable' } as T;
    }
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.accountUrl}${path}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${this.serviceKey}` },
      signal: AbortSignal.timeout(this.timeout),
    });
    return response.json() as Promise<T>;
  }
}
