/**
 * Edge-local challenge auth for devices the account service already
 * verified (docs/edge-local-auth.md).
 *
 * An edge (CN) used to ask the account service (Tokyo) twice for every
 * reconnect: `/api/auth/challenge` for a nonce, `/api/auth/verify` for the
 * signature. Two cross-border round trips on cold connections were most of
 * the ~760 ms p50 iPhone auth (diag 2026-10-21).
 *
 * The account service stays the only source of truth: it alone registers
 * devices, decides regions, and revokes. The edge keeps, per device, the last
 * auth result the account service returned, and for a device it has seen
 * verified within `maxStaleMs` it:
 *   1. issues the nonce itself and verifies the signature against the
 *      device's public key it mirrors from that result (no network),
 *   2. answers auth_ok at once, then re-verifies the same signature with the
 *      account service in the background (at most every `revalidateMs`); a
 *      definitive rejection there kicks the connection and forgets the device,
 *   3. polls the account service for the status of every cached device
 *      (`/api/devices/status`) so a removal elsewhere ends local trust within
 *      one poll interval.
 *
 * Anything else (unknown device, changed keys, a stale entry, an account
 * service that does not offer `/api/devices/status`) takes the remote path
 * unchanged.
 */

import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { importPublicKey, verifyChallenge as verifyChallengeSignature } from '@kraki/crypto';
import type { AuthResult } from './auth-backend.js';

export interface EdgeAuthCacheOptions {
  /** Longest time since the account service last confirmed a device. */
  maxStaleMs?: number;
  /** Minimum time between background re-verifications of one device. */
  revalidateMs?: number;
  now?: () => number;
}

export interface CachedDevice {
  deviceId: string;
  userId: string;
  publicKey: string;
  encryptionKey?: string;
  result: AuthResult;
  verifiedAt: number;
}

export const DEFAULT_MAX_STALE_MS = 7 * 24 * 3600_000;
export const DEFAULT_REVALIDATE_MS = 60_000;
const NONCE_TTL_MS = 5 * 60_000;

export class EdgeAuthCache {
  readonly maxStaleMs: number;
  readonly revalidateMs: number;
  private readonly now: () => number;
  /** Nonces this edge issued itself (not the account service). */
  private readonly localNonces = new Map<string, { deviceId: string; expiresAt: number }>();
  private readonly lastRevalidation = new Map<string, number>();

  constructor(private readonly db: Database.Database, options: EdgeAuthCacheOptions = {}) {
    this.maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
    this.revalidateMs = options.revalidateMs ?? DEFAULT_REVALIDATE_MS;
    this.now = options.now ?? Date.now;
    db.exec(`CREATE TABLE IF NOT EXISTS edge_auth_cache (
      device_id   TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      public_key  TEXT NOT NULL,
      encryption_key TEXT,
      result_json TEXT NOT NULL,
      verified_at INTEGER NOT NULL
    )`);
  }

  /** The account service accepted this device (challenge or token auth). */
  remember(result: AuthResult): void {
    const self = result.devices.find((d) => d.id === result.deviceId);
    if (!self?.publicKey) return; // no signing key: cannot do challenge auth anyway
    this.db.prepare(`INSERT OR REPLACE INTO edge_auth_cache
      (device_id, user_id, public_key, encryption_key, result_json, verified_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(result.deviceId, result.userId, self.publicKey, self.encryptionKey ?? null,
        JSON.stringify(result), this.now());
  }

  /** A fresh entry, or undefined. */
  lookup(deviceId: string): CachedDevice | undefined {
    const row = this.db.prepare('SELECT * FROM edge_auth_cache WHERE device_id = ?').get(deviceId) as {
      device_id: string; user_id: string; public_key: string; encryption_key: string | null;
      result_json: string; verified_at: number;
    } | undefined;
    if (!row) return undefined;
    if (this.now() - row.verified_at > this.maxStaleMs) return undefined;
    // The local mirror is what removals on this edge delete: no mirror, no trust.
    const mirrored = this.db.prepare('SELECT public_key FROM devices WHERE id = ?').get(deviceId) as
      { public_key: string | null } | undefined;
    if (!mirrored || mirrored.public_key !== row.public_key) return undefined;
    let result: AuthResult;
    try { result = JSON.parse(row.result_json) as AuthResult; } catch { return undefined; }
    return {
      deviceId: row.device_id, userId: row.user_id, publicKey: row.public_key,
      encryptionKey: row.encryption_key ?? undefined, result, verifiedAt: row.verified_at,
    };
  }

  forget(deviceId: string): void {
    this.db.prepare('DELETE FROM edge_auth_cache WHERE device_id = ?').run(deviceId);
    this.lastRevalidation.delete(deviceId);
  }

  deviceIds(): string[] {
    return (this.db.prepare('SELECT device_id FROM edge_auth_cache').all() as Array<{ device_id: string }>)
      .map((r) => r.device_id);
  }

  issueNonce(deviceId: string): string {
    this.sweepNonces();
    const nonce = randomBytes(32).toString('hex');
    this.localNonces.set(nonce, { deviceId, expiresAt: this.now() + NONCE_TTL_MS });
    return nonce;
  }

  /** Consume a nonce this edge issued for `deviceId`. */
  takeNonce(nonce: string, deviceId: string): boolean {
    const entry = this.localNonces.get(nonce);
    if (!entry) return false;
    this.localNonces.delete(nonce);
    return entry.deviceId === deviceId && entry.expiresAt >= this.now();
  }

  verifySignature(entry: CachedDevice, nonce: string, signature: string): boolean {
    try {
      return verifyChallengeSignature(nonce, signature, importPublicKey(entry.publicKey));
    } catch {
      return false;
    }
  }

  /** Whether a background re-verification is due (and claims it). */
  claimRevalidation(deviceId: string): boolean {
    const last = this.lastRevalidation.get(deviceId) ?? 0;
    if (this.now() - last < this.revalidateMs) return false;
    this.lastRevalidation.set(deviceId, this.now());
    return true;
  }

  private sweepNonces(): void {
    const now = this.now();
    for (const [nonce, entry] of this.localNonces) if (entry.expiresAt < now) this.localNonces.delete(nonce);
  }
}

/** Account-service answers that mean "this device may not sign in here". */
export function isDefinitiveRejection(code: string | undefined): boolean {
  return code !== undefined && code !== 'service_unavailable' && code !== 'internal_error'
    && code !== 'rate_limited' && code !== 'bad_request';
}
