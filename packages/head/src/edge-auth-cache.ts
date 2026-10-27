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
 *   2. answers auth_ok at once, then asks the account service for that
 *      device's status in the background (at most every `revalidateMs`;
 *      it only verifies nonces it issued itself); a rejection there kicks
 *      the connection and forgets the device, an `ok` changes nothing,
 *   3. polls the account service for the status of every cached device
 *      (`/api/devices/status`) so a removal elsewhere ends local trust within
 *      one poll interval.
 *
 * Anything else (unknown device, changed keys, a stale entry, an account
 * service that does not offer `/api/devices/status`) takes the remote path
 * unchanged.
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { importPublicKey, verifyChallenge as verifyChallengeSignature } from '@kraki/crypto';
import type { AuthResult } from './auth-backend.js';
import { ChallengeNonces } from './challenge-nonce.js';

export interface EdgeAuthCacheOptions {
  /** Longest time since the account service last confirmed a device. */
  maxStaleMs?: number;
  /** Minimum time between background status checks of one device. */
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

/** Age limit of the account service's last full answer. Status polls only
 *  revoke; they do not refresh the device list / user data mirrored from
 *  that answer, so a device signs in through the account service at least
 *  once a day (which refreshes it). */
export const DEFAULT_MAX_STALE_MS = 24 * 3600_000;
export const DEFAULT_REVALIDATE_MS = 60_000;
/** A challenge must be answered within this (the Head also enforces it per
 *  socket, for account-service nonces too). */
const NONCE_TTL_MS = 5 * 60_000;

/** What `checkNonce` found: `local` = issued here for this device and not
 *  yet accepted; `foreign` = issued here for another device, or accepted. */
export type NonceCheck = 'local' | 'expired' | 'foreign' | 'unknown';

/** Short, stable fingerprint of a signing key, for status polls. */
export function keyFingerprint(publicKey: string): string {
  return createHash('sha256').update(publicKey).digest('base64url').slice(0, 22);
}

export class EdgeAuthCache {
  readonly maxStaleMs: number;
  readonly revalidateMs: number;
  private readonly now: () => number;
  /** Nonces this edge issued itself (not the account service). They carry
   *  their own proof of origin, so issuing stores nothing (a flood of
   *  challenge starts cannot void another device's nonce), and a reused or
   *  late one is still recognised as ours, never mistaken for an
   *  account-service nonce. */
  private readonly localNonces: ChallengeNonces;
  private readonly lastRevalidation = new Map<string, number>();
  /** Bumped whenever a device's trust is dropped: an account-service answer
   *  requested before the drop must not bring it back. */
  private readonly epochs = new Map<string, number>();
  /** Bumped only when a device's trust is dropped (`forget`), not when a
   *  newer answer is stored: see `newerAnswerFor`. */
  private readonly drops = new Map<string, number>();
  /** Monotonic clock of trust changes, and when each device last changed:
   *  fences answers for requests that did not know the device id yet. */
  private changeClock = 0;
  private readonly changedAt = new Map<string, number>();

