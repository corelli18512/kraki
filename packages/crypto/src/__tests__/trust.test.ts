import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANY_RECIPIENT,
  ReplayGuard,
  checkSignedMessage,
  generateIdentityKeyPair,
  generatePairingSecret,
  identityPublicKeyOf,
  isRawPublicKey,
  isSignedMessage,
  pairingProof,
  safetyCode,
  signMessage,
  verifyPairingProof,
  verifySignature,
  type PairingClaim,
} from '../trust.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('identity keys', () => {
  it('generates raw 32-byte public keys that match the private key', () => {
    const kp = generateIdentityKeyPair();
    expect(isRawPublicKey(kp.publicKey)).toBe(true);
    expect(identityPublicKeyOf(kp.privateKey)).toBe(kp.publicKey);
  });
});

describe('signed messages', () => {
  const alice = generateIdentityKeyPair();
  const mallory = generateIdentityKeyPair();
  const body = JSON.stringify({ type: 'send_input', sessionId: 's1', payload: { text: 'ls' } });

  it('round-trips and verifies', () => {
    const m = signMessage(body, 'app_a', 'tent_1', alice.privateKey);
    expect(isSignedMessage(JSON.parse(JSON.stringify(m)))).toBe(true);
    expect(verifySignature(m, alice.publicKey)).toBe(true);
    expect(checkSignedMessage(m, alice.publicKey, 'tent_1')).toBeNull();
  });

  it('rejects a different signer (the relay substituting its own key)', () => {
    const forged = signMessage(body, 'app_a', 'tent_1', mallory.privateKey);
    expect(checkSignedMessage(forged, alice.publicKey, 'tent_1')).toBe('bad_signature');
  });

  it('rejects any modified field', () => {
    const m = signMessage(body, 'app_a', 'tent_1', alice.privateKey);
    for (const patch of [
      { body: body.replace('ls', 'rm -rf ~') },
      { from: 'app_b' },
      { to: 'tent_2' },
      { ts: m.ts + 1 },
      { nonce: 'AAAAAAAAAAAAAAAAAAAAAA' },
    ]) {
      expect(verifySignature({ ...m, ...patch }, alice.publicKey)).toBe(false);
    }
  });

  it('binds the recipient', () => {
    const m = signMessage(body, 'app_a', 'tent_1', alice.privateKey);
    expect(checkSignedMessage(m, alice.publicKey, 'tent_2')).toBe('wrong_recipient');
    const any = signMessage(body, 'app_a', ANY_RECIPIENT, alice.privateKey);
    expect(checkSignedMessage(any, alice.publicKey, 'tent_2')).toBeNull();
  });

  it('rejects replays, stale and future messages', () => {
    let now = 1_000_000_000_000;
    const guard = new ReplayGuard({ now: () => now });
    const m = signMessage(body, 'app_a', 'tent_1', alice.privateKey, { ts: now });
    expect(checkSignedMessage(m, alice.publicKey, 'tent_1', guard)).toBeNull();
    expect(checkSignedMessage(m, alice.publicKey, 'tent_1', guard)).toBe('replay');
    const old = signMessage(body, 'app_a', 'tent_1', alice.privateKey, { ts: now - 16 * 60_000 });
    expect(checkSignedMessage(old, alice.publicKey, 'tent_1', guard)).toBe('stale');
    const future = signMessage(body, 'app_a', 'tent_1', alice.privateKey, { ts: now + 11 * 60_000 });
    expect(checkSignedMessage(future, alice.publicKey, 'tent_1', guard)).toBe('from_future');
    // Persisted state survives a restart.
    const restored = new ReplayGuard({ now: () => now });
    restored.import(guard.export());
    expect(restored.check(m)).toBe('replay');
    now += 20 * 60_000;
    expect(new ReplayGuard({ now: () => now }).check(m)).toBe('stale');
  });

  it('rejects malformed signatures without throwing', () => {
    const m = signMessage(body, 'app_a', 'tent_1', alice.privateKey);
    expect(verifySignature({ ...m, sig: 'not base64!' }, alice.publicKey)).toBe(false);
    expect(verifySignature({ ...m, sig: '' }, alice.publicKey)).toBe(false);
    expect(verifySignature(m, 'short')).toBe(false);
  });
});

describe('pairing proof', () => {
  const app = generateIdentityKeyPair();
  const claim: PairingClaim = {
    tentacleId: 'dev_tentacle',
    appId: 'dev_phone',
    identityKey: app.publicKey,
    encryptionKey: generateIdentityKeyPair().publicKey,
    ts: 1_700_000_000_000,
  };

  it('verifies with the QR secret only', () => {
    const secret = generatePairingSecret();
    const proof = pairingProof(secret, claim);
    expect(verifyPairingProof(secret, claim, proof)).toBe(true);
    expect(verifyPairingProof(generatePairingSecret(), claim, proof)).toBe(false);
  });

  it('binds every enrolled key and the computer', () => {
    const secret = generatePairingSecret();
    const proof = pairingProof(secret, claim);
    const relayKey = generateIdentityKeyPair().publicKey;
    expect(verifyPairingProof(secret, { ...claim, identityKey: relayKey }, proof)).toBe(false);
    expect(verifyPairingProof(secret, { ...claim, encryptionKey: generateIdentityKeyPair().publicKey }, proof)).toBe(false);
    expect(verifyPairingProof(secret, { ...claim, rsaKey: 'MIIB' }, proof)).toBe(false);
    expect(verifyPairingProof(secret, { ...claim, tentacleId: 'dev_other' }, proof)).toBe(false);
    expect(verifyPairingProof(secret, { ...claim, appId: 'dev_relay' }, proof)).toBe(false);
  });
});

