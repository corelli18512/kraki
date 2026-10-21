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
import { createHash, randomBytes } from 'node:crypto';
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
/** A challenge must be answered within this (the Head also enforces it per
 *  socket, for account-service nonces too). */
const NONCE_TTL_MS = 5 * 60_000;
/** Used/expired local nonces are remembered this long, so a late answer is
 *  still recognised as ours (and rejected) instead of looking unknown. */
const NONCE_RETAIN_MS = 24 * 3600_000;
const MAX_NONCES = 20_000;

/** What `takeNonce` found: `local` = issued here for this device and unused. */
export type NonceCheck = 'local' | 'expired' | 'foreign' | 'unknown';

/** Short, stable fingerprint of a signing key, for status polls. */
export function keyFingerprint(publicKey: string): string {
  return createHash('sha256').update(publicKey).digest('base64url').slice(0, 22);
}

export class EdgeAuthCache {
  readonly maxStaleMs: number;
  readonly revalidateMs: number;
  private readonly now: () => number;
  /** Nonces this edge issued itself (not the account service). Kept (marked
   *  used) until twice their lifetime so a reuse is recognised, not mistaken
   *  for an account-service nonce. */
  private readonly localNonces = new Map<string, { deviceId: string; expiresAt: number; used: boolean }>();
  private readonly lastRevalidation = new Map<string, number>();
  /** Bumped whenever a device's trust is dropped: an account-service answer
   *  requested before the drop must not bring it back. */
  private readonly epochs = new Map<string, number>();

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

  /** The account and key this edge currently trusts a device under. */
  identity(deviceId: string): { userId: string; keyFingerprint: string } | undefined {
    const row = this.db.prepare('SELECT user_id, public_key FROM edge_auth_cache WHERE device_id = ?').get(deviceId) as
      { user_id: string; public_key: string } | undefined;
    return row ? { userId: row.user_id, keyFingerprint: keyFingerprint(row.public_key) } : undefined;
  }

  /** Current trust epoch of a device (see `remember`). */
  epoch(deviceId: string): number { return this.epochs.get(deviceId) ?? 0; }

  /**
   * The account service accepted this device (challenge or token auth).
   * `epochAtRequest` (from `epoch()` before the request was sent) fences the
   * answer: if the device was dropped, or a newer answer was stored, since
   * the request left, this one is `stale` and must not be acted on. Storing
   * advances the epoch, so an older answer can never overwrite a newer one.
   */
  remember(result: AuthResult, epochAtRequest?: number): 'stored' | 'stale' | 'skipped' {
    if (epochAtRequest !== undefined && epochAtRequest !== this.epoch(result.deviceId)) return 'stale';
    const self = result.devices.find((d) => d.id === result.deviceId);
    if (!self?.publicKey) return 'skipped'; // no signing key: cannot do challenge auth anyway
    this.epochs.set(result.deviceId, this.epoch(result.deviceId) + 1);
    this.db.prepare(`INSERT OR REPLACE INTO edge_auth_cache
      (device_id, user_id, public_key, encryption_key, result_json, verified_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(result.deviceId, result.userId, self.publicKey, self.encryptionKey ?? null,
        JSON.stringify(result), this.now());
    return 'stored';
  }

  /** A fresh entry, or undefined. */
  lookup(deviceId: string): CachedDevice | undefined {
    const row = this.db.prepare('SELECT * FROM edge_auth_cache WHERE device_id = ?').get(deviceId) as {
      device_id: string; user_id: string; public_key: string; encryption_key: string | null;
      result_json: string; verified_at: number;
    } | undefined;
    if (!row) return undefined;
    if (this.now() - row.verified_at > this.maxStaleMs) return undefined;
    // The local mirror is what removals on this edge delete: no mirror, no
    // trust. It must still be the same key and the same account (a removed
    // device id may be registered again under another account).
    const mirrored = this.db.prepare('SELECT public_key, user_id FROM devices WHERE id = ?').get(deviceId) as
      { public_key: string | null; user_id: string } | undefined;
    if (!mirrored || mirrored.public_key !== row.public_key || mirrored.user_id !== row.user_id) return undefined;
    if (this.db.prepare('SELECT 1 FROM deleted_devices WHERE device_id = ?').get(deviceId) !== undefined) return undefined;
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
    this.epochs.set(deviceId, this.epoch(deviceId) + 1);
  }

  deviceIds(): string[] {
    return (this.db.prepare('SELECT device_id FROM edge_auth_cache').all() as Array<{ device_id: string }>)
      .map((r) => r.device_id);
  }

  /** Cached devices with their key fingerprints (status poll payload). */
  entries(): Array<{ deviceId: string; userId: string; keyFingerprint: string }> {
    return (this.db.prepare('SELECT device_id, user_id, public_key FROM edge_auth_cache').all() as
      Array<{ device_id: string; user_id: string; public_key: string }>)
      .map((r) => ({ deviceId: r.device_id, userId: r.user_id, keyFingerprint: keyFingerprint(r.public_key) }));
  }

  issueNonce(deviceId: string): string {
    this.sweepNonces();
    // Bounded: oldest first. An evicted nonce reads as unknown (the account
    // service decides), and the Head still rejects any answer older than
    // five minutes on the socket that asked.
    while (this.localNonces.size >= MAX_NONCES) {
      const oldest = this.localNonces.keys().next().value;
      if (oldest === undefined) break;
      this.localNonces.delete(oldest);
    }
    const nonce = randomBytes(32).toString('hex');
    this.localNonces.set(nonce, { deviceId, expiresAt: this.now() + NONCE_TTL_MS, used: false });
    return nonce;
  }

  /**
   * Consume a nonce. `unknown` means this edge did not issue it (an
   * account-service nonce); anything but `local` and `unknown` must be
   * rejected, never passed on to the account service.
   */
  takeNonce(nonce: string, deviceId: string): NonceCheck {
    const entry = this.localNonces.get(nonce);
    if (!entry) return 'unknown';
    if (entry.used || entry.deviceId !== deviceId) { entry.used = true; return 'foreign'; }
    entry.used = true;
    return entry.expiresAt >= this.now() ? 'local' : 'expired';
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

  private lastSweep = 0;
  private sweepNonces(): void {
    const now = this.now();
    // At most once a minute: issuing a nonce must not scan the whole map.
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [nonce, entry] of this.localNonces) {
      if (entry.expiresAt + NONCE_RETAIN_MS < now) this.localNonces.delete(nonce);
    }
  }
}

/** Rejections that are about the device itself (it is gone, moved or the
 *  account was deleted), as opposed to one bad attempt: only these may drop
 *  local trust. A wrong signature from some other socket must not. */
export function isDeviceRejection(code: string | undefined): boolean {
  return code === 'unknown_device' || code === 'device_not_found' || code === 'account_deleted'
    || code === 'wrong_region' || code === 'user_not_found';
}

/** Account-service answers that mean "this device may not sign in here". */
export function isDefinitiveRejection(code: string | undefined): boolean {
  return code !== undefined && code !== 'service_unavailable' && code !== 'internal_error'
    && code !== 'rate_limited' && code !== 'bad_request' && code !== 'not_supported' && code !== 'auth_unavailable';
}
