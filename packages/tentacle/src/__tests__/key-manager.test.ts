import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KeyManager } from '../key-manager.js';
import { encrypt } from '@kraki/crypto';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function tmpKeysDir(): string {
  const dir = join(tmpdir(), `kraki-keys-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('KeyManager', () => {
  let dir: string;

  beforeEach(() => { dir = tmpKeysDir(); });
  afterEach(() => { try { rmSync(dir, { recursive: true }); } catch {} });

  it('should generate keypair on first access', () => {
    const km = new KeyManager(dir);
    const kp = km.getKeyPair();
    expect(kp.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(kp.privateKey).toContain('BEGIN PRIVATE KEY');
  });

  it('should persist keys to disk', () => {
    const km = new KeyManager(dir);
    km.getKeyPair();
    expect(existsSync(join(dir, 'private.pem'))).toBe(true);
    expect(existsSync(join(dir, 'public.pem'))).toBe(true);
  });

  it('should reuse keys across instances (same dir)', () => {
    const km1 = new KeyManager(dir);
    const kp1 = km1.getKeyPair();
    const km2 = new KeyManager(dir);
    const kp2 = km2.getKeyPair();
    expect(kp1.publicKey).toBe(kp2.publicKey);
    expect(kp1.privateKey).toBe(kp2.privateKey);
  });

  it('should return compact public key', () => {
    const km = new KeyManager(dir);
    const compact = km.getCompactPublicKey();
    expect(compact).not.toContain('BEGIN');
    expect(compact).not.toContain('\n');
    expect(compact.length).toBeGreaterThan(100);
  });

  it('should encrypt for recipients', () => {
    const km = new KeyManager(dir);
    const kp = km.getKeyPair();
    const payload = km.encryptForRecipients('secret', [
      { deviceId: 'dev_1', publicKey: kp.publicKey },
    ]);
    expect(payload.ciphertext).toBeTruthy();
    expect(payload.keys['dev_1']).toBeTruthy();
  });

  it('should decrypt messages for this device', () => {
    const km = new KeyManager(dir);
    const kp = km.getKeyPair();
    const encrypted = encrypt('hello from app', [
      { deviceId: 'dev_me', publicKey: kp.publicKey },
    ]);
    const result = km.decryptForMe(encrypted, 'dev_me');
    expect(result).toBe('hello from app');
  });

  it('should fail to decrypt with wrong device ID', () => {
    const km = new KeyManager(dir);
    const kp = km.getKeyPair();
    const encrypted = encrypt('secret', [
      { deviceId: 'dev_other', publicKey: kp.publicKey },
    ]);
    expect(() => km.decryptForMe(encrypted, 'dev_wrong')).toThrow();
  });
});
