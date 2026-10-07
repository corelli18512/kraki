/**
 * Tentacle key management for E2E encryption.
 *
 * Generates and persists RSA keypair on first run.
 * Encryption itself uses @kraki/crypto directly with getKeyPair().
 */

import { existsSync, linkSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicKey } from 'node:crypto';
import { generateKeyPair, exportPublicKey, importPublicKey } from '@kraki/crypto';
import type { KeyPair } from '@kraki/crypto';
import { getConfigDir } from './config.js';

const KEYS_DIR_NAME = 'keys';
const PRIVATE_KEY_FILE = 'private.pem';
const PUBLIC_KEY_FILE = 'public.pem';

export class KeyManager {
  private keysDir: string;
  private keyPair: KeyPair | null = null;

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
   * Get compact public key for sending to the head during auth.
   */
  getCompactPublicKey(): string {
    return exportPublicKey(this.getKeyPair().publicKey);
  }
}
