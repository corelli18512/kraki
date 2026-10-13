import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decryptV2,
  e2ePublicKeyOf,
  encryptV2,
  generateE2EKeyPair,
  importE2EPrivateKey,
  isV2Payload,
} from '../v2.js';

interface Vectors {
  recipients: { recipientId: string; publicKey: string; privateKey: string }[];
  blobs: { plaintext: string; blob: string }[];
}

const load = (name: string): Vectors =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

describe('e2e v2 (coinfra suite v1 on node:crypto)', () => {
  it('round-trips for many recipients and texts', () => {
    const a = generateE2EKeyPair();
    const b = generateE2EKeyPair();
    for (const text of ['', 'hello', '好的，我来看一下。🐙', 'x'.repeat(70_000)]) {
      const blob = encryptV2(text, [
        { recipientId: 'a', publicKey: a.publicKey },
        { recipientId: 'b', publicKey: b.publicKey },
      ]);
      expect(decryptV2(blob, 'a', a.privateKey)).toBe(text);
      expect(decryptV2(blob, 'b', importE2EPrivateKey(b.privateKey))).toBe(text);
    }
  });

  it('derives the public key from the private key', () => {
    const kp = generateE2EKeyPair();
    expect(e2ePublicKeyOf(kp.privateKey)).toBe(kp.publicKey);
  });

  it('rejects other recipients, wrong keys, tampering and low-order keys', () => {
    const a = generateE2EKeyPair();
    const blob = encryptV2('secret', [{ recipientId: 'a', publicKey: a.publicKey }]);
    expect(() => decryptV2(blob, 'b', a.privateKey)).toThrow();
    expect(() => decryptV2(blob, 'a', generateE2EKeyPair().privateKey)).toThrow();
    const bytes = Buffer.from(blob, 'base64url');
    for (const i of [8, 12, bytes.length - 1]) {
      const copy = Buffer.from(bytes);
      copy[i] = copy[i]! ^ 1;
      expect(() => decryptV2(copy.toString('base64url'), 'a', a.privateKey)).toThrow();
    }
    expect(() => encryptV2('x', [{ recipientId: 'z', publicKey: Buffer.alloc(32).toString('base64url') }])).toThrow();
  });

  it('detects the v2 payload shape', () => {
    expect(isV2Payload({ v: 2, blob: 'abc' })).toBe(true);
    expect(isV2Payload({ blob: 'abc', keys: {} })).toBe(false);
  });

  // Vectors from @coinfra/crypto (TS, Web Crypto) and CoinfraCrypto (Swift).
  it.each(['ts-vectors', 'swift-vectors'])('opens %s', (name) => {
    const v = load(name);
    for (const { plaintext, blob } of v.blobs) {
      for (const r of v.recipients) {
        expect(decryptV2(blob, r.recipientId, r.privateKey)).toBe(plaintext);
      }
    }
    for (const r of v.recipients) expect(e2ePublicKeyOf(r.privateKey)).toBe(r.publicKey);
  });
});
