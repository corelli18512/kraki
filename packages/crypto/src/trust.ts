/**
 * Device trust — who may command whom, independent of the relay.
 *
 * E2E encryption alone keeps a compromised relay from *reading* messages it
 * cannot decrypt, but the relay distributes public keys, so it can swap keys
 * and it can encrypt new commands to a computer's public key. This module adds
 * what closes that gap:
 *
 * - **Identity keys** (Ed25519). Each device has one; the private half never
 *   leaves the device. Peers pin each other's identity key at pairing time, not
 *   from the relay.
 * - **Signed messages.** Every message is wrapped in a {@link SignedMessage}
 *   before encryption. The receiver checks the signature against the pinned
 *   identity key of the claimed sender, the recipient binding and freshness.
 * - **Pairing proofs.** The computer's pairing QR carries a one-time secret.
 *   The app proves knowledge of it with an HMAC over the keys it is enrolling,
 *   so the relay — which never sees the QR — cannot enroll its own keys.
 *
 * Byte-compatible with the Swift implementation in
 * packages/arm/ios/Kraki/Core/Crypto/DeviceTrust.swift (shared test vectors in
 * __tests__/fixtures/trust-vectors.json).
 */

import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';

/** Wire marker of a signed message inside the E2E plaintext. */
export const SIGNED_MESSAGE_VERSION = 1;
/** Recipient for messages encrypted to more than one device. */
export const ANY_RECIPIENT = '*';
/** Feature a computer advertises when it enforces device trust. */
export const DEVICE_TRUST_FEATURE = 'device_trust';

const SIG_CONTEXT = 'kraki-sig/1';
const PAIR_CONTEXT = 'kraki-pair/1';

// ── base64url (canonical, unpadded) ─────────────────────

function toB64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function fromB64url(text: string): Buffer {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new Error('Invalid base64url string');
  }
  const out = Buffer.from(text, 'base64url');
  if (out.toString('base64url') !== text) throw new Error('Non-canonical base64url string');
  return out;
}

// ── Identity keys (Ed25519) ─────────────────────────────

export interface IdentityKeyPair {
  /** base64url raw 32-byte Ed25519 public key. */
  publicKey: string;
  /** base64url PKCS#8 Ed25519 private key. */
  privateKey: string;
}

export function generateIdentityKeyPair(): IdentityKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: rawEd25519Public(publicKey),
    privateKey: toB64url(privateKey.export({ format: 'der', type: 'pkcs8' })),
  };
}

export function importIdentityPrivateKey(privateKey: string): KeyObject {
  const key = createPrivateKey({ key: fromB64url(privateKey), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Not an Ed25519 private key');
  return key;
}

export function identityPublicKeyOf(privateKey: string | KeyObject): string {
  const key = typeof privateKey === 'string' ? importIdentityPrivateKey(privateKey) : privateKey;
  return rawEd25519Public(createPublicKey(key));
}

function rawEd25519Public(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' }) as { crv?: string; x?: string };
  if (jwk.crv !== 'Ed25519' || !jwk.x) throw new Error('Not an Ed25519 public key');
  return jwk.x;
}

const publicKeyCache = new Map<string, KeyObject>();

function importIdentityPublicKey(publicKey: string): KeyObject {
  const cached = publicKeyCache.get(publicKey);
  if (cached) return cached;
  if (fromB64url(publicKey).length !== 32) throw new Error('Invalid Ed25519 public key');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
  if (publicKeyCache.size > 256) publicKeyCache.clear();
  publicKeyCache.set(publicKey, key);
  return key;
}

/** True for a well-formed base64url raw 32-byte public key (Ed25519 or X25519). */
export function isRawPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 43) return false;
  try { return fromB64url(value).length === 32; } catch { return false; }
}

/** Short, human-comparable fingerprint of a public key (base64url, 16 bytes of SHA-256). */
export function keyFingerprint(publicKey: string): string {
  return createHash('sha256').update(publicKey, 'utf8').digest().subarray(0, 16).toString('base64url');
}

// ── Signed messages ─────────────────────────────────────

/**
 * A message as it appears inside the E2E plaintext when device trust is on.
 * `body` is the original message JSON, kept as the exact signed string.
 */
export interface SignedMessage {
  /** Format marker. */
  ks: typeof SIGNED_MESSAGE_VERSION;
  /** Sender device ID. */
  from: string;
  /** Recipient device ID, or {@link ANY_RECIPIENT} for multi-recipient payloads. */
  to: string;
  /** Sender clock, Unix milliseconds. */
  ts: number;
  /** 16 random bytes, base64url — unique per message (replay detection). */
  nonce: string;
  /** The inner message JSON. */
  body: string;
  /** Ed25519 signature, base64url. */
  sig: string;
}

export function isSignedMessage(value: unknown): value is SignedMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.ks === SIGNED_MESSAGE_VERSION
    && typeof v.from === 'string' && typeof v.to === 'string'
    && typeof v.ts === 'number' && Number.isSafeInteger(v.ts)
    && typeof v.nonce === 'string' && typeof v.body === 'string' && typeof v.sig === 'string';
}

function signingInput(m: Pick<SignedMessage, 'from' | 'to' | 'ts' | 'nonce' | 'body'>): Buffer {
  return Buffer.from(`${SIG_CONTEXT}\n${m.from}\n${m.to}\n${m.ts}\n${m.nonce}\n${m.body}`, 'utf8');
}

