/**
 * App-side E2E encryption + challenge-response auth.
 *
 * Browser: Web Crypto API (non-extractable keys) + IndexedDB storage.
 * The private key NEVER leaves the browser's crypto engine.
 *
 * Two key pairs are used:
 * - Signing key (RSASSA-PKCS1-v1_5): for challenge-response auth
 * - Encryption key (RSA-OAEP): for E2E message decryption
 */

// ── Types ───────────────────────────────────────────────

export interface RecipientKey {
  deviceId: string;
  publicKeyBase64: string;
}

export interface EncryptedPayload {
  iv: string;
  ciphertext: string;
  tag: string;
  keys: Record<string, string>;
}

export type { BlobPayload } from '@kraki/protocol';
import type { BlobPayload } from '@kraki/protocol';

export interface AppKeyStore {
  /** Initialize: load existing keys from storage or generate new ones */
  init(): Promise<void>;
  /** Get the encryption public key (RSA-OAEP, base64) for E2E */
  getPublicKey(): Promise<string>;
  /** Get the signing public key (RSASSA-PKCS1-v1_5, base64) for auth */
  getSigningPublicKey(): Promise<string>;
  /** Sign a challenge nonce (for return-visit auth) */
  signChallenge(nonce: string): Promise<string>;
  /** Decrypt an E2E encrypted message (legacy separate-field format) */
  decrypt(payload: { iv: string; ciphertext: string; tag: string; keys: Record<string, string> }, deviceId: string): Promise<string>;
  /** Encrypt a message for multiple recipient devices (legacy separate-field format) */
  encrypt(plaintext: string, recipients: RecipientKey[]): Promise<EncryptedPayload>;
  /** Encrypt to consolidated blob format: base64(iv ‖ ciphertext ‖ tag) */
  encryptToBlob(plaintext: string, recipients: RecipientKey[]): Promise<BlobPayload>;
  /** Decrypt from consolidated blob format */
  decryptFromBlob(payload: { blob: string; keys: Record<string, string> }, deviceId: string): Promise<string>;
  /** Has keys been initialized? */
  isReady(): boolean;
}

// ── IndexedDB helpers ───────────────────────────────────

const DB_NAME = 'kraki-keys';
const STORE_NAME = 'keypair';
const KEY_ID = 'device-key';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── RSA config ──────────────────────────────────────────

const RSA_SIGN_ALGORITHM: RsaHashedKeyGenParams = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 4096,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};

const RSA_ENCRYPT_ALGORITHM: RsaHashedKeyGenParams = {
  name: 'RSA-OAEP',
  modulusLength: 4096,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};

// ── Browser implementation ──────────────────────────────

const SIGN_KEY_ID = 'device-sign-key';
const ENCRYPT_KEY_ID = 'device-encrypt-key';

export class BrowserAppKeyStore implements AppKeyStore {
  private signKeyPair: CryptoKeyPair | null = null;
  private encryptKeyPair: CryptoKeyPair | null = null;
  private encryptPublicKeyBase64: string | null = null;
  private signPublicKeyBase64: string | null = null;
  private ready = false;