describe('cross-implementation vectors', () => {
  // Swift (DeviceTrustTests) verifies these exact bytes.
  const vectors = JSON.parse(readFileSync(join(fixtures, 'trust-vectors.json'), 'utf8')) as {
    identity: { privateKey: string; publicKey: string };
    signed: Parameters<typeof verifySignature>[0];
    pairing: { secret: string; claim: PairingClaim; proof: string };
    safetyCode: string;
  };

  it('match this implementation', () => {
    expect(identityPublicKeyOf(vectors.identity.privateKey)).toBe(vectors.identity.publicKey);
    expect(verifySignature(vectors.signed, vectors.identity.publicKey)).toBe(true);
    const resigned = signMessage(vectors.signed.body, vectors.signed.from, vectors.signed.to,
      vectors.identity.privateKey, { ts: vectors.signed.ts, nonce: vectors.signed.nonce });
    // Ed25519 (RFC 8032) is deterministic.
    expect(resigned.sig).toBe(vectors.signed.sig);
    expect(pairingProof(vectors.pairing.secret, vectors.pairing.claim)).toBe(vectors.pairing.proof);
    expect(safetyCode(vectors.identity.publicKey)).toBe(vectors.safetyCode);
    expect(safetyCode(vectors.identity.publicKey)).toMatch(/^\d{4} \d{4} \d{4}$/);
  });
});

describe('round 2 hardening', () => {
  const k = generateIdentityKeyPair();
  it('rejects delimiter-bearing ids and non-canonical nonces', () => {
    expect(() => signMessage('{}', 'a', 'b\nc', k.privateKey)).toThrow();
    expect(() => signMessage('{}', 'a\nb', 'c', k.privateKey)).toThrow();
    expect(() => signMessage('{}', 'a', 'b', k.privateKey, { nonce: 'short' })).toThrow();
    const m = signMessage('{}', 'a', 'b', k.privateKey);
    expect(verifySignature({ ...m, from: 'a\nb' }, k.publicKey)).toBe(false);
    expect(isSignedMessage({ ...m, nonce: m.nonce + '=' })).toBe(false);
    expect(() => pairingProof(generatePairingSecret(), {
      tentacleId: 't\nx', appId: 'a', identityKey: k.publicKey, encryptionKey: k.publicKey, ts: 1,
    })).toThrow();
  });

  it('replay state survives restarts, clock rollback and loss', () => {
    let now = 10_000_000;
    const g1 = new ReplayGuard({ now: () => now });
    const m = { from: 'a', ts: now, nonce: 'N1' };
    expect(g1.check(m)).toBeNull();
    // Time passes beyond the window; the nonce is pruned at export.
    now += 20 * 60_000;
    const state = g1.export();
    expect(state.entries).toEqual([]);
    // Clock set back: the old message is still refused.
    now -= 20 * 60_000;
    const g2 = new ReplayGuard({ now: () => now });
    g2.import(JSON.parse(JSON.stringify(state)));
    expect(g2.check(m)).toBe('stale');
    // Lost state refuses messages signed ahead of the clock too.
    const g3 = new ReplayGuard({ now: () => now });
    g3.markStateLost();
    expect(g3.check({ from: 'a', ts: now + 5 * 60_000, nonce: 'N2' })).toBe('stale');
    // ...and the floor survives the next export/import.
    const g4 = new ReplayGuard({ now: () => now });
    g4.import(JSON.parse(JSON.stringify(g3.export())));
    expect(g4.check({ from: 'a', ts: now + 5 * 60_000, nonce: 'N2' })).toBe('stale');
    // Malformed state throws (the store then marks it lost).
    expect(() => new ReplayGuard().import([[null, 1]])).toThrow();
    expect(() => new ReplayGuard().import({ v: 2, entries: [] })).toThrow();
  });
});

describe('final review', () => {
  it('DT503-05: clock rollback in a running process cannot reopen a pruned nonce', () => {
    let now = 50_000_000;
    const g = new ReplayGuard({ now: () => now });
    const old = { from: 'a', ts: now, nonce: 'OLD' };
    expect(g.check(old)).toBeNull();
    for (let i = 0; i < 1100; i++) g.check({ from: 'a', ts: now, nonce: `n${i}` });
    now += 20 * 60_000;
    expect(g.check({ from: 'a', ts: now, nonce: 'later' })).toBeNull();
    now -= 20 * 60_000;
    expect(g.check(old)).not.toBeNull();
  });
});
