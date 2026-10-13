/**
 * Tentacle key management for E2E encryption.
 *
 * Generates and persists RSA keypair on first run.
 * Encryption itself uses @kraki/crypto directly with getKeyPair().
 */

import { existsSync, linkSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  generateKeyPair, exportPublicKey, importPublicKey,
  generateE2EKeyPair, importE2EPrivateKey, e2ePublicKeyOf,
  generateIdentityKeyPair, importIdentityPrivateKey, identityPublicKeyOf,
} from '@kraki/crypto';
import type { KeyPair } from '@kraki/crypto';
import { getConfigDir } from './config.js';

const KEYS_DIR_NAME = 'keys';
const PRIVATE_KEY_FILE = 'private.pem';
const PUBLIC_KEY_FILE = 'public.pem';
/** E2E v2 X25519 private key (base64url PKCS#8). */
const E2E_PRIVATE_KEY_FILE = 'e2e-x25519.key';
/** Device identity Ed25519 private key (base64url PKCS#8). */
const IDENTITY_PRIVATE_KEY_FILE = 'identity-ed25519.key';
/** Public half of both, for same-machine apps (Kraki for Mac) to pin. */
export const PUBLIC_IDENTITY_FILE = 'public-identity.json';

export interface PublicIdentity {
  /** Ed25519 identity key, base64url raw. */
  identityKey: string;
  /** X25519 encryption key, base64url raw. */
  encryptionKey: string;
}

export class KeyManager {
  readonly keysDir: string;
  private keyPair: KeyPair | null = null;
  private e2eKey: { privateKey: KeyObject; publicKey: string } | null = null;
  private identityKey: { privateKey: KeyObject; publicKey: string } | null = null;

  constructor(keysDir?: string) {
    this.keysDir = keysDir ?? join(getConfigDir(), KEYS_DIR_NAME);
    mkdirSync(this.keysDir, { recursive: true });
  }

  /**
   * Get or create the device keypair. Generated once, persisted to disk.
   */
  getKeyPair(): KeyPair {
    if (this.keyPair) return this.keyPair;

    const privPath = join(this.keysDir, PRIVATE_KEY_FILE);
    const pubPath = join(this.keysDir, PUBLIC_KEY_FILE);

    if (!existsSync(privPath)) {
      // Two processes can get here at once on a fresh install (the daemon
      // starting while setup shows the pairing code). Publish the private key
      // with an exclusive hard link, so exactly one key ever lands on disk;
      // the loser uses the winner's. Before this, both wrote their own and the
      // device registered one key while the disk kept the other — the
      // computer could not reconnect after its next restart.
      const generated = generateKeyPair();
      const tmp = `${privPath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, generated.privateKey, { mode: 0o600 });
      try { linkSync(tmp, privPath); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          try { unlinkSync(tmp); } catch { /* ignore */ }
          throw err;
        }
      }
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }

    // The public key is always the one belonging to private.pem on disk.
    const privateKey = readFileSync(privPath, 'utf8');
    const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
    const onDisk = existsSync(pubPath) ? readFileSync(pubPath, 'utf8') : null;
    if (onDisk !== publicKey) writeFileSync(pubPath, publicKey, { mode: 0o644 });
    this.keyPair = { privateKey, publicKey };
    return this.keyPair;
  }

  /**
   * The E2E v2 (X25519) key: generated once, persisted next to the RSA keys.
   * Never sent to the Head.
   */
  getE2EKey(): { privateKey: KeyObject; publicKey: string } {
    if (this.e2eKey) return this.e2eKey;
    const privateKey = importE2EPrivateKey(this.loadOrCreate(E2E_PRIVATE_KEY_FILE, () => generateE2EKeyPair().privateKey));
    this.e2eKey = { privateKey, publicKey: e2ePublicKeyOf(privateKey) };
    this.writePublicIdentity();
    return this.e2eKey;
  }

  /**
   * This computer's identity (Ed25519) key. Apps pin it when they pair (from
   * the QR code, or from {@link PUBLIC_IDENTITY_FILE} on the same Mac) and
   * accept only messages it signed. Never sent to the Head.
   */
  getIdentityKey(): { privateKey: KeyObject; publicKey: string } {
    if (this.identityKey) return this.identityKey;
    const privateKey = importIdentityPrivateKey(
      this.loadOrCreate(IDENTITY_PRIVATE_KEY_FILE, () => generateIdentityKeyPair().privateKey),
    );
    this.identityKey = { privateKey, publicKey: identityPublicKeyOf(privateKey) };
    this.writePublicIdentity();
    return this.identityKey;
  }

  getPublicIdentity(): PublicIdentity {
    return { identityKey: this.getIdentityKey().publicKey, encryptionKey: this.getE2EKey().publicKey };
  }

  private writePublicIdentity(): void {
    if (!this.e2eKey || !this.identityKey) return;
    const path = join(this.keysDir, PUBLIC_IDENTITY_FILE);
    const content = JSON.stringify({ identityKey: this.identityKey.publicKey, encryptionKey: this.e2eKey.publicKey }) + '\n';
    const onDisk = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (onDisk !== content) writeFileSync(path, content, { mode: 0o644 });
  }

  /** Read a private key file, creating it exactly once across processes. */
  private loadOrCreate(name: string, generate: () => string): string {
    const path = join(this.keysDir, name);
    if (!existsSync(path)) {
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, generate(), { mode: 0o600 });
      try { linkSync(tmp, path); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          try { unlinkSync(tmp); } catch { /* ignore */ }
          throw err;
        }
      }
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
    return readFileSync(path, 'utf8').trim();
  }

  /**
   * Get compact public key for sending to the head during auth.
   */
  getCompactPublicKey(): string {
    return exportPublicKey(this.getKeyPair().publicKey);
  }
}
