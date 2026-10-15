/**
 * @coinfra/crypto — modern hybrid public-key encryption primitives.
 *
 * A small, dependency-free toolkit for encrypting a message to many recipients,
 * plus challenge-response signing. Built entirely on the Web Crypto API, so the
 * same code runs on browsers, Node, Deno, Bun and edge runtimes — no `Buffer`,
 * no `node:*` imports.
 *
 * Cipher suite (v1):
 *   - Key encapsulation : ephemeral X25519 ECDH + HKDF-SHA256  (HPKE-style)
 *   - Payload / key wrap : AES-256-GCM
 *   - Signatures         : Ed25519
 *
 * The envelope carries a version + suite id, so the scheme can evolve without
 * breaking existing ciphertext. This module knows nothing about any
 * application: it moves opaque strings.
 */

// ── Runtime handle ──────────────────────────────────────

let cachedSubtle: SubtleCrypto | undefined;

/**
 * Lazily resolve the Web Crypto `SubtleCrypto` implementation.
 *
 * Reading it at module load throws in runtimes where `globalThis.crypto` is
 * absent; deferring lets the module still be imported and fail only when a
 * primitive is actually used — with a clear, actionable message.
 */
function subtle(): SubtleCrypto {
  if (cachedSubtle) {
    return cachedSubtle;
  }
  const impl = globalThis.crypto?.subtle;
  if (!impl) {
    throw new Error(
      '@coinfra/crypto requires the Web Crypto API (globalThis.crypto.subtle), which is unavailable in this runtime.',
    );
  }
  cachedSubtle = impl;
  return cachedSubtle;
}

/** A `Uint8Array` explicitly backed by a (non-shared) `ArrayBuffer`. */
type Bytes = Uint8Array<ArrayBuffer>;

/** Structural stand-in for the `CryptoKeyPair` global (not present under node-only lib types). */
interface NativeKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

// ── Types ───────────────────────────────────────────────

/** An X25519 (encryption) or Ed25519 (signing) key pair. */
export interface KeyPair {
  /** base64url of the raw public key (32 bytes). */
  publicKey: string;
  /** base64url of the PKCS#8 private key. */
  privateKey: string;
}

/**
 * A key pair whose private key stays a non-extractable {@link CryptoKey}.
 *
 * Unlike {@link KeyPair}, the private key material never becomes a string in JS
 * memory, so it can't be read by injected script (XSS) or serialized by
 * accident. Prefer this for long-lived identity keys, and persist it via
 * IndexedDB (a `CryptoKey` is structured-cloneable) rather than as text.
 */
export interface KeyPairHandle {
  /** base64url of the raw public key (32 bytes) — safe to share as text. */
  publicKey: string;
  /** Non-extractable private key; calling `exportKey` on it rejects. */
  privateKey: CryptoKey;
}

/** A recipient the message should be encrypted for. */
export interface Recipient {
  /** Opaque identifier used to locate this recipient's wrapped key. */
  recipientId: string;
  /** The recipient's X25519 public key (base64url raw), as from `generateEncryptionKeyPair`. */
  publicKey: string;
}

/** Per-recipient key material inside an {@link Envelope}. */
export interface RecipientEntry {
  /** base64url of the ephemeral X25519 public key (32 bytes). */
  epk: string;
  /** base64url of the wrapped content key: `iv(12) ‖ ciphertext ‖ tag`. */
  key: string;
}

/**
 * A self-describing encrypted message. JSON-friendly (every field is a string
 * or a plain object) and safe to transport as-is, or compact it with
 * {@link serializeEnvelope}.
 */
export interface Envelope {
  /** Envelope format version. */
  v: number;
  /** Human-readable cipher-suite identifier. */
  suite: string;
  /** base64url of the AES-256-GCM nonce for the payload (12 bytes). */
  iv: string;
  /** base64url of the payload `ciphertext ‖ tag`. */
  ciphertext: string;
  /** Wrapped content key per recipient, keyed by {@link Recipient.recipientId}. */
  recipients: Record<string, RecipientEntry>;
}

