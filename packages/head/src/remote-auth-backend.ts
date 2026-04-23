/**
 * Remote auth backend — delegates auth to a remote Account Service via REST.
 * Used when head runs in connected mode (--account-url flag).
 */

import type { AuthMethod, DeviceInfo } from '@kraki/protocol';
import type { AuthBackend, AuthOutcome, ChallengeOutcome, AuthInfoConfig } from './auth-backend.js';
import { getLogger } from './logger.js';

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

  constructor(options: RemoteAuthBackendOptions) {
    this.accountUrl = options.accountUrl.replace(/\/+$/, '');
    this.serviceKey = options.serviceKey;
    this.timeout = options.timeout ?? 15_000;
  }

  async authenticate(
    auth: AuthMethod,
    device: DeviceInfo,
    headRegion?: string,
  ): Promise<AuthOutcome> {
    return this.post('/api/auth', { auth, device, headRegion });
  }

  async startChallenge(
    deviceId: string,
    encryptionKey?: string,
    headRegion?: string,
  ): Promise<ChallengeOutcome> {
    return this.post('/api/auth/challenge', { deviceId, encryptionKey, headRegion });
  }

  async verifyChallenge(
    deviceId: string,
    nonce: string,
    signature: string,
    encryptionKey?: string,
    headRegion?: string,
  ): Promise<AuthOutcome> {
    return this.post('/api/auth/verify', { deviceId, nonce, signature, encryptionKey, headRegion });
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
