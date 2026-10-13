/**
 * Device trust store — the apps this computer takes commands from.
 *
 * With device trust enforced, the relay is no longer believed about who is
 * allowed to talk to this computer. An app is trusted only after it paired:
 *
 * - **QR pairing**: `kraki pair` puts a one-time secret in the QR code and
 *   records it here (`pairings/`). The app proves it saw the QR by sending a
 *   `pair_request` whose HMAC under that secret covers its keys.
 * - **Same-machine pairing** (Kraki for Mac): the app writes its keys to
 *   `local-enroll/<appId>.json`. Only a process of this user on this machine
 *   can do that; the relay cannot.
 *
 * Trusted apps are pinned with their identity (Ed25519), encryption (X25519)
 * and optional legacy RSA keys. Keys the relay reports are never used for a
 * trusted app.
 *
 * Layout under `<KRAKI_HOME>/trust/` (directory 0700, files 0600):
 *   devices.json              { version: 1, devices: { [appId]: TrustedDevice } }
 *   policy.json               { enforce: boolean } — see initTrustPolicy
 *   pairings/<id>.json        { secret, createdAt, expiresAt }
 *   local-enroll/<appId>.json LocalEnrollment
 *   replay.json               ReplayGuard state
 */

import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  generatePairingSecret, isRawPublicKey, verifyPairingProof, ReplayGuard, type PairingClaim,
} from '@kraki/crypto';
import { getKrakiHome } from './config.js';
import { createLogger } from './logger.js';

// Lazy: this module is imported by the CLI's pairing command, before logging
// is configured.
let cachedLogger: ReturnType<typeof createLogger> | null = null;
const logger = {
  info: (obj: object, msg: string) => (cachedLogger ??= createLogger('trust-store')).info(obj, msg),
  warn: (obj: object, msg: string) => (cachedLogger ??= createLogger('trust-store')).warn(obj, msg),
};

/** QR pairing secrets live as long as the head's pairing token. */
export const PAIRING_SECRET_TTL_MS = 5 * 60_000;
/** A same-machine enrollment file older than this is ignored. */
const LOCAL_ENROLL_TTL_MS = 10 * 60_000;

export type TrustVia = 'qr' | 'local';

export interface TrustedDevice {
  identityKey: string;
  encryptionKey: string;
  rsaKey?: string;
  name?: string;
  pairedAt: string;
  via: TrustVia;
}

export interface LocalEnrollment {
  appId: string;
  identityKey: string;
  encryptionKey: string;
  rsaKey?: string;
  name?: string;
  /** Unix ms when the app wrote the file. */
  ts: number;
}

interface PendingPairing {
  secret: string;
  createdAt: number;
  expiresAt: number;
}

export function getTrustDir(home = getKrakiHome()): string {
  return join(home, 'trust');
}

export interface TrustPolicy {
  /** Serve only paired apps and accept only their signed commands. */
  enforce: boolean;
}

/**
 * Record the default policy once, when this computer's keys are created:
 * a fresh install enforces from the start (its first app pairs through the
 * QR it shows); an install upgraded from a version without device trust stays
 * compatible until its apps have paired. Never overwrites a choice.
 */