// ── Suite constants ─────────────────────────────────────

const ENVELOPE_VERSION = 1;
const SUITE_ID = 1;
const SUITE_NAME = 'X25519-HKDF-SHA256/AES-256-GCM';
const MAGIC_0 = 0xc0;
const MAGIC_1 = 0x1f;

const IV_SIZE = 12; // 96-bit GCM nonce
const CEK_SIZE = 32; // 256-bit content encryption key
const HKDF_INFO_LABEL = 'coinfra-crypto/v1 kek';
const CHALLENGE_CONTEXT = 'coinfra-crypto/v1 challenge\n';

// ── base64url (runtime-agnostic) ────────────────────────

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_LOOKUP: number[] = (() => {
  const table = new Array<number>(128).fill(-1);
  for (let i = 0; i < B64URL_ALPHABET.length; i++) {
    table[B64URL_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

// biome-ignore-start lint/style/noNonNullAssertion: base64url codec indices are provably in-bounds — the encode loops are length-guarded and the decode lookup table is fully populated for every code point < 128.
function toBase64url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64URL_ALPHABET[(n >> 18) & 63]! +
      B64URL_ALPHABET[(n >> 12) & 63]! +
      B64URL_ALPHABET[(n >> 6) & 63]! +
      B64URL_ALPHABET[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64URL_ALPHABET[(n >> 18) & 63]! + B64URL_ALPHABET[(n >> 12) & 63]!;
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      B64URL_ALPHABET[(n >> 18) & 63]! +
      B64URL_ALPHABET[(n >> 12) & 63]! +
      B64URL_ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

function fromBase64url(text: string): Bytes {
  const len = text.length;
  const fullGroups = Math.floor(len / 4);
  const rem = len - fullGroups * 4;
  if (rem === 1) {
    throw new Error('Invalid base64url string');
  }
  const outLen = fullGroups * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0);
  const out = new Uint8Array(outLen);
  let o = 0;
  let i = 0;
  const dec = (c: number): number => {
    const v = c < 128 ? B64URL_LOOKUP[c]! : -1;
    if (v === -1) {
      throw new Error('Invalid base64url character');
    }
    return v;
  };
  for (let g = 0; g < fullGroups; g++, i += 4) {
    const n =
      (dec(text.charCodeAt(i)) << 18) |
      (dec(text.charCodeAt(i + 1)) << 12) |
      (dec(text.charCodeAt(i + 2)) << 6) |
      dec(text.charCodeAt(i + 3));
    out[o++] = (n >> 16) & 0xff;
    out[o++] = (n >> 8) & 0xff;
    out[o++] = n & 0xff;
  }
  if (rem === 2) {
    const c0 = dec(text.charCodeAt(i));
    const c1 = dec(text.charCodeAt(i + 1));
    if ((c1 & 0x0f) !== 0) {
      throw new Error('Non-canonical base64url string');
    }
    out[o++] = ((c0 << 2) | (c1 >> 4)) & 0xff;
  } else if (rem === 3) {
    const c0 = dec(text.charCodeAt(i));
    const c1 = dec(text.charCodeAt(i + 1));
    const c2 = dec(text.charCodeAt(i + 2));
    if ((c2 & 0x03) !== 0) {
      throw new Error('Non-canonical base64url string');
    }
    out[o++] = ((c0 << 2) | (c1 >> 4)) & 0xff;
    out[o++] = ((c1 << 4) | (c2 >> 2)) & 0xff;
  }
  return out;
}
// biome-ignore-end lint/style/noNonNullAssertion: end of base64url codec.

// ── byte helpers ────────────────────────────────────────

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function utf8(text: string): Bytes {
  return textEncoder.encode(text) as Bytes;
}

function concatBytes(...chunks: Uint8Array[]): Bytes {
  let total = 0;
  for (const c of chunks) {
    total += c.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function randomBytes(size: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(size));
}

// ── Key generation & import ─────────────────────────────

async function exportKeyPair(kp: NativeKeyPair): Promise<KeyPair> {
  const rawPub = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', kp.privateKey));
  return { publicKey: toBase64url(rawPub), privateKey: toBase64url(pkcs8) };
}

/**
 * Generate an X25519 key pair for {@link encrypt}/{@link decrypt}.
 */
export async function generateEncryptionKeyPair(): Promise<KeyPair> {
  const kp = (await subtle().generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])) as unknown as NativeKeyPair;
  return exportKeyPair(kp);
}

/**
 * Generate an Ed25519 key pair for {@link signChallenge}/{@link verifyChallenge}.
 */
export async function generateSigningKeyPair(): Promise<KeyPair> {
  const kp = (await subtle().generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as NativeKeyPair;
  return exportKeyPair(kp);
}

function importX25519Public(publicKey: string): Promise<CryptoKey> {
  return subtle().importKey('raw', fromBase64url(publicKey), { name: 'X25519' }, true, []);
}

function importX25519Private(privateKey: string): Promise<CryptoKey> {
  return subtle().importKey('pkcs8', fromBase64url(privateKey), { name: 'X25519' }, false, [
    'deriveBits',
  ]);
}

function importEd25519Private(privateKey: string): Promise<CryptoKey> {
  return subtle().importKey('pkcs8', fromBase64url(privateKey), { name: 'Ed25519' }, false, [
    'sign',
  ]);
}

async function exportRawPublic(kp: NativeKeyPair): Promise<string> {
  return toBase64url(new Uint8Array(await subtle().exportKey('raw', kp.publicKey)));
}

function resolveX25519Private(key: string | CryptoKey): Promise<CryptoKey> {
  return typeof key === 'string' ? importX25519Private(key) : Promise.resolve(key);
}

function resolveEd25519Private(key: string | CryptoKey): Promise<CryptoKey> {
  return typeof key === 'string' ? importEd25519Private(key) : Promise.resolve(key);
}

/**
 * Generate an X25519 key pair whose private key is a non-extractable
 * {@link CryptoKey} (never materialized as a string), for
 * {@link encrypt}/{@link decrypt}. Prefer this over
 * {@link generateEncryptionKeyPair} for long-lived identity keys.
 */
export async function generateEncryptionKeyPairHandle(): Promise<KeyPairHandle> {
  const kp = (await subtle().generateKey({ name: 'X25519' }, false, [
    'deriveBits',
  ])) as unknown as NativeKeyPair;
  return { publicKey: await exportRawPublic(kp), privateKey: kp.privateKey };
}

/**
 * Generate an Ed25519 key pair whose private key is a non-extractable
 * {@link CryptoKey}, for {@link signChallenge}/{@link verifyChallenge}.
 */
export async function generateSigningKeyPairHandle(): Promise<KeyPairHandle> {
  const kp = (await subtle().generateKey({ name: 'Ed25519' }, false, [
    'sign',
    'verify',
  ])) as unknown as NativeKeyPair;
  return { publicKey: await exportRawPublic(kp), privateKey: kp.privateKey };
}

/**
 * Import a base64url PKCS#8 X25519 private key as a reusable, non-extractable
 * {@link CryptoKey}. Import once and pass the handle to {@link decrypt} to skip
 * re-importing the key on every message.
 */
export function importEncryptionPrivateKey(privateKey: string): Promise<CryptoKey> {
  return importX25519Private(privateKey);
}

/**
 * Import a base64url PKCS#8 Ed25519 private key as a reusable, non-extractable
 * {@link CryptoKey} for {@link signChallenge}.
 */
export function importSigningPrivateKey(privateKey: string): Promise<CryptoKey> {
  return importEd25519Private(privateKey);
}

// ── Key encapsulation (HPKE-style) ──────────────────────

/** Additional authenticated data binding a wrapped key to its ephemeral key and recipient. */
function wrapAad(epkRaw: Bytes, recipientId: string): Bytes {
  return concatBytes(epkRaw, utf8(recipientId));
}

/** Additional authenticated data binding the payload to this exact suite + version. */
function contentAad(): Bytes {
  return utf8(`${SUITE_NAME}#${ENVELOPE_VERSION}`);
}

async function deriveKek(sharedSecret: Bytes, epkRaw: Bytes): Promise<CryptoKey> {
  const ikm = await subtle().importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']);
  const info = concatBytes(textEncoder.encode(HKDF_INFO_LABEL), epkRaw);
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    ikm,
    256,
  );
  return subtle().importKey('raw', new Uint8Array(bits), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function wrapForRecipient(
  cek: Bytes,
  recipientId: string,
  recipientPublicKey: string,
): Promise<RecipientEntry> {
  const ephemeral = (await subtle().generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])) as unknown as NativeKeyPair;
  const recipientPub = await importX25519Public(recipientPublicKey);
  const sharedSecret = new Uint8Array(
    await subtle().deriveBits({ name: 'X25519', public: recipientPub }, ephemeral.privateKey, 256),
  );
  const epkRaw = new Uint8Array(await subtle().exportKey('raw', ephemeral.publicKey));
  const kek = await deriveKek(sharedSecret, epkRaw);

  const iv = randomBytes(IV_SIZE);
  const wrapped = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv, additionalData: wrapAad(epkRaw, recipientId) },
      kek,
      cek,
    ),
  );
  return { epk: toBase64url(epkRaw), key: toBase64url(concatBytes(iv, wrapped)) };
}

