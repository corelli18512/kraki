/**
 * @kraki/crypto — E2E encryption for Kraki
 *
 * Hybrid encryption: AES-256-GCM for payload, RSA-OAEP for key wrapping.
 * One AES key per message, wrapped separately for each recipient device.
 *
 * This is the Node.js implementation using the built-in crypto module.
 * A browser implementation using Web Crypto API would have the same interface.
 */

import {
  generateKeyPairSync,
  publicEncrypt,
  privateDecrypt,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  constants,
} from 'crypto';

// ── Types ───────────────────────────────────────────────

export interface KeyPair {
  publicKey: string;   // PEM-encoded RSA public key
  privateKey: string;  // PEM-encoded RSA private key
}

export interface EncryptedPayload {
  /** AES-256-GCM initialization vector (base64) */
  iv: string;
  /** AES-256-GCM encrypted data (base64) */
  ciphertext: string;
  /** AES-256-GCM auth tag (base64) */
  tag: string;
  /** Per-recipient RSA-OAEP encrypted AES key (base64), keyed by deviceId */
  keys: Record<string, string>;
}

/** Consolidated encrypted payload — iv + ciphertext + tag packed into one blob */
export interface BlobPayload {
  /** base64(iv ‖ ciphertext ‖ tag) — relay sees this as an opaque string */
  blob: string;
  /** Per-recipient RSA-OAEP encrypted AES key (base64), keyed by deviceId */
  keys: Record<string, string>;
}

export interface RecipientKey {
  deviceId: string;
  publicKey: string; // PEM-encoded
}

// ── Key generation ──────────────────────────────────────

const RSA_KEY_SIZE = 4096;
const AES_KEY_SIZE = 32;  // 256 bits
const IV_SIZE = 12;       // 96 bits for GCM

/**
 * Generate an RSA-OAEP key pair for a device.
 */
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: RSA_KEY_SIZE,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

// ── Encryption ──────────────────────────────────────────

/**
 * Encrypt a message for multiple recipients.
 *
 * 1. Generate random AES-256 key (one-time)
 * 2. Encrypt plaintext with AES-256-GCM
 * 3. Wrap AES key with each recipient's RSA public key
 *
 * @param plaintext - The message to encrypt (string)
 * @param recipients - Array of { deviceId, publicKey } for each recipient
 * @returns EncryptedPayload with one ciphertext + per-device wrapped keys
 */
export function encrypt(plaintext: string, recipients: RecipientKey[]): EncryptedPayload {
  if (recipients.length === 0) {
    throw new Error('At least one recipient required');
  }

  // 1. Generate random AES key and IV
  const aesKey = randomBytes(AES_KEY_SIZE);
  const iv = randomBytes(IV_SIZE);

  // 2. Encrypt plaintext with AES-256-GCM
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // 3. Wrap AES key for each recipient's RSA public key
  const keys: Record<string, string> = {};
  for (const recipient of recipients) {
    const wrappedKey = publicEncrypt(
      {
        key: recipient.publicKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      aesKey,
    );
    keys[recipient.deviceId] = wrappedKey.toString('base64');
  }

  return {
    iv: iv.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    tag: tag.toString('base64'),
    keys,
  };
}

// ── Decryption ──────────────────────────────────────────

/**
 * Decrypt a message intended for this device.
 *
 * 1. Unwrap AES key using device's RSA private key
 * 2. Decrypt ciphertext with AES-256-GCM
 *
 * @param payload - The EncryptedPayload received from the relay
 * @param deviceId - This device's ID (to find the correct wrapped key)
 * @param privateKey - This device's RSA private key (PEM)
 * @returns The original plaintext string
 * @throws If deviceId not found in keys, or decryption fails (tampered)
 */
export function decrypt(payload: EncryptedPayload, deviceId: string, privateKey: string): string {
  const wrappedKey = payload.keys[deviceId];
  if (!wrappedKey) {
    throw new Error(`No encrypted key found for device "${deviceId}"`);
  }

  // 1. Unwrap AES key
  const aesKey = privateDecrypt(
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(wrappedKey, 'base64'),
  );

  // 2. Decrypt ciphertext
  const decipher = createDecipheriv(
    'aes-256-gcm',
    aesKey,
    Buffer.from(payload.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

// ── Blob format (consolidated envelope) ────────────────

const TAG_SIZE = 16; // AES-GCM auth tag is always 16 bytes

/**
 * Encrypt and pack into a single blob string.
 * The blob is base64(iv ‖ ciphertext ‖ tag).
 */
export function encryptToBlob(plaintext: string, recipients: RecipientKey[]): BlobPayload {
  const payload = encrypt(plaintext, recipients);
  const iv = Buffer.from(payload.iv, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const blob = Buffer.concat([iv, ciphertext, tag]).toString('base64');
  return { blob, keys: payload.keys };
}

/**
 * Unpack a blob string and decrypt.
 * The blob is base64(iv ‖ ciphertext ‖ tag).
 */
export function decryptFromBlob(blobPayload: BlobPayload, deviceId: string, privateKey: string): string {
  const raw = Buffer.from(blobPayload.blob, 'base64');
  const iv = raw.subarray(0, IV_SIZE).toString('base64');
  const tag = raw.subarray(raw.length - TAG_SIZE).toString('base64');
  const ciphertext = raw.subarray(IV_SIZE, raw.length - TAG_SIZE).toString('base64');
  return decrypt({ iv, ciphertext, tag, keys: blobPayload.keys }, deviceId, privateKey);
}

/**
 * Convert an existing EncryptedPayload to a BlobPayload.
 */
export function payloadToBlob(payload: EncryptedPayload): BlobPayload {
  const iv = Buffer.from(payload.iv, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const blob = Buffer.concat([iv, ciphertext, tag]).toString('base64');
  return { blob, keys: payload.keys };
}

/**
 * Convert a BlobPayload back to an EncryptedPayload.
 */
export function blobToPayload(blobPayload: BlobPayload): EncryptedPayload {
  const raw = Buffer.from(blobPayload.blob, 'base64');
  return {
    iv: raw.subarray(0, IV_SIZE).toString('base64'),
    ciphertext: raw.subarray(IV_SIZE, raw.length - TAG_SIZE).toString('base64'),
    tag: raw.subarray(raw.length - TAG_SIZE).toString('base64'),
    keys: blobPayload.keys,
  };
}

// ── Utilities ───────────────────────────────────────────

/**
 * Export a public key to a compact base64 string (for sending over the wire).
 * Strips PEM headers/footers and newlines.
 */
export function exportPublicKey(pemKey: string): string {
  return pemKey
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\n/g, '')
    .trim();
}

/**
 * Import a compact base64 public key back to PEM format.
 */
export function importPublicKey(compactKey: string): string {
  const lines = compactKey.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

// ── Challenge-response signing ──────────────────────────

import { createSign, createVerify } from 'crypto';

/**
 * Sign a nonce with a private key (for challenge-response auth).
 */
export function signChallenge(nonce: string, privateKeyPem: string): string {
  const sign = createSign('SHA256');
  sign.update(nonce);
  return sign.sign(privateKeyPem, 'base64');
}

/**
 * Verify a signed nonce with a public key.
 */
export function verifyChallenge(nonce: string, signature: string, publicKeyPem: string): boolean {
  const verify = createVerify('SHA256');
  verify.update(nonce);
  return verify.verify(publicKeyPem, signature, 'base64');
}
