import {
  generateKeyPair,
  encrypt,
  decrypt,
  exportPublicKey,
  importPublicKey,
  signChallenge,
  verifyChallenge,
  type KeyPair,
  type RecipientKey,
  type EncryptedPayload,
} from '../index.js';

describe('@kraki/crypto', () => {

  // ── Key generation ──────────────────────────────────

  describe('generateKeyPair', () => {
    it('should generate valid RSA key pair', () => {
      const kp = generateKeyPair();
      expect(kp.publicKey).toContain('BEGIN PUBLIC KEY');
      expect(kp.privateKey).toContain('BEGIN PRIVATE KEY');
    });

    it('should generate unique keys each time', () => {
      const kp1 = generateKeyPair();
      const kp2 = generateKeyPair();
      expect(kp1.publicKey).not.toBe(kp2.publicKey);
      expect(kp1.privateKey).not.toBe(kp2.privateKey);
    });
  });

  // ── Basic encrypt/decrypt ─────────────────────────

  describe('encrypt + decrypt', () => {
    let kp: KeyPair;
    const deviceId = 'dev_test';

    beforeEach(() => {
      kp = generateKeyPair();
    });

    it('should encrypt and decrypt a simple message', () => {
      const recipients: RecipientKey[] = [{ deviceId, publicKey: kp.publicKey }];
      const payload = encrypt('hello world', recipients);
      const result = decrypt(payload, deviceId, kp.privateKey);
      expect(result).toBe('hello world');
    });

    it('should encrypt and decrypt empty string', () => {
      const recipients: RecipientKey[] = [{ deviceId, publicKey: kp.publicKey }];
      const payload = encrypt('', recipients);
      const result = decrypt(payload, deviceId, kp.privateKey);
      expect(result).toBe('');
    });

    it('should encrypt and decrypt unicode content', () => {
      const msg = '🦑 Kraki says: 你好世界! Ωmega ñoño';
      const recipients: RecipientKey[] = [{ deviceId, publicKey: kp.publicKey }];
      const payload = encrypt(msg, recipients);
      expect(decrypt(payload, deviceId, kp.privateKey)).toBe(msg);
    });

    it('should encrypt and decrypt large content (100KB)', () => {
      const msg = 'x'.repeat(100_000);
      const recipients: RecipientKey[] = [{ deviceId, publicKey: kp.publicKey }];
      const payload = encrypt(msg, recipients);
      expect(decrypt(payload, deviceId, kp.privateKey)).toBe(msg);
    });

    it('should encrypt and decrypt JSON content', () => {
      const obj = { type: 'agent_message', payload: { content: 'I fixed the bug in auth.js' } };
      const msg = JSON.stringify(obj);
      const recipients: RecipientKey[] = [{ deviceId, publicKey: kp.publicKey }];
      const payload = encrypt(msg, recipients);
      const decrypted = JSON.parse(decrypt(payload, deviceId, kp.privateKey));
      expect(decrypted).toEqual(obj);
    });

    it('should produce different ciphertext for same plaintext (random IV)', () => {
      const recipients: RecipientKey[] = [{ deviceId, publicKey: kp.publicKey }];
      const p1 = encrypt('same message', recipients);
      const p2 = encrypt('same message', recipients);
      expect(p1.ciphertext).not.toBe(p2.ciphertext);
      expect(p1.iv).not.toBe(p2.iv);
    });
  });

  // ── Multi-recipient ───────────────────────────────

  describe('multi-recipient encryption', () => {
    it('should encrypt for two recipients, each can decrypt independently', () => {
      const kp1 = generateKeyPair();
      const kp2 = generateKeyPair();
      const recipients: RecipientKey[] = [
        { deviceId: 'dev_phone', publicKey: kp1.publicKey },
        { deviceId: 'dev_browser', publicKey: kp2.publicKey },
      ];

      const payload = encrypt('secret message', recipients);

      // Both should have their own wrapped key
      expect(payload.keys['dev_phone']).toBeTruthy();
      expect(payload.keys['dev_browser']).toBeTruthy();
      expect(payload.keys['dev_phone']).not.toBe(payload.keys['dev_browser']);

      // Both can decrypt
      expect(decrypt(payload, 'dev_phone', kp1.privateKey)).toBe('secret message');
      expect(decrypt(payload, 'dev_browser', kp2.privateKey)).toBe('secret message');

      // Ciphertext is the same (deduplicated)
      // Both recipients decode the same ciphertext with different AES keys
    });

    it('should encrypt for five recipients', { timeout: 30_000 }, () => {
      const pairs = Array.from({ length: 5 }, (_, i) => ({
        kp: generateKeyPair(),
        deviceId: `dev_${i}`,
      }));
      const recipients = pairs.map(p => ({ deviceId: p.deviceId, publicKey: p.kp.publicKey }));

      const payload = encrypt('broadcast message', recipients);
      expect(Object.keys(payload.keys)).toHaveLength(5);

      for (const p of pairs) {
        expect(decrypt(payload, p.deviceId, p.kp.privateKey)).toBe('broadcast message');
      }
    });
  });

  // ── Security properties ───────────────────────────

  describe('security', () => {
    it('should fail to decrypt with wrong private key', () => {
      const kp1 = generateKeyPair();
      const kp2 = generateKeyPair();
      const payload = encrypt('secret', [{ deviceId: 'dev_1', publicKey: kp1.publicKey }]);

      expect(() => decrypt(payload, 'dev_1', kp2.privateKey)).toThrow();
    });

    it('should fail to decrypt for non-existent device', () => {
      const kp = generateKeyPair();
      const payload = encrypt('secret', [{ deviceId: 'dev_1', publicKey: kp.publicKey }]);

      expect(() => decrypt(payload, 'dev_unknown', kp.privateKey)).toThrow('No encrypted key found');
    });

    it('should detect tampered ciphertext (GCM auth)', () => {
      const kp = generateKeyPair();
      const payload = encrypt('secret', [{ deviceId: 'dev_1', publicKey: kp.publicKey }]);

      // Tamper with ciphertext
      const buf = Buffer.from(payload.ciphertext, 'base64');
      buf[0] ^= 0xff;
      const tampered: EncryptedPayload = { ...payload, ciphertext: buf.toString('base64') };

      expect(() => decrypt(tampered, 'dev_1', kp.privateKey)).toThrow();
    });

    it('should detect tampered IV', () => {
      const kp = generateKeyPair();
      const payload = encrypt('secret', [{ deviceId: 'dev_1', publicKey: kp.publicKey }]);

      const buf = Buffer.from(payload.iv, 'base64');
      buf[0] ^= 0xff;
      const tampered: EncryptedPayload = { ...payload, iv: buf.toString('base64') };

      expect(() => decrypt(tampered, 'dev_1', kp.privateKey)).toThrow();
    });

    it('should detect tampered auth tag', () => {
      const kp = generateKeyPair();
      const payload = encrypt('secret', [{ deviceId: 'dev_1', publicKey: kp.publicKey }]);

      const buf = Buffer.from(payload.tag, 'base64');
      buf[0] ^= 0xff;
      const tampered: EncryptedPayload = { ...payload, tag: buf.toString('base64') };

      expect(() => decrypt(tampered, 'dev_1', kp.privateKey)).toThrow();
    });

    it('should detect tampered wrapped key', () => {
      const kp = generateKeyPair();
      const payload = encrypt('secret', [{ deviceId: 'dev_1', publicKey: kp.publicKey }]);

      const buf = Buffer.from(payload.keys['dev_1'], 'base64');
      buf[0] ^= 0xff;
      const tampered: EncryptedPayload = {
        ...payload,
        keys: { 'dev_1': buf.toString('base64') },
      };

      expect(() => decrypt(tampered, 'dev_1', kp.privateKey)).toThrow();
    });

    it('should throw when encrypting with zero recipients', () => {
      expect(() => encrypt('message', [])).toThrow('At least one recipient');
    });

    it('recipient A cannot decrypt message for recipient B', () => {
      const kpA = generateKeyPair();
      const kpB = generateKeyPair();
      const payload = encrypt('for B only', [{ deviceId: 'dev_B', publicKey: kpB.publicKey }]);

      // A doesn't have a key entry
      expect(() => decrypt(payload, 'dev_A', kpA.privateKey)).toThrow('No encrypted key found');

      // A can't use B's wrapped key with A's private key
      expect(() => decrypt(payload, 'dev_B', kpA.privateKey)).toThrow();
    });
  });

  // ── Key export/import ─────────────────────────────

  describe('key export/import', () => {
    it('should round-trip public key through export/import', () => {
      const kp = generateKeyPair();
      const exported = exportPublicKey(kp.publicKey);
      const imported = importPublicKey(exported);

      // Verify the imported key works for encryption
      const payload = encrypt('test', [{ deviceId: 'dev_1', publicKey: imported }]);
      expect(decrypt(payload, 'dev_1', kp.privateKey)).toBe('test');
    });

    it('exported key should be compact (no PEM headers)', () => {
      const kp = generateKeyPair();
      const exported = exportPublicKey(kp.publicKey);
      expect(exported).not.toContain('BEGIN');
      expect(exported).not.toContain('END');
      expect(exported).not.toContain('\n');
    });

    it('should handle empty key string', () => {
      const imported = importPublicKey('');
      expect(imported).toContain('BEGIN PUBLIC KEY');
      expect(imported).toContain('END PUBLIC KEY');
    });

    it('imported key should be valid PEM', () => {
      const kp = generateKeyPair();
      const exported = exportPublicKey(kp.publicKey);
      const imported = importPublicKey(exported);
      expect(imported).toContain('-----BEGIN PUBLIC KEY-----');
      expect(imported).toContain('-----END PUBLIC KEY-----');
    });
  });

  // ── Payload structure ─────────────────────────────

  describe('payload structure', () => {
    it('should produce valid base64 in all fields', () => {
      const kp = generateKeyPair();
      const payload = encrypt('test', [{ deviceId: 'dev_1', publicKey: kp.publicKey }]);

      // All fields should be valid base64
      expect(() => Buffer.from(payload.iv, 'base64')).not.toThrow();
      expect(() => Buffer.from(payload.ciphertext, 'base64')).not.toThrow();
      expect(() => Buffer.from(payload.tag, 'base64')).not.toThrow();
      expect(() => Buffer.from(payload.keys['dev_1'], 'base64')).not.toThrow();
    });

    it('should be JSON-serializable (for WebSocket transport)', () => {
      const kp = generateKeyPair();
      const payload = encrypt('test message', [{ deviceId: 'dev_1', publicKey: kp.publicKey }]);

      const json = JSON.stringify(payload);
      const parsed = JSON.parse(json) as EncryptedPayload;

      // Decrypt from parsed JSON
      expect(decrypt(parsed, 'dev_1', kp.privateKey)).toBe('test message');
    });

    it('IV should be 12 bytes (96 bits for GCM)', () => {
      const kp = generateKeyPair();
      const payload = encrypt('test', [{ deviceId: 'dev_1', publicKey: kp.publicKey }]);
      expect(Buffer.from(payload.iv, 'base64').length).toBe(12);
    });

    it('auth tag should be 16 bytes', () => {
      const kp = generateKeyPair();
      const payload = encrypt('test', [{ deviceId: 'dev_1', publicKey: kp.publicKey }]);
      expect(Buffer.from(payload.tag, 'base64').length).toBe(16);
    });
  });

  // ── Challenge-response signing ────────────────────

  describe('challenge-response', () => {
    it('should sign and verify a nonce', () => {
      const kp = generateKeyPair();
      const nonce = 'random-nonce-12345';
      const signature = signChallenge(nonce, kp.privateKey);
      expect(verifyChallenge(nonce, signature, kp.publicKey)).toBe(true);
    });

    it('should reject wrong nonce', () => {
      const kp = generateKeyPair();
      const signature = signChallenge('original-nonce', kp.privateKey);
      expect(verifyChallenge('different-nonce', signature, kp.publicKey)).toBe(false);
    });

    it('should reject wrong public key', () => {
      const kp1 = generateKeyPair();
      const kp2 = generateKeyPair();
      const signature = signChallenge('nonce', kp1.privateKey);
      expect(verifyChallenge('nonce', signature, kp2.publicKey)).toBe(false);
    });

    it('should work with exported/imported keys', () => {
      const kp = generateKeyPair();
      const exported = exportPublicKey(kp.publicKey);
      const imported = importPublicKey(exported);
      const signature = signChallenge('test-nonce', kp.privateKey);
      expect(verifyChallenge('test-nonce', signature, imported)).toBe(true);
    });
  });

  // ── Performance sanity ────────────────────────────

  describe('performance', () => {
    it('should encrypt/decrypt 500 small messages in under 10 seconds', () => {
      const kp = generateKeyPair();
      const recipients: RecipientKey[] = [{ deviceId: 'dev_1', publicKey: kp.publicKey }];

      const start = Date.now();
      for (let i = 0; i < 500; i++) {
        const payload = encrypt(`message ${i}`, recipients);
        decrypt(payload, 'dev_1', kp.privateKey);
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(10000);
    });
  });
});