  constructor(private readonly db: Database.Database, options: EdgeAuthCacheOptions = {}) {
    this.maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
    this.revalidateMs = options.revalidateMs ?? DEFAULT_REVALIDATE_MS;
    this.now = options.now ?? Date.now;
    this.localNonces = new ChallengeNonces(NONCE_TTL_MS, () => this.now());
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

  /** How often the device's trust was dropped (see `newerAnswerFor`). */
  dropCount(deviceId: string): number { return this.drops.get(deviceId) ?? 0; }

  /** The id belongs to an account deleted through this edge. */
  isTombstoned(deviceId: string): boolean {
    return this.db.prepare('SELECT 1 FROM deleted_devices WHERE device_id = ?').get(deviceId) !== undefined;
  }

  /** Now, on the trust-change clock. */
  clock(): number { return this.changeClock; }

  /** Whether the device's trust changed after `clock` (from `clock()`). */
  changedSince(deviceId: string, clock: number): boolean { return (this.changedAt.get(deviceId) ?? 0) > clock; }

  private bump(deviceId: string): void {
    this.epochs.set(deviceId, this.epoch(deviceId) + 1);
    this.changedAt.set(deviceId, ++this.changeClock);
  }

  /**
   * The account service accepted this device (challenge or token auth).
   * `epochAtRequest` (from `epoch()` before the request was sent) fences the
   * answer: if the device was dropped, or a newer answer was stored, since
   * the request left, this one is `stale` and must not be acted on (but see
   * `newerAnswerFor`). Storing advances the epoch, so an older answer can
   * never overwrite a newer one.
   */
  remember(result: AuthResult, epochAtRequest?: number): 'stored' | 'stale' | 'skipped' {
    if (epochAtRequest !== undefined && epochAtRequest !== this.epoch(result.deviceId)) return 'stale';
    const self = result.devices.find((d) => d.id === result.deviceId);
    if (!self?.publicKey) return 'skipped'; // no signing key: cannot do challenge auth anyway
    this.bump(result.deviceId);
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
    this.drops.set(deviceId, this.dropCount(deviceId) + 1);
    this.bump(deviceId);
  }

  /**
   * For an answer `remember` called `stale`: if all that happened since its
   * request left (`dropsAtRequest` from `dropCount()`) is that a newer answer
   * for the same account and keys was stored, that newer answer. A client
   * that retried a slow sign-in gets both answers; the later one may use
   * the stored one instead of failing. Undefined when trust was dropped or
   * the account or keys changed: then the stale answer must fail.
   */
  newerAnswerFor(result: AuthResult, dropsAtRequest: number): AuthResult | undefined {
    if (dropsAtRequest !== this.dropCount(result.deviceId)) return undefined;
    const row = this.db.prepare('SELECT user_id, public_key, encryption_key, result_json FROM edge_auth_cache WHERE device_id = ?')
      .get(result.deviceId) as { user_id: string; public_key: string; encryption_key: string | null; result_json: string } | undefined;
    const self = result.devices.find((d) => d.id === result.deviceId);
    if (!row || !self || row.user_id !== result.userId || row.public_key !== self.publicKey
      || (row.encryption_key ?? undefined) !== (self.encryptionKey ?? undefined)) return undefined;
    try { return JSON.parse(row.result_json) as AuthResult; } catch { return undefined; }
  }

  /**
   * Delete rows too old for local sign-in (`maxStaleMs`) unless `keep` says
   * otherwise. Not a revocation (no epoch change): the device's next sign-in
   * goes to the account service and stores a fresh row. A connected device
   * must be kept: the status poll of its row is what kicks it if it is
   * removed or moved elsewhere.
   */
  pruneStale(keep: (deviceId: string) => boolean): void {
    const rows = this.db.prepare('SELECT device_id FROM edge_auth_cache WHERE verified_at < ?')
      .all(this.now() - this.maxStaleMs) as Array<{ device_id: string }>;
    const remove = this.db.prepare('DELETE FROM edge_auth_cache WHERE device_id = ?');
    for (const { device_id: deviceId } of rows) {
      if (keep(deviceId)) continue;
      remove.run(deviceId);
      this.lastRevalidation.delete(deviceId);
    }
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
    return this.localNonces.issue(deviceId);
  }

  /**
   * Where a nonce came from. `unknown` means this edge did not issue it (an
   * account-service nonce); anything but `local` and `unknown` must be
   * rejected, never passed on to the account service.
   */
  checkNonce(nonce: string, deviceId: string): NonceCheck {
    const check = this.localNonces.check(nonce, deviceId);
    if (check === 'valid') return 'local';
    return check === 'used' ? 'foreign' : check;
  }

  /** The answer to this `local` nonce was accepted: never again. */
  acceptNonce(nonce: string): void {
    this.localNonces.accept(nonce);
  }

  verifySignature(entry: CachedDevice, nonce: string, signature: string): boolean {
    try {
      return verifyChallengeSignature(nonce, signature, importPublicKey(entry.publicKey));
    } catch {
      return false;
    }
  }

  /** Whether a background status check is due (and claims it). */
  claimRevalidation(deviceId: string): boolean {
    const last = this.lastRevalidation.get(deviceId) ?? 0;
    if (this.now() - last < this.revalidateMs) return false;
    this.lastRevalidation.set(deviceId, this.now());
    return true;
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