async function unwrapContentKey(
  entry: RecipientEntry,
  recipientId: string,
  privateKey: string | CryptoKey,
): Promise<Bytes> {
  const epkRaw = fromBase64url(entry.epk);
  const ephemeralPub = await importX25519Public(entry.epk);
  const recipientPriv = await resolveX25519Private(privateKey);
  const sharedSecret = new Uint8Array(
    await subtle().deriveBits({ name: 'X25519', public: ephemeralPub }, recipientPriv, 256),
  );
  const kek = await deriveKek(sharedSecret, epkRaw);

  const raw = fromBase64url(entry.key);
  const iv = raw.subarray(0, IV_SIZE);
  const ciphertext = raw.subarray(IV_SIZE);
  return new Uint8Array(
    await subtle().decrypt(
      { name: 'AES-GCM', iv, additionalData: wrapAad(epkRaw, recipientId) },
      kek,
      ciphertext,
    ),
  );
}

// ── Encryption ──────────────────────────────────────────

/**
 * Encrypt a message for one or more recipients.
 *
 * A fresh content key encrypts the payload with AES-256-GCM; that key is then
 * wrapped independently for each recipient via ephemeral X25519 + HKDF-SHA256.
 *
 * @throws If `recipients` is empty.
 */
export async function encrypt(plaintext: string, recipients: Recipient[]): Promise<Envelope> {
  if (recipients.length === 0) {
    throw new Error('At least one recipient required');
  }

  const cek = randomBytes(CEK_SIZE);
  const contentKey = await subtle().importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = randomBytes(IV_SIZE);
  const ciphertext = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv, additionalData: contentAad() },
      contentKey,
      utf8(plaintext),
    ),
  );

  const wrapped = await Promise.all(
    recipients.map(
      async (recipient) =>
        [
          recipient.recipientId,
          await wrapForRecipient(cek, recipient.recipientId, recipient.publicKey),
        ] as const,
    ),
  );
  const recipientMap: Record<string, RecipientEntry> = Object.fromEntries(wrapped);

  return {
    v: ENVELOPE_VERSION,
    suite: SUITE_NAME,
    iv: toBase64url(iv),
    ciphertext: toBase64url(ciphertext),
    recipients: recipientMap,
  };
}