export function initTrustPolicy(dir: string, enforce: boolean): void {
  const path = join(dir, 'policy.json');
  if (existsSync(path)) return;
  ensureDir(dir);
  try {
    writeFileSync(path, JSON.stringify({ enforce }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

/** Write the policy (CLI, Settings, or a paired app's request). */
export function writeTrustPolicy(dir: string, policy: TrustPolicy): void {
  ensureDir(dir);
  writePrivateJson(join(dir, 'policy.json'), { enforce: policy.enforce === true });
}

export function readTrustPolicy(dir: string): TrustPolicy {
  let text: string;
  try {
    text = readFileSync(join(dir, 'policy.json'), 'utf8');
  } catch (err) {
    // No policy: an install that predates device trust (compatible).
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { enforce: false };
    return { enforce: true };
  }
  try {
    const raw = JSON.parse(text) as { enforce?: unknown };
    return { enforce: raw.enforce !== false };
  } catch {
    // Unreadable policy: fail closed.
    return { enforce: true };
  }
}

function writePrivateJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* best effort */ }
}

/**
 * Create a one-time pairing secret for a QR code. Called by the CLI process
 * that renders the QR; the daemon reads it when the app's pair_request
 * arrives.
 */
export function createPairingSecret(home = getKrakiHome(), now = Date.now()): string {
  const dir = join(getTrustDir(home), 'pairings');
  ensureDir(dir);
  const secret = generatePairingSecret();
  const record: PendingPairing = { secret, createdAt: now, expiresAt: now + PAIRING_SECRET_TTL_MS };
  writePrivateJson(join(dir, `${randomUUID()}.json`), record);
  return secret;
}

export class TrustStore {
  /** Null: memory only (a KeyManager without a key directory, e.g. a test
   *  double) — never falls back to the real `~/.kraki`. */
  readonly dir: string | null;
  private replayDirty = false;
  private devices = new Map<string, TrustedDevice>();
  readonly replayGuard = new ReplayGuard();
  private replaySaveTimer: ReturnType<typeof setTimeout> | null = null;
  private policy: TrustPolicy = { enforce: false };
  /** mtimes of devices.json / policy.json when last read (CLI edits them). */
  private stamps = { devices: -1, policy: -1 };

  /** @param dir the trust directory — `<KRAKI_HOME>/trust` in production,
   *  next to the KeyManager's `keys/` directory. */
  constructor(dir: string | null) {
    this.dir = dir;
    if (dir === null) return;
    // Created on first write only: constructing a store must not touch disk.
    this.loadDevices();
    this.policy = readTrustPolicy(dir);
    this.stamps.policy = this.mtime(this.policyPath);
    try {
      this.replayGuard.import(JSON.parse(readFileSync(this.replayPath, 'utf8')) as Array<[string, number]>);
    } catch (err) {
      // Lost replay state (not merely absent): refuse anything signed before
      // now, so no captured message inside the window can be replayed.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.replayGuard.rejectBefore(Date.now());
        logger.warn({ err: (err as Error).message }, 'Replay state unreadable — rejecting earlier messages');
      }
    }
  }

  get persistent(): boolean { return this.dir !== null; }
  private get devicesPath(): string { return join(this.dir ?? '', 'devices.json'); }
  private get replayPath(): string { return join(this.dir ?? '', 'replay.json'); }
  private get policyPath(): string { return join(this.dir ?? '', 'policy.json'); }

  private mtime(path: string): number {
    try { return statSync(path).mtimeMs; } catch { return 0; }
  }

  get enforced(): boolean {
    // Until a policy file exists (a fresh install writes one with its keys),
    // keep looking for it: never act on a stale "compatible" guess.
    if (this.dir && this.stamps.policy === 0) {
      const stamp = this.mtime(this.policyPath);
      if (stamp !== 0) {
        this.policy = readTrustPolicy(this.dir);
        this.stamps.policy = stamp;
      }
    }
    return this.policy.enforce;
  }

  setPolicy(policy: TrustPolicy): void {
    if (this.dir) writeTrustPolicy(this.dir, policy);
    this.policy = { enforce: policy.enforce };
    this.stamps.policy = this.mtime(this.policyPath);
    logger.info({ enforce: policy.enforce }, 'Device trust policy changed');
  }

  /**
   * Pick up changes another process made (`kraki devices revoke`, `kraki
   * devices enforce`, Kraki for Mac Settings). Returns true when anything changed.
   */
  refresh(): boolean {
    if (!this.dir) return false;
    let changed = false;
    const devicesStamp = this.mtime(this.devicesPath);
    if (devicesStamp !== this.stamps.devices) {
      const before = JSON.stringify([...this.devices]);
      this.loadDevices();
      changed ||= before !== JSON.stringify([...this.devices]);
    }
    const policyStamp = this.mtime(this.policyPath);
    if (policyStamp !== this.stamps.policy) {
      const next = readTrustPolicy(this.dir);
      this.stamps.policy = policyStamp;
      if (next.enforce !== this.policy.enforce) {
        this.policy = next;
        changed = true;
      }
    }
    return changed;
  }

  list(): Array<TrustedDevice & { id: string }> {
    return [...this.devices].map(([id, d]) => ({ id, ...d }));
  }

  private loadDevices(): void {
    this.stamps.devices = this.mtime(this.devicesPath);
    this.devices.clear();
    try {
      const raw = JSON.parse(readFileSync(this.devicesPath, 'utf8')) as { version?: number; devices?: Record<string, TrustedDevice> };
      for (const [id, d] of Object.entries(raw.devices ?? {})) {
        if (isRawPublicKey(d?.identityKey) && isRawPublicKey(d?.encryptionKey)) this.devices.set(id, d);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ err: (err as Error).message }, 'Could not read trusted devices');
    }
  }

  private save(): void {
    if (!this.dir) return;
    ensureDir(this.dir);
    writePrivateJson(this.devicesPath, { version: 1, devices: Object.fromEntries(this.devices) });
    this.stamps.devices = this.mtime(this.devicesPath);
  }

  /**
   * Persist an accepted nonce before the message is acted on, so a crash
   * cannot reopen the replay window. False when it could not be written:
   * the caller must then refuse the message (fail closed).
   */
  noteAccepted(): boolean {
    this.replayDirty = true;
    return this.flushReplay();
  }

  flushReplay(): boolean {
    if (this.replaySaveTimer) { clearTimeout(this.replaySaveTimer); this.replaySaveTimer = null; }
    if (!this.dir || !this.replayDirty) return true;
    try {
      ensureDir(this.dir);
      writePrivateJson(this.replayPath, this.replayGuard.export());
      this.replayDirty = false;
      return true;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Could not persist replay state');
      return false;
    }
  }

  /**
   * Read-modify-write devices.json under a lock file, starting from what is
   * on disk — so the daemon and `kraki devices` (or two daemons) never write
   * back a stale copy (e.g. resurrecting a revoked app).
   */
  private mutate(change: (devices: Map<string, TrustedDevice>) => boolean): boolean {
    if (!this.dir) return change(this.devices);
    ensureDir(this.dir);
    const lock = join(this.dir, 'devices.lock');
    const deadline = Date.now() + 3_000;
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = openSync(lock, 'wx', 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // A holder that died leaves the lock behind; it is stale after 10 s.
        try { if (Date.now() - statSync(lock).mtimeMs > 10_000) unlinkSync(lock); } catch { /* raced */ }
        if (Date.now() > deadline) throw new Error('Trusted devices are locked by another process');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try {
      this.loadDevices();
      const changed = change(this.devices);
      if (changed) this.save();
      return changed;
    } finally {
      closeSync(fd);
      try { unlinkSync(lock); } catch { /* gone */ }
    }
  }

  get(appId: string): TrustedDevice | undefined {
    return this.devices.get(appId);
  }

  has(appId: string): boolean {
    return this.devices.has(appId);
  }

  ids(): string[] {
    return [...this.devices.keys()];
  }

  /** Revoke an app (it was removed from the account, or the user revoked it). */
  remove(appId: string): boolean {
    if (!this.mutate((devices) => devices.delete(appId))) return false;
    logger.info({ appId }, 'Device trust revoked');
    return true;
  }

  private trust(appId: string, device: TrustedDevice): void {
    this.mutate((devices) => { devices.set(appId, device); return true; });
    logger.info({ appId, via: device.via, name: device.name }, 'Device trusted');
  }

  /**
   * Accept a QR pairing claim when its proof matches an unexpired, unused
   * pairing secret. The secret is consumed on success.
   */
  acceptQrPairing(claim: PairingClaim, proof: string, name: string | undefined, now = Date.now()): boolean {
    if (!this.dir) return false;
    const dir = join(this.dir, 'pairings');
    let files: string[];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return false; }
    for (const file of files) {
      const path = join(dir, file);
      let record: PendingPairing;
      try { record = JSON.parse(readFileSync(path, 'utf8')) as PendingPairing; } catch { continue; }
      if (typeof record.expiresAt !== 'number' || record.expiresAt < now) {
        try { unlinkSync(path); } catch { /* raced */ }
        continue;
      }
      if (!verifyPairingProof(record.secret, claim, proof)) continue;
      try { unlinkSync(path); } catch { return false; /* consumed by a concurrent request */ }
      this.trust(claim.appId, {
        identityKey: claim.identityKey,
        encryptionKey: claim.encryptionKey,
        ...(claim.rsaKey ? { rsaKey: claim.rsaKey } : {}),
        ...(name ? { name } : {}),
        pairedAt: new Date(now).toISOString(),
        via: 'qr',
      });
      return true;
    }
    return false;
  }

  /**
   * Accept a same-machine enrollment the app wrote for `appId` with exactly
   * these keys. The file must be owned by this user and private.
   */
  acceptLocalEnrollment(appId: string, identityKey: string, encryptionKey: string, now = Date.now()): boolean {
    if (!this.dir) return false;
    const path = join(this.dir, 'local-enroll', `${appId}.json`);
    if (!existsSync(path)) return false;
    try {
      const st = statSync(path);
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
      if ((st.mode & 0o077) !== 0) {
        logger.warn({ appId }, 'Ignoring local enrollment readable by others');
        return false;
      }
      const e = JSON.parse(readFileSync(path, 'utf8')) as LocalEnrollment;
      if (e.appId !== appId || e.identityKey !== identityKey || e.encryptionKey !== encryptionKey) return false;
      if (typeof e.ts !== 'number' || e.ts < now - LOCAL_ENROLL_TTL_MS || e.ts > now + LOCAL_ENROLL_TTL_MS) return false;
      if (!isRawPublicKey(e.identityKey) || !isRawPublicKey(e.encryptionKey)) return false;
      // Consume it before trusting: a left-over enrollment would let a
      // revoked app enroll itself again.
      try { unlinkSync(path); } catch {
        logger.warn({ appId }, 'Could not consume local enrollment');
        return false;
      }
      this.trust(appId, {
        identityKey: e.identityKey,
        encryptionKey: e.encryptionKey,
        ...(e.rsaKey ? { rsaKey: e.rsaKey } : {}),
        ...(e.name ? { name: e.name } : {}),
        pairedAt: new Date(now).toISOString(),
        via: 'local',
      });
      return true;
    } catch (err) {
      logger.warn({ appId, err: (err as Error).message }, 'Invalid local enrollment');
      return false;
    }
  }
}