  async init(): Promise<void> {
    const db = await openDB();

    // Migrate legacy key: old code stored a single key as 'device-key'
    const legacyKey = await idbGet(db, 'device-key');

    // Load or generate signing key pair
    const storedSign = await idbGet(db, SIGN_KEY_ID);
    if (storedSign) {
      this.signKeyPair = storedSign;
    } else if (legacyKey) {
      // Migrate: use legacy key as signing key
      this.signKeyPair = legacyKey;
      await idbPut(db, SIGN_KEY_ID, legacyKey);
    } else {
      this.signKeyPair = await crypto.subtle.generateKey(
        RSA_SIGN_ALGORITHM,
        false,
        ['sign', 'verify'],
      );
      await idbPut(db, SIGN_KEY_ID, this.signKeyPair);
    }

    // Load or generate encryption key pair
    const storedEncrypt = await idbGet(db, ENCRYPT_KEY_ID);
    if (storedEncrypt) {
      this.encryptKeyPair = storedEncrypt;
    } else {
      this.encryptKeyPair = await crypto.subtle.generateKey(
        RSA_ENCRYPT_ALGORITHM,
        false, // non-extractable private key
        ['encrypt', 'decrypt'],  // public encrypts, private decrypts
      );
      // Note: we need to be able to export the public key but not the private key.
      // Web Crypto allows exporting public keys even when extractable=false.
      await idbPut(db, ENCRYPT_KEY_ID, this.encryptKeyPair);
    }

    if (!this.encryptKeyPair || !this.signKeyPair) {
      throw new Error('Key pair generation failed');
    }

    // The public key we send to the head is the ENCRYPTION public key
    // (so tentacles can encrypt messages for us)
    this.encryptPublicKeyBase64 = await this.exportPublicKey(this.encryptKeyPair.publicKey);
    this.signPublicKeyBase64 = await this.exportPublicKey(this.signKeyPair.publicKey);
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  async getPublicKey(): Promise<string> {
    if (!this.encryptPublicKeyBase64) throw new Error('Keys not initialized');
    return this.encryptPublicKeyBase64;
  }

  async getSigningPublicKey(): Promise<string> {
    if (!this.signPublicKeyBase64) throw new Error('Keys not initialized');
    return this.signPublicKeyBase64;
  }

  async signChallenge(nonce: string): Promise<string> {
    if (!this.signKeyPair) throw new Error('Keys not initialized');

    const encoder = new TextEncoder();
    const data = encoder.encode(nonce);

    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      this.signKeyPair.privateKey,
      data,
    );

    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  async decrypt(
    payload: { iv: string; ciphertext: string; tag: string; keys: Record<string, string> },
    deviceId: string,
  ): Promise<string> {
    if (!this.encryptKeyPair) throw new Error('Keys not initialized');

    const wrappedKeyB64 = payload.keys[deviceId];
    if (!wrappedKeyB64) {
      throw new Error(`No encrypted key found for device "${deviceId}"`);
    }

    // 1. Unwrap AES key with our RSA-OAEP private key
    const wrappedKey = Uint8Array.from(atob(wrappedKeyB64), c => c.charCodeAt(0));
    const aesKeyRaw = await crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
      this.encryptKeyPair.privateKey,
      wrappedKey,
    );

    // 2. Import AES key
    const aesKey = await crypto.subtle.importKey(
      'raw',
      aesKeyRaw,
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );

    // 3. Decrypt ciphertext with AES-256-GCM
    // Web Crypto AES-GCM expects tag appended to ciphertext
    const cipherBytes = Uint8Array.from(atob(payload.ciphertext), c => c.charCodeAt(0));
    const tagBytes = Uint8Array.from(atob(payload.tag), c => c.charCodeAt(0));
    const ivBytes = Uint8Array.from(atob(payload.iv), c => c.charCodeAt(0));

    // Concatenate ciphertext + tag (Web Crypto GCM expects them together)
    const combined = new Uint8Array(cipherBytes.length + tagBytes.length);
    combined.set(cipherBytes);
    combined.set(tagBytes, cipherBytes.length);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes, tagLength: 128 },
      aesKey,
      combined,
    );

    return new TextDecoder().decode(decrypted);
  }

  async encrypt(plaintext: string, recipients: RecipientKey[]): Promise<EncryptedPayload> {
    if (recipients.length === 0) throw new Error('At least one recipient required');

    // 1. Generate random AES-256 key and IV
    const aesKeyRaw = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // 2. Import AES key
    const aesKey = await crypto.subtle.importKey(
      'raw', aesKeyRaw, { name: 'AES-GCM' }, true, ['encrypt'],
    );

    // 3. Encrypt plaintext with AES-256-GCM
    const encoded = new TextEncoder().encode(plaintext);
    const encryptedBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      aesKey, encoded,
    );

    // Web Crypto appends tag to ciphertext — split them
    const encryptedArr = new Uint8Array(encryptedBuf);
    const ciphertext = encryptedArr.slice(0, encryptedArr.length - 16);
    const tag = encryptedArr.slice(encryptedArr.length - 16);

    // 4. Wrap AES key for each recipient's RSA-OAEP public key
    const keys: Record<string, string> = {};
    for (const r of recipients) {
      const spkiBytes = Uint8Array.from(atob(r.publicKeyBase64), c => c.charCodeAt(0));
      const pubKey = await crypto.subtle.importKey(
        'spki', spkiBytes, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'],
      );
      const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pubKey, aesKeyRaw);
      keys[r.deviceId] = btoa(String.fromCharCode(...new Uint8Array(wrapped)));
    }

    return {
      iv: btoa(String.fromCharCode(...iv)),
      ciphertext: btoa(String.fromCharCode(...ciphertext)),
      tag: btoa(String.fromCharCode(...tag)),
      keys,
    };
  }

  async encryptToBlob(plaintext: string, recipients: RecipientKey[]): Promise<BlobPayload> {
    const result = await this.encrypt(plaintext, recipients);
    // Pack iv + ciphertext + tag into a single blob
    const ivBytes = Uint8Array.from(atob(result.iv), c => c.charCodeAt(0));
    const cipherBytes = Uint8Array.from(atob(result.ciphertext), c => c.charCodeAt(0));
    const tagBytes = Uint8Array.from(atob(result.tag), c => c.charCodeAt(0));
    const combined = new Uint8Array(ivBytes.length + cipherBytes.length + tagBytes.length);
    combined.set(ivBytes, 0);
    combined.set(cipherBytes, ivBytes.length);
    combined.set(tagBytes, ivBytes.length + cipherBytes.length);
    return {
      blob: btoa(String.fromCharCode(...combined)),
      keys: result.keys,
    };
  }

  async decryptFromBlob(
    payload: { blob: string; keys: Record<string, string> },
    deviceId: string,
  ): Promise<string> {
    // Unpack blob: iv (12 bytes) + ciphertext (N) + tag (16 bytes)
    const raw = Uint8Array.from(atob(payload.blob), c => c.charCodeAt(0));
    const iv = btoa(String.fromCharCode(...raw.slice(0, 12)));
    const tag = btoa(String.fromCharCode(...raw.slice(raw.length - 16)));
    const ciphertext = btoa(String.fromCharCode(...raw.slice(12, raw.length - 16)));
    return this.decrypt({ iv, ciphertext, tag, keys: payload.keys }, deviceId);
  }

  private async exportPublicKey(key: CryptoKey): Promise<string> {
    const exported = await crypto.subtle.exportKey('spki', key);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
    return base64;
  }
}

// ── Factory ─────────────────────────────────────────────

/**
 * Create the appropriate key store for the current environment.
 * In browser: always uses Web Crypto API + IndexedDB.
 */
export function createAppKeyStore(): AppKeyStore {
  return new BrowserAppKeyStore();
}
