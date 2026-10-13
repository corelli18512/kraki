/**
 * E2E v2 — the @coinfra/crypto suite v1 (X25519 + HKDF-SHA256 + AES-256-GCM)
 * implemented on Node's synchronous crypto so Tentacle can encrypt in order
 * without awaiting. Byte-compatible with @coinfra/crypto (TypeScript, Web
 * Crypto) and CoinfraCrypto (Swift, CryptoKit): the cross-implementation test
 * vectors in __tests__/fixtures are opened by all three.
 *
 * Wire shape inside a Pulse payload: `{ "v": 2, "blob": <compact envelope> }`
 * (the legacy RSA payload is `{ blob, keys }`). A sender uses v2 only for
 * peers that announced an X25519 key and the `e2e_v2` feature.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

export const E2E_V2_FEATURE = 'e2e_v2';

const ENVELOPE_VERSION = 1;
const SUITE_ID = 1;
const SUITE_NAME = 'X25519-HKDF-SHA256/AES-256-GCM';
const MAGIC = [0xc0, 0x1f] as const;
const IV_SIZE = 12;
const TAG_SIZE = 16;
const CEK_SIZE = 32;
const HKDF_INFO_LABEL = Buffer.from('coinfra-crypto/v1 kek', 'utf8');
const CONTENT_AAD = Buffer.from(`${SUITE_NAME}#${ENVELOPE_VERSION}`, 'utf8');

export interface E2EKeyPair {
  /** base64url raw 32-byte X25519 public key. */
  publicKey: string;
  /** base64url PKCS#8 X25519 private key. */
  privateKey: string;
}

export interface E2ERecipient {
  recipientId: string;
  /** base64url raw 32-byte X25519 public key. */
  publicKey: string;
}

/** A Pulse payload in the v2 format. */
export interface V2Payload {
  v: 2;
  blob: string;
}

export function isV2Payload(value: unknown): value is V2Payload {
  return typeof value === 'object' && value !== null
    && (value as { v?: unknown }).v === 2
    && typeof (value as { blob?: unknown }).blob === 'string';
}

// ── base64url (canonical, unpadded) ─────────────────────

function toB64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function fromB64url(text: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new Error('Invalid base64url string');
  }
  const out = Buffer.from(text, 'base64url');
  if (out.toString('base64url') !== text) throw new Error('Non-canonical base64url string');
  return out;
}

// ── Keys ────────────────────────────────────────────────

export function generateE2EKeyPair(): E2EKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: rawPublic(publicKey),
    privateKey: toB64url(privateKey.export({ format: 'der', type: 'pkcs8' })),
  };
}

/** Import a base64url PKCS#8 private key once for repeated {@link decryptV2}. */
export function importE2EPrivateKey(privateKey: string): KeyObject {
  return createPrivateKey({ key: fromB64url(privateKey), format: 'der', type: 'pkcs8' });
}

/** The raw base64url public key of a private key. */
export function e2ePublicKeyOf(privateKey: string | KeyObject): string {
  const key = typeof privateKey === 'string' ? importE2EPrivateKey(privateKey) : privateKey;
  return rawPublic(createPublicKey(key));
}

function rawPublic(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('Not an X25519 public key');
  return jwk.x;
}

function importRawPublic(publicKey: string): KeyObject {
  const raw = fromB64url(publicKey);
  if (raw.length !== 32) throw new Error('Invalid X25519 public key');
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: publicKey }, format: 'jwk' });
}

// ── Key encapsulation ───────────────────────────────────

function kek(privateKey: KeyObject, publicKey: KeyObject, epk: Buffer): Buffer {
  const shared = diffieHellman({ privateKey, publicKey });
  // A low-order peer key yields an all-zero secret (Web Crypto rejects it).
  if (shared.every((b) => b === 0)) throw new Error('Low-order X25519 public key');
  return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.concat([HKDF_INFO_LABEL, epk]), 32));
}

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): { iv: Buffer; sealed: Buffer } {
  const iv = randomBytes(IV_SIZE);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, sealed: Buffer.concat([ct, cipher.getAuthTag()]) };
}

