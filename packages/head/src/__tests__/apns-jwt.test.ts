import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApnsProvider } from '../push/apns.js';

describe('APNs provider JWT', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('is a JWS ES256 token: 64-byte r||s signature that verifies', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    dir = mkdtempSync(join(tmpdir(), 'kraki-apns-'));
    const keyPath = join(dir, 'AuthKey.p8');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const provider = new ApnsProvider({ keyPath, keyId: 'KEYID12345', teamId: 'TEAM123456', bundleId: 'chat.kraki.app' });
    try {
      const token = (provider as unknown as { getJwt(): string }).getJwt();
      const [header, payload, signature] = token.split('.');
      expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEYID12345' });
      expect(JSON.parse(Buffer.from(payload, 'base64url').toString()).iss).toBe('TEAM123456');
      const sig = Buffer.from(signature, 'base64url');
      expect(sig.length).toBe(64);
      expect(verify('SHA256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
    } finally {
      provider.close();
    }
  });
});
