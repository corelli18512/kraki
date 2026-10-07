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

describe('KeyManager recovery (release review Z8)', () => {
  it('derives a lost public key instead of minting a new identity', async () => {
    const { mkdtempSync, unlinkSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { KeyManager } = await import('../key-manager.js');
    const dir = mkdtempSync(join(tmpdir(), 'kraki-keys-'));
    const first = new KeyManager(dir).getCompactPublicKey();
    const priv = readFileSync(join(dir, 'private.pem'), 'utf8');
    unlinkSync(join(dir, 'public.pem'));
    const km = new KeyManager(dir);
    expect(km.getCompactPublicKey()).toBe(first);
    expect(km.getKeyPair().privateKey).toBe(priv);
  });
});

describe('KeyManager key creation race', () => {
  it('processes generating at the same time all end up with the one key on disk', async () => {
    const { execFile } = await import('node:child_process');
    const { mkdtempSync, readFileSync, rmSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, resolve } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'kraki-keyrace-'));
    const mod = resolve(__dirname, '../key-manager.ts');
    const script = `import { KeyManager } from ${JSON.stringify(mod)}; process.stdout.write(new KeyManager(${JSON.stringify(dir)}).getCompactPublicKey());`;
    const run = () => new Promise<string>((ok, fail) => execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: resolve(__dirname, '../..') }, (err, out) => (err ? fail(err) : ok(out))));
    try {
      const keys = await Promise.all([run(), run(), run(), run()]);
      expect(new Set(keys).size).toBe(1);
      const { exportPublicKey } = await import('@kraki/crypto');
      expect(exportPublicKey(readFileSync(join(dir, 'public.pem'), 'utf8'))).toBe(keys[0]);
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('repairs a public.pem that does not belong to private.pem', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { generateKeyPair } = await import('@kraki/crypto');
    const { KeyManager } = await import('../key-manager.js');
    const dir = mkdtempSync(join(tmpdir(), 'kraki-keyfix-'));
    try {
      const a = generateKeyPair(); const b = generateKeyPair();
      writeFileSync(join(dir, 'private.pem'), a.privateKey);
      writeFileSync(join(dir, 'public.pem'), b.publicKey);
      const { createPublicKey } = await import('node:crypto');
      const want = createPublicKey(a.privateKey).export({ type: 'spki', format: 'pem' }).toString();
      expect(new KeyManager(dir).getKeyPair().publicKey).toBe(want);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