function open(key: Buffer, iv: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (sealed.length < TAG_SIZE) throw new Error('Ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_SIZE));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_SIZE)), decipher.final()]);
}

// ── Compact envelope ────────────────────────────────────

/** Encrypt once for every recipient; returns the compact base64url envelope. */
export function encryptV2(plaintext: string, recipients: E2ERecipient[]): string {
  if (recipients.length === 0) throw new Error('At least one recipient required');
  const cek = randomBytes(CEK_SIZE);
  const content = seal(cek, Buffer.from(plaintext, 'utf8'), CONTENT_AAD);

  const parts: Buffer[] = [
    Buffer.from([...MAGIC, ENVELOPE_VERSION, SUITE_ID]),
    u8(content.iv.length), content.iv,
    u32(content.sealed.length), content.sealed,
    u16(recipients.length),
  ];
  for (const r of recipients) {
    const recipientKey = importRawPublic(r.publicKey);
    const eph = generateKeyPairSync('x25519');
    const epk = fromB64url(rawPublic(eph.publicKey));
    const id = Buffer.from(r.recipientId, 'utf8');
    const wrapped = seal(kek(eph.privateKey, recipientKey, epk), cek, Buffer.concat([epk, id]));
    const key = Buffer.concat([wrapped.iv, wrapped.sealed]);
    parts.push(u16(id.length), id, u16(epk.length), epk, u16(key.length), key);
  }
  return toB64url(Buffer.concat(parts));
}

/** Decrypt a compact envelope addressed to `recipientId`. */
export function decryptV2(blob: string, recipientId: string, privateKey: string | KeyObject): string {
  const bytes = fromB64url(blob);
  let p = 0;
  const take = (n: number): Buffer => {
    if (p + n > bytes.length) throw new Error('Truncated envelope');
    const out = bytes.subarray(p, p + n);
    p += n;
    return out;
  };
  const head = take(4);
  if (head[0] !== MAGIC[0] || head[1] !== MAGIC[1]) throw new Error('Not a coinfra crypto envelope');
  if (head[2] !== ENVELOPE_VERSION) throw new Error(`Unsupported envelope version ${head[2]}`);
  if (head[3] !== SUITE_ID) throw new Error(`Unsupported cipher suite ${head[3]}`);
  const iv = take(take(1)[0]!);
  const ct = take(take(4).readUInt32BE(0));
  const count = take(2).readUInt16BE(0);

  let entry: { epk: Buffer; key: Buffer } | undefined;
  for (let i = 0; i < count; i++) {
    const id = take(take(2).readUInt16BE(0)).toString('utf8');
    const epk = take(take(2).readUInt16BE(0));
    const key = take(take(2).readUInt16BE(0));
    if (id === recipientId && !entry) entry = { epk, key };
  }
  if (!entry) throw new Error(`No encrypted key found for recipient "${recipientId}"`);

  const priv = typeof privateKey === 'string' ? importE2EPrivateKey(privateKey) : privateKey;
  if (entry.key.length < IV_SIZE + TAG_SIZE) throw new Error('Wrapped key too short');
  const wrapKey = kek(priv, importRawPublic(toB64url(entry.epk)), entry.epk);
  const cek = open(
    wrapKey,
    entry.key.subarray(0, IV_SIZE),
    entry.key.subarray(IV_SIZE),
    Buffer.concat([entry.epk, Buffer.from(recipientId, 'utf8')]),
  );
  if (cek.length !== CEK_SIZE) throw new Error('Invalid content key');
  return open(cek, iv, ct, CONTENT_AAD).toString('utf8');
}

function u8(n: number): Buffer { return Buffer.from([n & 0xff]); }
function u16(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
