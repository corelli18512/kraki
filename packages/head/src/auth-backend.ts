/**
 * Auth backend abstraction for HeadServer.
 *
 * LocalAuthBackend: validates credentials directly using auth providers + Storage.
 * RemoteAuthBackend: delegates auth to a remote Account Service via REST.
 *
 * HeadServer uses this interface so it doesn't care whether auth happens
 * locally or remotely — same code path for both standalone and connected mode.
 */

import type { AuthMethod, DeviceInfo, DeviceSummary, UnicastEnvelope } from '@kraki/protocol';
import type { AuthUser } from './auth.js';

// ── Result types ────────────────────────────────────────

export interface AuthResult {
  ok: true;
  userId: string;
  deviceId: string;
  authMethod: AuthMethod['method'];
  user: {
    id: string;
    login: string;
    provider: string;
    email?: string;
    preferences?: Record<string, unknown>;
    region?: string;
  };
  devices: DeviceSummary[];
  pendingMessages: UnicastEnvelope[];
  githubClientId?: string;
  vapidPublicKey?: string;
}

export interface AuthChallengeResult {
  ok: true;
  nonce: string;
  userId: string;
  deviceId: string;
}

export interface AuthRegionMismatch {
  ok: false;
  code: 'wrong_region';
  redirect: string;
  message: string;
}

export interface AuthError {
  ok: false;
  code: string;
  message: string;
}

export type AuthOutcome = AuthResult | AuthRegionMismatch | AuthError;
export type ChallengeOutcome = AuthChallengeResult | AuthRegionMismatch | AuthError;

// ── Auth backend interface ──────────────────────────────

export interface AuthBackend {
  /**
   * Full auth flow (token-based methods: github_token, github_oauth, apikey, open, pairing).
   * Returns the full auth result including device list and pending messages.
   */
  authenticate(
    auth: AuthMethod,
    device: DeviceInfo,
    headRegion?: string,
  ): Promise<AuthOutcome>;

  /**
   * Start challenge-response auth (step 1).
   * Returns a nonce to be signed by the device.
   */
  startChallenge(
    deviceId: string,
    encryptionKey?: string,
    headRegion?: string,
  ): Promise<ChallengeOutcome>;

  /**
   * Complete challenge-response auth (step 2).
   * Verifies the signed nonce and returns the full auth result.
   */
  verifyChallenge(
    deviceId: string,
    nonce: string,
    signature: string,
    encryptionKey?: string,
    headRegion?: string,
  ): Promise<AuthOutcome>;

  /**
   * Create a pairing token for an authenticated user.
   * Returns the token string and TTL.
   */
  createPairingToken(userId: string): { token: string; expiresIn: number };

  /**
   * Request a one-shot pairing token (authenticates the requester first).
   * Used by the tentacle before the user has a device registered.
   */
  requestPairingToken(
    token: string,
    ip?: string,
  ): Promise<{ ok: true; userId: string; pairingToken: string; expiresIn: number } | AuthError>;

  /**
   * Get config info for auth_info responses.
   * Returns available auth methods, GitHub client ID, VAPID key, etc.
   */
  getAuthInfo(): AuthInfoConfig;
}

export interface AuthInfoConfig {
  methods: string[];
  githubClientId?: string;
  vapidPublicKey?: string;
}
