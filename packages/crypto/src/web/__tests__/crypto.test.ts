import { beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  decrypt,
  decryptFromBlob,
  deserializeEnvelope,
  encrypt,
  encryptToBlob,
  generateEncryptionKeyPair,
  generateEncryptionKeyPairHandle,
  generateSigningKeyPair,
  generateSigningKeyPairHandle,
  importEncryptionPrivateKey,
  importSigningPrivateKey,
  type KeyPair,
  type KeyPairHandle,
  serializeEnvelope,
  signChallenge,
  verifyChallenge,
} from '../index.js';

// Shared key material generated once — keygen is cheap for X25519/Ed25519 but
// we still avoid regenerating it for every case.
let alice: KeyPair;
let bob: KeyPair;
let carol: KeyPair;
let signer: KeyPair;

beforeAll(async () => {
  [alice, bob, carol, signer] = await Promise.all([
    generateEncryptionKeyPair(),
    generateEncryptionKeyPair(),
    generateEncryptionKeyPair(),
    generateSigningKeyPair(),
  ]);
});

describe('key generation', () => {
  it('produces base64url public and private strings', () => {
    expect(typeof alice.publicKey).toBe('string');
    expect(typeof alice.privateKey).toBe('string');
    expect(alice.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(alice.privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates distinct key pairs each call', async () => {
    const a = await generateEncryptionKeyPair();
    const b = await generateEncryptionKeyPair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });

  it('produces a compact 32-byte X25519 public key', () => {
    // 32 bytes -> 43 base64url chars (unpadded)
    expect(alice.publicKey.length).toBe(43);
  });

  it('separates encryption and signing keys', () => {
    expect(signer.publicKey).not.toBe(alice.publicKey);
  });
});

describe('encrypt / decrypt', () => {
  it('round-trips a message for a single recipient', async () => {
    const envelope = await encrypt('hello world', [
      { recipientId: 'alice', publicKey: alice.publicKey },
    ]);
    const plaintext = await decrypt(envelope, 'alice', alice.privateKey);
    expect(plaintext).toBe('hello world');
  });

  it('encrypts once but every recipient can decrypt', async () => {
    const message = '🔐 coinfra says: shared secret';
    const envelope = await encrypt(message, [
      { recipientId: 'alice', publicKey: alice.publicKey },
      { recipientId: 'bob', publicKey: bob.publicKey },
      { recipientId: 'carol', publicKey: carol.publicKey },
    ]);

    expect(await decrypt(envelope, 'alice', alice.privateKey)).toBe(message);
    expect(await decrypt(envelope, 'bob', bob.privateKey)).toBe(message);
    expect(await decrypt(envelope, 'carol', carol.privateKey)).toBe(message);
  });

  it('carries version and suite metadata', async () => {
    const envelope = await encrypt('x', [{ recipientId: 'alice', publicKey: alice.publicKey }]);
    expect(envelope.v).toBe(1);
    expect(envelope.suite).toBe('X25519-HKDF-SHA256/AES-256-GCM');
  });

  it('gives each recipient an independent ephemeral key and wrapped key', async () => {
    const envelope = await encrypt('multi', [
      { recipientId: 'alice', publicKey: alice.publicKey },
      { recipientId: 'bob', publicKey: bob.publicKey },
    ]);
    const a = envelope.recipients.alice;
    const b = envelope.recipients.bob;
    if (!a || !b) {
      throw new Error('expected both recipients');
    }
    expect(a.epk).not.toBe(b.epk);
    expect(a.key).not.toBe(b.key);
  });

  it('produces fresh ciphertext for identical plaintext', async () => {
    const recipients = [{ recipientId: 'alice', publicKey: alice.publicKey }];
    const one = await encrypt('same', recipients);
    const two = await encrypt('same', recipients);
    expect(one.ciphertext).not.toBe(two.ciphertext);
    expect(one.iv).not.toBe(two.iv);
  });

  it('round-trips an empty string', async () => {
    const envelope = await encrypt('', [{ recipientId: 'alice', publicKey: alice.publicKey }]);
    expect(await decrypt(envelope, 'alice', alice.privateKey)).toBe('');
  });

  it('round-trips unicode and emoji', async () => {
    const message = '你好世界 🌍 مرحبا Здравствуйте 🦀';
    const envelope = await encrypt(message, [{ recipientId: 'alice', publicKey: alice.publicKey }]);
    expect(await decrypt(envelope, 'alice', alice.privateKey)).toBe(message);
  });

  it('round-trips a large payload', async () => {
    const message = 'A'.repeat(200_000);
    const envelope = await encrypt(message, [{ recipientId: 'alice', publicKey: alice.publicKey }]);
    expect(await decrypt(envelope, 'alice', alice.privateKey)).toBe(message);
  });

  it('rejects zero recipients', async () => {
    await expect(encrypt('x', [])).rejects.toThrow(/at least one recipient/i);
  });
});

describe('decrypt failures', () => {
  it('throws when the recipient id is unknown', async () => {
    const envelope = await encrypt('secret', [
      { recipientId: 'alice', publicKey: alice.publicKey },
    ]);
    await expect(decrypt(envelope, 'stranger', alice.privateKey)).rejects.toThrow(
      /no encrypted key/i,
    );
  });

  it('fails when decrypting with the wrong private key', async () => {
    const envelope = await encrypt('secret', [
      { recipientId: 'alice', publicKey: alice.publicKey },
    ]);
    // bob's key is not the one wrapped for "alice"
    await expect(decrypt(envelope, 'alice', bob.privateKey)).rejects.toThrow();
  });

  it('fails when the payload ciphertext is tampered', async () => {
    const envelope = await encrypt('secret', [
      { recipientId: 'alice', publicKey: alice.publicKey },
    ]);
    const flipped = flipBase64urlByte(envelope.ciphertext);
    await expect(
      decrypt({ ...envelope, ciphertext: flipped }, 'alice', alice.privateKey),
    ).rejects.toThrow();
  });

  it('fails when a recipient wrapped key is tampered', async () => {
    const envelope = await encrypt('secret', [
      { recipientId: 'alice', publicKey: alice.publicKey },
    ]);
    const entry = envelope.recipients.alice;
    if (!entry) {
      throw new Error('expected alice recipient');
    }
    const tampered = {
      ...envelope,
      recipients: { alice: { ...entry, key: flipBase64urlByte(entry.key) } },
    };
    await expect(decrypt(tampered, 'alice', alice.privateKey)).rejects.toThrow();
  });

  it('fails when a recipient entry is relabeled (recipientId is authenticated)', async () => {
    const envelope = await encrypt('secret', [
      { recipientId: 'alice', publicKey: alice.publicKey },
    ]);
    // Move alice's entry under a different id; the wrap AAD no longer matches.
    const aliceEntry = envelope.recipients.alice;
    if (!aliceEntry) {
      throw new Error('expected alice recipient');
    }
    const relabeled = {
      ...envelope,
      recipients: { mallory: aliceEntry },
    };
    await expect(decrypt(relabeled, 'mallory', alice.privateKey)).rejects.toThrow();
  });

  it('rejects an envelope with an unexpected version or suite', async () => {
    const envelope = await encrypt('secret', [
      { recipientId: 'alice', publicKey: alice.publicKey },
    ]);
    await expect(decrypt({ ...envelope, v: 2 }, 'alice', alice.privateKey)).rejects.toThrow(
      /unsupported envelope/i,
    );
    await expect(
      decrypt({ ...envelope, suite: 'RSA-OAEP/AES-256-GCM' }, 'alice', alice.privateKey),
    ).rejects.toThrow(/unsupported envelope/i);
  });
});

describe('serialize / deserialize envelope', () => {
  it('round-trips through the compact binary form and still decrypts', async () => {
    const envelope = await encrypt('via blob', [
      { recipientId: 'alice', publicKey: alice.publicKey },
      { recipientId: 'bob', publicKey: bob.publicKey },
    ]);
    const blob = serializeEnvelope(envelope);
    expect(typeof blob).toBe('string');
    expect(blob).toMatch(/^[A-Za-z0-9_-]+$/);

    const restored = deserializeEnvelope(blob);
    expect(restored.v).toBe(envelope.v);
    expect(restored.suite).toBe(envelope.suite);
    expect(await decrypt(restored, 'alice', alice.privateKey)).toBe('via blob');
    expect(await decrypt(restored, 'bob', bob.privateKey)).toBe('via blob');
  });

  it('rejects a blob that is not a coinfra envelope', () => {
    expect(() => deserializeEnvelope('AAAAAAAA')).toThrow(/not a coinfra/i);
  });

  it('rejects a truncated blob', async () => {
    const good = serializeEnvelope(
      await encrypt('x', [{ recipientId: 'alice', publicKey: alice.publicKey }]),
    );
    // Cut it in half to truncate.
    expect(() => deserializeEnvelope(good.slice(0, Math.floor(good.length / 2)))).toThrow();
  });
});

describe('encryptToBlob / decryptFromBlob', () => {
  it('round-trips a self-contained blob', async () => {
    const blob = await encryptToBlob('one-shot', [
      { recipientId: 'alice', publicKey: alice.publicKey },
    ]);
    expect(typeof blob).toBe('string');
    expect(await decryptFromBlob(blob, 'alice', alice.privateKey)).toBe('one-shot');
  });

  it('supports multiple recipients from a single blob', async () => {
    const blob = await encryptToBlob('group', [
      { recipientId: 'alice', publicKey: alice.publicKey },
      { recipientId: 'bob', publicKey: bob.publicKey },
    ]);
    expect(await decryptFromBlob(blob, 'alice', alice.privateKey)).toBe('group');
    expect(await decryptFromBlob(blob, 'bob', bob.privateKey)).toBe('group');
  });

  it('preserves recipient ids with unicode characters', async () => {
    const blob = await encryptToBlob('naming', [
      { recipientId: '设备-01 🦄', publicKey: alice.publicKey },
    ]);
    expect(await decryptFromBlob(blob, '设备-01 🦄', alice.privateKey)).toBe('naming');
  });
});

describe('challenge-response signing (Ed25519)', () => {
  it('verifies a valid signature', async () => {
    const nonce = 'random-challenge-123';
    const sig = await signChallenge(nonce, signer.privateKey);
    expect(await verifyChallenge(nonce, sig, signer.publicKey)).toBe(true);
  });

  it('is deterministic (Ed25519)', async () => {
    const nonce = 'deterministic';
    const a = await signChallenge(nonce, signer.privateKey);
    const b = await signChallenge(nonce, signer.privateKey);
    expect(a).toBe(b);
  });

  it('rejects a signature over a different nonce', async () => {
    const sig = await signChallenge('nonce-a', signer.privateKey);
    expect(await verifyChallenge('nonce-b', sig, signer.publicKey)).toBe(false);
  });

  it('rejects a signature from a different key', async () => {
    const other = await generateSigningKeyPair();
    const sig = await signChallenge('nonce', signer.privateKey);
    expect(await verifyChallenge('nonce', sig, other.publicKey)).toBe(false);
  });

  it('rejects a tampered signature', async () => {
    const sig = await signChallenge('nonce', signer.privateKey);
    expect(await verifyChallenge('nonce', flipBase64urlByte(sig), signer.publicKey)).toBe(false);
  });

  it('returns false (never throws) on malformed input', async () => {
    expect(await verifyChallenge('nonce', 'not-a-real-sig', signer.publicKey)).toBe(false);
    expect(await verifyChallenge('nonce', '!!!', '###')).toBe(false);
  });
});

describe('non-extractable key handles', () => {
  it('generates an X25519 handle whose private key cannot be exported', async () => {
    const handle: KeyPairHandle = await generateEncryptionKeyPairHandle();
    expect(typeof handle.publicKey).toBe('string');
    expect(handle.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(handle.privateKey.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('pkcs8', handle.privateKey)).rejects.toThrow();
  });

  it('generates an Ed25519 handle whose private key cannot be exported', async () => {
    const handle = await generateSigningKeyPairHandle();
    expect(handle.privateKey.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('pkcs8', handle.privateKey)).rejects.toThrow();
  });

  it('round-trips encryption with a CryptoKey private handle', async () => {
    const handle = await generateEncryptionKeyPairHandle();
    const envelope = await encrypt('handle message', [
      { recipientId: 'h', publicKey: handle.publicKey },
    ]);
    expect(await decrypt(envelope, 'h', handle.privateKey)).toBe('handle message');
  });

  it('decrypts a blob with a CryptoKey private handle', async () => {
    const handle = await generateEncryptionKeyPairHandle();
    const blob = await encryptToBlob('blob via handle', [
      { recipientId: 'h', publicKey: handle.publicKey },
    ]);
    expect(await decryptFromBlob(blob, 'h', handle.privateKey)).toBe('blob via handle');
  });

  it('imports a string private key once and reuses it across messages', async () => {
    const key = await importEncryptionPrivateKey(alice.privateKey);
    const first = await encrypt('one', [{ recipientId: 'alice', publicKey: alice.publicKey }]);
    const second = await encrypt('two', [{ recipientId: 'alice', publicKey: alice.publicKey }]);
    expect(await decrypt(first, 'alice', key)).toBe('one');
    expect(await decrypt(second, 'alice', key)).toBe('two');
  });

  it('signs with a CryptoKey handle and verifies against its public key', async () => {
    const handle = await generateSigningKeyPairHandle();
    const sig = await signChallenge('nonce-42', handle.privateKey);
    expect(await verifyChallenge('nonce-42', sig, handle.publicKey)).toBe(true);
  });

  it('signing with an imported key equals signing with the string key (Ed25519 is deterministic)', async () => {
    const imported = await importSigningPrivateKey(signer.privateKey);
    const fromString = await signChallenge('same-nonce', signer.privateKey);
    const fromHandle = await signChallenge('same-nonce', imported);
    expect(fromHandle).toBe(fromString);
    expect(await verifyChallenge('same-nonce', fromHandle, signer.publicKey)).toBe(true);
  });
});

describe('canonicalJson', () => {
  it('sorts top-level keys', () => {
    expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  it('is independent of insertion order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('recursively sorts nested objects', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: 3 })).toBe('{"a":3,"z":{"x":2,"y":1}}');
  });

  it('preserves array order but canonicalizes array elements', () => {
    expect(canonicalJson({ list: [{ b: 1, a: 2 }, 3] })).toBe('{"list":[{"a":2,"b":1},3]}');
  });

  it('handles null and nested primitives', () => {
    expect(canonicalJson({ a: null, b: 'x', c: true })).toBe('{"a":null,"b":"x","c":true}');
  });

  it('supports canonical signing round-trips regardless of key order', async () => {
    const payload = { resource: 'svc/resource', iss: 'coinfra', exp: 1000 };
    const reordered = { exp: 1000, iss: 'coinfra', resource: 'svc/resource' };
    const sig = await signChallenge(canonicalJson(payload), signer.privateKey);
    expect(await verifyChallenge(canonicalJson(reordered), sig, signer.publicKey)).toBe(true);
  });
});

// ── helpers ─────────────────────────────────────────────

function flipBase64urlByte(b64url: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const chars = b64url.split('');
  const i = Math.floor(chars.length / 2);
  const current = alphabet.indexOf(chars[i] ?? '');
  chars[i] = alphabet[(current + 1) % alphabet.length] ?? '';
  return chars.join('');
}
