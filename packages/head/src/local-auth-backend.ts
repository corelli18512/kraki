/**
 * Local auth backend — validates credentials using local auth providers and Storage.
 * Used when head runs in standalone mode (no remote account service).
 */

import { randomBytes, createVerify } from 'crypto';
import { v4 as uuid } from 'uuid';
import type { AuthMethod, DeviceInfo, DeviceSummary, UnicastEnvelope, DeviceRole, DeviceKind } from '@kraki/protocol';
import type { AuthBackend, AuthOutcome, ChallengeOutcome, AuthInfoConfig } from './auth-backend.js';
import type { AuthProvider, AuthUser } from './auth.js';
import { GitHubAuthProvider } from './auth.js';
import type { Storage } from './storage.js';
import type { PushManager } from './push/index.js';
import { getLogger } from './logger.js';
import { suggestRegionForIp } from './ip-geo.js';

function importPublicKey(compactKey: string): string {
  const lines = compactKey.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

function verifySignature(nonce: string, signature: string, publicKeyPem: string): boolean {
  const verify = createVerify('SHA256');
  verify.update(nonce);
  return verify.verify(publicKeyPem, signature, 'base64');
}

export interface LocalAuthBackendOptions {
  storage: Storage;
  authProviders: Map<string, AuthProvider>;
  pairingEnabled?: boolean;
  pairingTtl?: number;
  pushManager?: PushManager;
  /** This head's region (e.g., 'us', 'china'). If set, region checks are enforced. */
  region?: string;
  /** Map of region name → relay URL for wrong_region redirects. */
  regionUrls?: Record<string, string>;
}

export interface RegionDirectoryEntry {
  code: string;
  relayUrl: string;
  displayName?: string;
}

export type LoginResolveOutcome =
  | {
    ok: true;
    registered: boolean;
    needsRegionSelection: boolean;
    user: {
      id: string;
      login: string;
      provider: string;
      email?: string;
      preferences?: Record<string, unknown>;
      region?: string;
    };
    region?: string;
    relayUrl?: string;
    suggestedRegion?: string;
    regions: RegionDirectoryEntry[];
  }
  | { ok: false; code: string; message: string };

export type EdgeJoinOutcome =
  | { ok: true; region: string; relayUrl: string; displayName?: string; serviceKey: string }
  | { ok: false; code: string; message: string };

export class LocalAuthBackend implements AuthBackend {
  private storage: Storage;
  private authProviders: Map<string, AuthProvider>;
  private pairingEnabled: boolean;
  private pairingTtl: number;
  private pushManager?: PushManager;
  private region?: string;
  private regionUrls: Record<string, string>;
  private pairingTokens = new Map<string, { userId: string; expiresAt: number }>();

  constructor(options: LocalAuthBackendOptions) {
    this.storage = options.storage;
    this.authProviders = options.authProviders;
    this.pairingEnabled = options.pairingEnabled ?? true;
    this.pairingTtl = options.pairingTtl ?? 300;
    this.pushManager = options.pushManager;
    this.region = options.region;
    this.regionUrls = options.regionUrls ?? {};
  }

  async authenticate(
    auth: AuthMethod,
    device: DeviceInfo,
    headRegion?: string,
  ): Promise<AuthOutcome> {
    const logger = getLogger();

    if (auth.method === 'pairing') {
      return this.handlePairingAuth(auth.token, device, headRegion);
    }

    if (auth.method === 'challenge') {
      return { ok: false, code: 'unknown_auth_method', message: 'Use startChallenge/verifyChallenge for challenge auth' };
    }

    const resolved = await this.resolveAuthUser(auth);
    if (this.isAuthError(resolved)) {
      logger.warn('Auth rejected', { method: auth.method, reason: resolved.message });
      return resolved;
    }

    return this.completeAuth(resolved, device, auth.method, headRegion);
  }

  async startChallenge(
    deviceId: string,
    _encryptionKey?: string,
    headRegion?: string,
  ): Promise<ChallengeOutcome> {
    const device = this.storage.getDevice(deviceId);
    if (!device || !device.publicKey) {
      return { ok: false, code: 'unknown_device', message: 'Unknown device' };
    }

    // Region check: look up the user for this device
    const regionCheck = this.checkRegion(device.userId, headRegion);
    if (regionCheck) return regionCheck;

    const nonce = randomBytes(32).toString('hex');
    return { ok: true, nonce, userId: device.userId, deviceId };
  }

  async verifyChallenge(
    deviceId: string,
    nonce: string,
    signature: string,
    encryptionKey?: string,
    headRegion?: string,
  ): Promise<AuthOutcome> {
    const logger = getLogger();
    const device = this.storage.getDevice(deviceId);
    if (!device || !device.publicKey) {
      return { ok: false, code: 'device_not_found', message: 'Device not found' };
    }

    const publicKeyPem = importPublicKey(device.publicKey);
    const valid = verifySignature(nonce, signature, publicKeyPem);
    if (!valid) {
      logger.warn('Challenge-response auth failed', { deviceId });
      return { ok: false, code: 'invalid_signature', message: 'Invalid signature' };
    }

    // Update encryption key if provided
    const updatedKey = encryptionKey ?? device.encryptionKey ?? undefined;
    this.storage.upsertDevice(
      deviceId, device.userId, device.name, device.role,
      device.kind ?? undefined, device.publicKey ?? undefined, updatedKey,
    );

    const user = this.storage.getUser(device.userId);
    if (!user) {
      return { ok: false, code: 'user_not_found', message: 'User not found' };
    }

    // Region check
    const regionCheck = this.checkRegion(user.userId, headRegion);
    if (regionCheck) return regionCheck;

    return {
      ok: true,
      userId: user.userId,
      deviceId,
      authMethod: 'challenge',
      user: {
        id: user.userId,
        login: user.username,
        provider: user.provider,
        email: user.email,
        preferences: user.preferences,
        region: user.region,
      },
      devices: this.getDeviceSummaries(user.userId),
      pendingMessages: this.flushPending(deviceId),
      githubClientId: this.getGitHubClientId(),
      vapidPublicKey: this.getVapidPublicKey(),
    };
  }

  createPairingToken(userId: string): { token: string; expiresIn: number } {
    const token = `pt_${randomBytes(32).toString('hex')}`;
    this.pairingTokens.set(token, {
      userId,
      expiresAt: Date.now() + this.pairingTtl * 1000,
    });
    return { token, expiresIn: this.pairingTtl };
  }

  async requestPairingToken(
    token: string,
    ip?: string,
  ): Promise<{ ok: true; userId: string; pairingToken: string; expiresIn: number } | { ok: false; code: string; message: string }> {
    // Try all providers
    for (const provider of this.authProviders.values()) {
      const result = await provider.authenticate({ token, ip });
      if (result.ok) {
        this.storage.upsertUser(result.user.id, result.user.login, result.user.provider, result.user.email);
        const pairing = this.createPairingToken(result.user.id);
        return { ok: true, userId: result.user.id, pairingToken: pairing.token, expiresIn: pairing.expiresIn };
      }
    }
    return { ok: false, code: 'auth_rejected', message: 'No auth provider accepted the token' };
  }

  getAuthInfo(): AuthInfoConfig {
    const methods: string[] = [];
    if (this.authProviders.has('github')) {
      methods.push('github_token');
      const ghProvider = this.findGitHubProvider();
      if (ghProvider?.oauthConfigured) methods.push('github_oauth');
    }
    if (this.authProviders.has('apikey')) methods.push('apikey');
    if (this.authProviders.has('open')) methods.push('open');
    if (this.pairingEnabled) methods.push('pairing');
    methods.push('challenge');
    return {
      methods,
      githubClientId: this.getGitHubClientId(),
      vapidPublicKey: this.getVapidPublicKey(),
    };
  }

  async resolveLogin(auth: AuthMethod, preferredRegion?: string, clientIp?: string): Promise<LoginResolveOutcome> {
    if (auth.method === 'pairing' || auth.method === 'challenge') {
      return { ok: false, code: 'unsupported_auth_method', message: `${auth.method} cannot be used for login-first routing` };
    }

    const resolved = await this.resolveAuthUser(auth);
    if (this.isAuthError(resolved)) return resolved;

    const regions = this.getRegions();
    const storedUser = this.storage.getUser(resolved.id);
    const assignedRegion = storedUser?.region;

    if (assignedRegion) {
      return {
        ok: true,
        registered: true,
        needsRegionSelection: false,
        user: this.buildUserProfile(resolved, storedUser?.preferences, assignedRegion),
        region: assignedRegion,
        relayUrl: this.getRelayUrlForRegion(assignedRegion),
        regions,
      };
    }

    // New user — auto-assign region from preferred, IP geo, or first available
    let targetRegion = preferredRegion;

    if (!targetRegion && clientIp) {
      const geoRegion = await suggestRegionForIp(clientIp);
      if (geoRegion && regions.some(r => r.code === geoRegion)) {
        targetRegion = geoRegion;
      }
    }

    if (!targetRegion) {
      targetRegion = this.region ?? regions[0]?.code;
    }

    if (targetRegion) {
      const regionInfo = this.storage.getRegion(targetRegion);
      if (regionInfo?.enabled) {
        this.storage.upsertUser(resolved.id, resolved.login, resolved.provider, resolved.email, regionInfo.code);
        this.storage.setUserRegion(resolved.id, regionInfo.code);
        return {
          ok: true,
          registered: true,
          needsRegionSelection: false,
          user: this.buildUserProfile(resolved, storedUser?.preferences, regionInfo.code),
          region: regionInfo.code,
          relayUrl: regionInfo.relayUrl,
          regions,
        };
      }
    }

    // Fallback: no regions configured — return without region assignment
    this.storage.upsertUser(resolved.id, resolved.login, resolved.provider, resolved.email);
    return {
      ok: true,
      registered: true,
      needsRegionSelection: false,
      user: this.buildUserProfile(resolved, storedUser?.preferences),
      regions,
    };
  }

  getRegions(): RegionDirectoryEntry[] {
    return this.storage.getRegions(true).map(region => ({
      code: region.code,
      relayUrl: region.relayUrl,
      displayName: region.displayName,
    }));
  }

  getRegionVersion(): number {
    return this.storage.getRegionVersion();
  }

  completeEdgeJoin(token: string, region: string, relayUrl: string, displayName?: string): EdgeJoinOutcome {
    const joinResult = this.storage.consumeEdgeJoinToken(token, region, relayUrl, displayName);
    if (!joinResult.ok) return joinResult;

    this.storage.upsertRegion(joinResult.region, joinResult.relayUrl, joinResult.displayName, true);
    const { serviceKey } = this.storage.issueRegionServiceKey(joinResult.region);

    return {
      ok: true,
      region: joinResult.region,
      relayUrl: joinResult.relayUrl,
      displayName: joinResult.displayName,
      serviceKey,
    };
  }

  validateServiceKey(serviceKey: string): { valid: boolean; region?: string } {
    const result = this.storage.validateServiceKey(serviceKey);
    return result.valid ? { valid: true, region: result.region } : { valid: false };
  }

  /** Sweep expired pairing tokens. Called periodically by HeadServer. */
  sweepPairingTokens(): void {
    const now = Date.now();
    for (const [token, data] of this.pairingTokens) {
      if (now > data.expiresAt) this.pairingTokens.delete(token);
    }
  }

  // ── Private helpers ───────────────────────────────────

  private handlePairingAuth(
    pairingToken: string,
    device: DeviceInfo,
    headRegion?: string,
  ): AuthOutcome {
    const logger = getLogger();
    if (!this.pairingEnabled) {
      return { ok: false, code: 'pairing_disabled', message: 'Pairing is disabled.' };
    }

    const tokenData = this.pairingTokens.get(pairingToken);
    if (!tokenData || tokenData.expiresAt < Date.now()) {
      if (tokenData) this.pairingTokens.delete(pairingToken);
      logger.warn('Pairing auth failed: invalid or expired token');
      return { ok: false, code: 'invalid_pairing_token', message: 'Invalid or expired pairing token' };
    }

    // Consume token (single-use)
    this.pairingTokens.delete(pairingToken);

    const user = this.storage.getUser(tokenData.userId);
    if (!user) {
      return { ok: false, code: 'user_not_found', message: 'User not found' };
    }

    const authUser: AuthUser = { id: user.userId, login: user.username, provider: user.provider, email: user.email };
    return this.completeAuth(authUser, device, 'pairing', headRegion);
  }

  private completeAuth(
    authUser: AuthUser,
    device: DeviceInfo,
    authMethod: AuthMethod['method'],
    headRegion?: string,
  ): AuthOutcome {
    const logger = getLogger();

    // Upsert user — assign region on first auth if not yet set
    const existingUser = this.storage.getUser(authUser.id);
    const userRegion = existingUser?.region ?? headRegion ?? this.region;
    this.storage.upsertUser(authUser.id, authUser.login, authUser.provider, authUser.email, userRegion);

    // If user already has a region and it doesn't match, set it now
    if (userRegion && !existingUser?.region) {
      this.storage.setUserRegion(authUser.id, userRegion);
    }

    // Region check
    const regionCheck = this.checkRegion(authUser.id, headRegion);
    if (regionCheck) return regionCheck;

    // Register device
    const deviceId = device.deviceId ?? `dev_${uuid().slice(0, 12)}`;
    try {
      this.storage.upsertDevice(
        deviceId, authUser.id, device.name, device.role,
        device.kind, device.publicKey, device.encryptionKey,
      );
    } catch (err) {
      logger.warn('Device registration failed', { error: (err as Error).message });
      return { ok: false, code: 'device_registration_failed', message: (err as Error).message };
    }

    const fullUser = this.storage.getUser(authUser.id);

    return {
      ok: true,
      userId: authUser.id,
      deviceId,
      authMethod,
      user: {
        id: authUser.id,
        login: authUser.login,
        provider: authUser.provider,
        email: authUser.email,
        preferences: fullUser?.preferences,
        region: fullUser?.region,
      },
      devices: this.getDeviceSummaries(authUser.id),
      pendingMessages: this.flushPending(deviceId),
      githubClientId: this.getGitHubClientId(),
      vapidPublicKey: this.getVapidPublicKey(),
    };
  }

  private checkRegion(
    userId: string,
    headRegion?: string,
  ): { ok: false; code: 'wrong_region'; redirect?: string; message: string } | null {
    if (!this.region || !headRegion) return null; // Region checks disabled

    const user = this.storage.getUser(userId);
    if (!user?.region) return null; // User has no region yet

    if (user.region === headRegion) return null; // Correct region

    const redirectUrl = this.getRelayUrlForRegion(user.region);

    return {
      ok: false,
      code: 'wrong_region',
      ...(redirectUrl && { redirect: redirectUrl }),
      message: redirectUrl
        ? `User is assigned to region '${user.region}', connect to ${redirectUrl}`
        : `User is assigned to region '${user.region}'`,
    };
  }

  private async resolveAuthUser(auth: AuthMethod): Promise<AuthUser | { ok: false; code: string; message: string }> {
    let provider: AuthProvider | undefined;
    let credentials: { token?: string; githubCode?: string; ip?: string } = {};

    switch (auth.method) {
      case 'github_token':
        provider = this.getProviderForMode('github');
        credentials = { token: auth.token };
        break;
      case 'github_oauth':
        provider = this.getProviderForMode('github');
        credentials = { githubCode: auth.code };
        break;
      case 'apikey':
        provider = this.getProviderForMode('apikey');
        credentials = { token: auth.key };
        break;
      case 'open':
        provider = this.getProviderForMode('open');
        credentials = { token: auth.sharedKey };
        break;
      default:
        return { ok: false, code: 'unknown_auth_method', message: `Unknown auth method: ${(auth as { method: string }).method}` };
    }

    if (!provider) {
      return { ok: false, code: 'auth_rejected', message: `Auth method ${auth.method} not configured` };
    }

    const result = await provider.authenticate(credentials);
    if (!result.ok) {
      return { ok: false, code: 'auth_rejected', message: result.message };
    }
    return result.user;
  }

  private isAuthError(result: AuthUser | { ok: false; code: string; message: string }): result is { ok: false; code: string; message: string } {
    return 'ok' in result && result.ok === false;
  }

  private buildUserProfile(
    authUser: AuthUser,
    preferences?: Record<string, unknown>,
    region?: string,
  ): { id: string; login: string; provider: string; email?: string; preferences?: Record<string, unknown>; region?: string } {
    return {
      id: authUser.id,
      login: authUser.login,
      provider: authUser.provider,
      email: authUser.email,
      preferences,
      region,
    };
  }

  private getRelayUrlForRegion(region: string): string | undefined {
    return this.storage.getRegion(region)?.relayUrl ?? this.regionUrls[region];
  }

  private getProviderForMode(mode: string): AuthProvider | undefined {
    return this.authProviders.get(mode);
  }

  private findGitHubProvider(): GitHubAuthProvider | undefined {
    const provider = this.authProviders.get('github');
    if (!provider) return undefined;
    if (provider instanceof GitHubAuthProvider) return provider;
    if ('inner' in provider) {
      const inner = (provider as unknown as { inner: unknown }).inner;
      if (inner instanceof GitHubAuthProvider) return inner;
    }
    return undefined;
  }

  private getGitHubClientId(): string | undefined {
    return this.findGitHubProvider()?.oauthConfigured ? this.findGitHubProvider()!.getClientId() : undefined;
  }

  private getVapidPublicKey(): string | undefined {
    return this.pushManager?.getVapidPublicKey();
  }

  private getDeviceSummaries(userId: string): DeviceSummary[] {
    const stored = this.storage.getDevicesByUser(userId);
    return stored.map(d => ({
      id: d.id,
      name: d.name,
      role: d.role as DeviceRole,
      kind: (d.kind as DeviceKind) ?? undefined,
      publicKey: d.publicKey ?? undefined,
      encryptionKey: d.encryptionKey ?? undefined,
      online: false, // HeadServer sets the correct online status
      lastSeen: d.lastSeen,
      createdAt: d.createdAt,
    }));
  }

  private flushPending(deviceId: string): UnicastEnvelope[] {
    const rows = this.storage.flushPending(deviceId);
    const envelopes: UnicastEnvelope[] = [];
    for (const raw of rows) {
      try { envelopes.push(JSON.parse(raw)); } catch { /* skip malformed */ }
    }
    return envelopes;
  }
}
