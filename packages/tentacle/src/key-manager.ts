/**
 * Tentacle key management for E2E encryption.
 *
 * Generates and persists RSA keypair on first run.
 * Provides encrypt/decrypt helpers using @kraki/crypto.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPair, exportPublicKey, importPublicKey, encrypt, decrypt, generateE2EKeyPair, importE2EPrivateKey, e2ePublicKeyOf } from '@kraki/crypto';
import type { KeyPair, EncryptedPayload, RecipientKey } from '@kraki/crypto';
import type { KeyObject } from 'node:crypto';
import { getConfigDir } from './config.js';

const KEYS_DIR_NAME = 'keys';
const PRIVATE_KEY_FILE = 'private.pem';
const PUBLIC_KEY_FILE = 'public.pem';
/** E2E v2 X25519 private key (base64url PKCS#8). */
const E2E_PRIVATE_KEY_FILE = 'e2e-x25519.key';

export class KeyManager {
  private keysDir: string;
  private keyPair: KeyPair | null = null;
  private e2eKey: { privateKey: KeyObject; publicKey: string } | null = null;

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
   * The E2E v2 (X25519) key: generated once, persisted next to the RSA keys.
   * Announced to apps in the device greeting; never sent to the Head.
   */
  getE2EKey(): { privateKey: KeyObject; publicKey: string } {
    if (this.e2eKey) return this.e2eKey;
    const path = join(this.keysDir, E2E_PRIVATE_KEY_FILE);
    let encoded: string;
    if (existsSync(path)) {
      encoded = readFileSync(path, 'utf8').trim();
    } else {
      encoded = generateE2EKeyPair().privateKey;
      writeFileSync(path, encoded, { mode: 0o600 });
    }
    const privateKey = importE2EPrivateKey(encoded);
    this.e2eKey = { privateKey, publicKey: e2ePublicKeyOf(privateKey) };
    return this.e2eKey;
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
