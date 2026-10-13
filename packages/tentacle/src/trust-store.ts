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
 *   pairings/<id>.json        { secret, createdAt, expiresAt }
 *   local-enroll/<appId>.json LocalEnrollment
 *   replay.json               ReplayGuard state
 */

import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
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
  readonly dir: string;
  private devices = new Map<string, TrustedDevice>();
  readonly replayGuard = new ReplayGuard();
  private replaySaveTimer: ReturnType<typeof setTimeout> | null = null;

  /** @param dir the trust directory — `<KRAKI_HOME>/trust` in production,
   *  next to the KeyManager's `keys/` directory. */
  constructor(dir = getTrustDir()) {
    this.dir = dir;
    // Created on first write only: constructing a store must not touch disk.
    this.load();
  }

  private get devicesPath(): string { return join(this.dir, 'devices.json'); }
  private get replayPath(): string { return join(this.dir, 'replay.json'); }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.devicesPath, 'utf8')) as { version?: number; devices?: Record<string, TrustedDevice> };
      for (const [id, d] of Object.entries(raw.devices ?? {})) {
        if (isRawPublicKey(d?.identityKey) && isRawPublicKey(d?.encryptionKey)) this.devices.set(id, d);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ err: (err as Error).message }, 'Could not read trusted devices');
    }
    try {
      this.replayGuard.import(JSON.parse(readFileSync(this.replayPath, 'utf8')) as Array<[string, number]>);
    } catch { /* first run */ }
  }

  private save(): void {
    ensureDir(this.dir);
    writePrivateJson(this.devicesPath, { version: 1, devices: Object.fromEntries(this.devices) });
  }

  /** Persist accepted nonces soon (a restart must not reopen the replay window). */
  noteAccepted(): void {
    if (this.replaySaveTimer) return;
    this.replaySaveTimer = setTimeout(() => {
      this.replaySaveTimer = null;
      this.flushReplay();
    }, 1_000);
    this.replaySaveTimer.unref?.();
  }

  flushReplay(): void {
    if (this.replaySaveTimer) { clearTimeout(this.replaySaveTimer); this.replaySaveTimer = null; }
    try {
      ensureDir(this.dir);
      writePrivateJson(this.replayPath, this.replayGuard.export());
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Could not persist replay state');
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
    if (!this.devices.delete(appId)) return false;
    this.save();
    logger.info({ appId }, 'Device trust revoked');
    return true;
  }

  private trust(appId: string, device: TrustedDevice): void {
    this.devices.set(appId, device);
    this.save();
    logger.info({ appId, via: device.via, name: device.name }, 'Device trusted');
  }

  /**
   * Accept a QR pairing claim when its proof matches an unexpired, unused
   * pairing secret. The secret is consumed on success.
   */
  acceptQrPairing(claim: PairingClaim, proof: string, name: string | undefined, now = Date.now()): boolean {
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
      try { unlinkSync(path); } catch { /* fine */ }
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
