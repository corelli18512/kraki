/**
 * Tentacle key management for E2E encryption.
 *
 * Generates and persists RSA keypair on first run.
 * Provides encrypt/decrypt helpers using @kraki/crypto.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPair, exportPublicKey, importPublicKey, encrypt, decrypt } from '@kraki/crypto';
import type { KeyPair, EncryptedPayload, RecipientKey } from '@kraki/crypto';
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

    if (existsSync(privPath) && existsSync(pubPath)) {
      this.keyPair = {
        privateKey: readFileSync(privPath, 'utf8'),
        publicKey: readFileSync(pubPath, 'utf8'),
      };
    } else {
      this.keyPair = generateKeyPair();
      writeFileSync(privPath, this.keyPair.privateKey, { mode: 0o600 });
      writeFileSync(pubPath, this.keyPair.publicKey, { mode: 0o644 });
    }

    return this.keyPair;
  }

  /**
   * Get compact public key for sending to the head during auth.
   */
  getCompactPublicKey(): string {
    return exportPublicKey(this.getKeyPair().publicKey);
  }

  /**
   * Encrypt a message payload for a set of recipient devices.
   */
  encryptForRecipients(plaintext: string, recipients: RecipientKey[]): EncryptedPayload {
    return encrypt(plaintext, recipients);
  }

  /**
   * Decrypt a message payload intended for this device.
   */
  decryptForMe(payload: EncryptedPayload, myDeviceId: string): string {
    return decrypt(payload, myDeviceId, this.getKeyPair().privateKey);
  }
}