/**
 * Decrypt a message addressed to `recipientId` using its X25519 private key.
 *
 * @throws If `recipientId` has no wrapped key, or decryption/authentication fails.
 */
export async function decrypt(
  envelope: Envelope,
  recipientId: string,
  privateKey: string | CryptoKey,
): Promise<string> {
  if (envelope.v !== ENVELOPE_VERSION || envelope.suite !== SUITE_NAME) {
    throw new Error(`Unsupported envelope (v${envelope.v}, suite "${envelope.suite}")`);
  }

  const entry = envelope.recipients[recipientId];
  if (!entry) {
    throw new Error(`No encrypted key found for recipient "${recipientId}"`);
  }

  const cek = await unwrapContentKey(entry, recipientId, privateKey);
  const contentKey = await subtle().importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromBase64url(envelope.iv), additionalData: contentAad() },
    contentKey,
    fromBase64url(envelope.ciphertext),
  );
  return textDecoder.decode(plaintext);
}

// ── Compact binary envelope ─────────────────────────────

/**
 * Serialize an {@link Envelope} into a single compact, self-describing
 * base64url string (`magic ‖ version ‖ suite ‖ …`).
 */
export function serializeEnvelope(envelope: Envelope): string {
  if (envelope.v !== ENVELOPE_VERSION || envelope.suite !== SUITE_NAME) {
    throw new Error(
      `Cannot serialize unsupported envelope (v${envelope.v}, suite "${envelope.suite}")`,
    );
  }
  const iv = fromBase64url(envelope.iv);
  const ciphertext = fromBase64url(envelope.ciphertext);
  const recipientIds = Object.keys(envelope.recipients);

  if (iv.length > 0xff) {
    throw new Error('IV too large to serialize');
  }
  if (ciphertext.length > 0xffff_ffff) {
    throw new Error('Ciphertext too large to serialize');
  }
  if (recipientIds.length > 0xffff) {
    throw new Error('Too many recipients to serialize');
  }

  const parts: Uint8Array[] = [];
  const header = new Uint8Array([MAGIC_0, MAGIC_1, ENVELOPE_VERSION, SUITE_ID]);
  parts.push(header);
  parts.push(u8(iv.length), iv);
  parts.push(u32(ciphertext.length), ciphertext);
  parts.push(u16(recipientIds.length));
  for (const [id, entry] of Object.entries(envelope.recipients)) {
    const idBytes = textEncoder.encode(id);
    const epk = fromBase64url(entry.epk);
    const key = fromBase64url(entry.key);
    if (idBytes.length > 0xffff || epk.length > 0xffff || key.length > 0xffff) {
      throw new Error(`Recipient "${id}" field too large to serialize`);
    }
    parts.push(u16(idBytes.length), idBytes);
    parts.push(u16(epk.length), epk);
    parts.push(u16(key.length), key);
  }
  return toBase64url(concatBytes(...parts));
}