export interface SignOptions {
  /** Override the clock (tests / vectors). */
  ts?: number;
  /** Override the nonce (tests / vectors). */
  nonce?: string;
}

/** Wrap `body` (a JSON string) in a signed message from `from` to `to`. */
export function signMessage(
  body: string,
  from: string,
  to: string,
  privateKey: string | KeyObject,
  options: SignOptions = {},
): SignedMessage {
  const key = typeof privateKey === 'string' ? importIdentityPrivateKey(privateKey) : privateKey;
  const unsigned = {
    from,
    to,
    ts: options.ts ?? Date.now(),
    nonce: options.nonce ?? toB64url(randomBytes(16)),
    body,
  };
  const sig = toB64url(edSign(null, signingInput(unsigned), key));
  return { ks: SIGNED_MESSAGE_VERSION, ...unsigned, sig };
}

/** True when `m.sig` is a valid signature by `publicKey` over the message. */
export function verifySignature(m: SignedMessage, publicKey: string): boolean {
  try {
    const sig = fromB64url(m.sig);
    if (sig.length !== 64) return false;
    return edVerify(null, signingInput(m), importIdentityPublicKey(publicKey), sig);
  } catch {
    return false;
  }
}

export type SignedMessageRejection =
  | 'bad_signature'
  | 'wrong_recipient'
  | 'stale'
  | 'from_future'
  | 'replay';

export interface ReplayGuardOptions {
  /** Oldest accepted message age. Default 15 minutes. */
  maxAgeMs?: number;
  /** Largest accepted clock lead of the sender. Default 10 minutes. */
  maxFutureMs?: number;
  now?: () => number;
}

/**
 * Remembers nonces it has accepted for as long as their timestamps are
 * acceptable, so a captured ciphertext cannot be delivered twice.
 */
export class ReplayGuard {
  readonly maxAgeMs: number;
  readonly maxFutureMs: number;
  private readonly now: () => number;
  /** `${from}\n${nonce}` → ts. */
  private seen = new Map<string, number>();

  constructor(options: ReplayGuardOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? 15 * 60_000;
    this.maxFutureMs = options.maxFutureMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /** Check freshness and uniqueness; records the nonce when accepted. */
  check(m: Pick<SignedMessage, 'from' | 'ts' | 'nonce'>): 'stale' | 'from_future' | 'replay' | null {
    const now = this.now();
    if (m.ts < now - this.maxAgeMs) return 'stale';
    if (m.ts > now + this.maxFutureMs) return 'from_future';
    const key = `${m.from}\n${m.nonce}`;
    if (this.seen.has(key)) return 'replay';
    this.prune(now);
    this.seen.set(key, m.ts);
    return null;
  }

  private prune(now: number): void {
    if (this.seen.size < 1024) return;
    for (const [key, ts] of this.seen) {
      if (ts < now - this.maxAgeMs) this.seen.delete(key);
    }
  }

  /** Persistable state: accepted nonces still inside the window. */
  export(): Array<[string, number]> {
    const now = this.now();
    return [...this.seen].filter(([, ts]) => ts >= now - this.maxAgeMs);
  }

  import(entries: Array<[string, number]>): void {
    for (const [key, ts] of entries) {
      if (typeof key === 'string' && typeof ts === 'number') this.seen.set(key, ts);
    }
  }
}

/**
 * Full receive-side check of a signed message: signature by the pinned key,
 * addressed to `self` (or to any recipient), fresh and not replayed.
 */
export function checkSignedMessage(
  m: SignedMessage,
  senderIdentityKey: string,
  self: string,
  guard?: ReplayGuard,
): SignedMessageRejection | null {
  if (!verifySignature(m, senderIdentityKey)) return 'bad_signature';
  if (m.to !== self && m.to !== ANY_RECIPIENT) return 'wrong_recipient';
  return guard ? guard.check(m) : null;
}

// ── Pairing ─────────────────────────────────────────────

/** A one-time pairing secret for the QR code (16 random bytes, base64url). */
export function generatePairingSecret(): string {
  return toB64url(randomBytes(16));
}

/** What an app enrolls with a computer when it pairs. */
export interface PairingClaim {
  /** The computer being paired with. */
  tentacleId: string;
  /** The app's device ID. */
  appId: string;
  /** The app's Ed25519 identity key. */
  identityKey: string;
  /** The app's X25519 encryption key. */
  encryptionKey: string;
  /** The app's legacy RSA key (compact SPKI), for push previews. Optional. */
  rsaKey?: string;
  /** Unix milliseconds. */
  ts: number;
}

function pairingInput(c: PairingClaim): Buffer {
  return Buffer.from(
    `${PAIR_CONTEXT}\n${c.tentacleId}\n${c.appId}\n${c.identityKey}\n${c.encryptionKey}\n${c.rsaKey ?? ''}\n${c.ts}`,
    'utf8',
  );
}

/** HMAC-SHA256 of the claim under the QR secret, base64url. */
export function pairingProof(secret: string, claim: PairingClaim): string {
  return toB64url(createHmac('sha256', fromB64url(secret)).update(pairingInput(claim)).digest());
}

export function verifyPairingProof(secret: string, claim: PairingClaim, proof: string): boolean {
  try {
    const expected = Buffer.from(pairingProof(secret, claim), 'base64url');
    const actual = fromB64url(proof);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