/**
 * Parse a string produced by {@link serializeEnvelope} back into an
 * {@link Envelope}.
 *
 * @throws If the magic bytes, version or suite are not recognized.
 */
export function deserializeEnvelope(blob: string): Envelope {
  const bytes = fromBase64url(blob);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const need = (n: number): void => {
    if (p + n > bytes.length) {
      throw new Error('Truncated envelope');
    }
  };

  need(4);
  if (bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1) {
    throw new Error('Not a coinfra crypto envelope');
  }
  if (bytes[2] !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported envelope version ${bytes[2]}`);
  }
  if (bytes[3] !== SUITE_ID) {
    throw new Error(`Unsupported cipher suite ${bytes[3]}`);
  }
  p = 4;

  need(1);
  const ivLen = bytes[p++] ?? 0;
  need(ivLen);
  const iv = bytes.subarray(p, p + ivLen);
  p += ivLen;

  need(4);
  const ctLen = view.getUint32(p);
  p += 4;
  need(ctLen);
  const ciphertext = bytes.subarray(p, p + ctLen);
  p += ctLen;

  need(2);
  const count = view.getUint16(p);
  p += 2;

  const recipients: Record<string, RecipientEntry> = {};
  for (let i = 0; i < count; i++) {
    need(2);
    const idLen = view.getUint16(p);
    p += 2;
    need(idLen);
    const id = textDecoder.decode(bytes.subarray(p, p + idLen));
    p += idLen;

    need(2);
    const epkLen = view.getUint16(p);
    p += 2;
    need(epkLen);
    const epk = bytes.subarray(p, p + epkLen);
    p += epkLen;

    need(2);
    const keyLen = view.getUint16(p);
    p += 2;
    need(keyLen);
    const key = bytes.subarray(p, p + keyLen);
    p += keyLen;

    recipients[id] = { epk: toBase64url(epk), key: toBase64url(key) };
  }

  return {
    v: ENVELOPE_VERSION,
    suite: SUITE_NAME,
    iv: toBase64url(iv),
    ciphertext: toBase64url(ciphertext),
    recipients,
  };
}

function u8(n: number): Bytes {
  return new Uint8Array([n & 0xff]);
}

function u16(n: number): Bytes {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n);
  return b;
}

function u32(n: number): Bytes {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

/**
 * Encrypt and pack into a single self-contained base64url string.
 * Convenience wrapper over {@link encrypt} + {@link serializeEnvelope}.
 */
export async function encryptToBlob(plaintext: string, recipients: Recipient[]): Promise<string> {
  return serializeEnvelope(await encrypt(plaintext, recipients));
}

/**
 * Unpack a string from {@link encryptToBlob} and decrypt it.
 */
export async function decryptFromBlob(
  blob: string,
  recipientId: string,
  privateKey: string | CryptoKey,
): Promise<string> {
  return decrypt(deserializeEnvelope(blob), recipientId, privateKey);
}

// ── Challenge-response signing (Ed25519) ────────────────

/** Domain-separated bytes to sign, so a challenge signature can't be replayed on another surface. */
function challengeBytes(nonce: string): Bytes {
  return concatBytes(utf8(CHALLENGE_CONTEXT), utf8(nonce));
}

/**
 * Sign a nonce with an Ed25519 private key (for challenge-response auth).
 * Returns the base64url signature.
 */
export async function signChallenge(
  nonce: string,
  privateKey: string | CryptoKey,
): Promise<string> {
  const key = await resolveEd25519Private(privateKey);
  const sig = await subtle().sign({ name: 'Ed25519' }, key, challengeBytes(nonce));
  return toBase64url(new Uint8Array(sig));
}

/**
 * Verify a base64url Ed25519 signature over `nonce` against a public key.
 * Never throws — returns `false` on any malformed input.
 */
export async function verifyChallenge(
  nonce: string,
  signature: string,
  publicKey: string,
): Promise<boolean> {
  try {
    const key = await subtle().importKey(
      'raw',
      fromBase64url(publicKey),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await subtle().verify(
      { name: 'Ed25519' },
      key,
      fromBase64url(signature),
      challengeBytes(nonce),
    );
  } catch {
    return false;
  }
}

// ── Canonical JSON ──────────────────────────────────────

/**
 * Stable JSON serialization with recursively sorted keys and no insignificant
 * whitespace, aligned with RFC 8785 (JSON Canonicalization Scheme).
 *
 * Both signer and verifier MUST use this exact function — any divergence
 * (insertion-order keys, extra whitespace) breaks signature verification.
 * Unlike a shallow sort, nested objects and arrays are canonicalized too, so
 * arbitrarily-shaped payloads sign consistently.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}
