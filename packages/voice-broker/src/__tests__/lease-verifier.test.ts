/**
 * Unit tests for the broker's offline lease verifier.
 *
 * We mint leases inline using node:crypto + @kraki/crypto so this file has
 * zero dependency on the head package — proving the verifier is self-contained
 * and only assumes the canonical-JSON + RSA-SHA256 contract.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { signChallenge, canonicalJson } from '@kraki/crypto';
import type { VoiceLease, VoiceLeasePayload } from '@kraki/protocol';
import { verifyLease } from '../lease-verifier.js';

const NOW = 1_700_000_000;
const DID = 'dev_abc';

let pubKeyPem: string;
let privKeyPem: string;
let otherPubKeyPem: string;
let otherPrivKeyPem: string;

beforeAll(() => {
  const a = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b = generateKeyPairSync('rsa', { modulusLength: 2048 });
  pubKeyPem = a.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  privKeyPem = a.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  otherPubKeyPem = b.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  otherPrivKeyPem = b.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
});

function sign(payload: VoiceLeasePayload, key = privKeyPem): VoiceLease {
  const canonical = canonicalJson(payload as unknown as Record<string, unknown>);
  return { payload, signature: signChallenge(canonical, key), alg: 'RSA-SHA256' };
}

function mkLease(overrides: Partial<{
  did: string; iat: number; exp: number; ttl: number; quota: number; resource: VoiceLeasePayload['resource']; userId: string; key: string;
}> = {}): VoiceLease {
  const did = overrides.did ?? DID;
  const iat = overrides.iat ?? NOW;
  const exp = overrides.exp ?? iat + (overrides.ttl ?? 3600);
  const payload: VoiceLeasePayload = {
    ver: 1,
    iss: 'kraki-head',
    sub: overrides.userId ?? 'u1',
    did,
    iat,
    exp,
    quota_seconds: overrides.quota ?? 1800,
    resource: overrides.resource ?? 'voice/doubao',
    jti: randomUUID(),
  };
  return sign(payload, overrides.key);
}

describe('verifyLease — happy path', () => {
  it('accepts a freshly-issued lease bound to the correct device/resource', () => {
    const lease = mkLease();
    const res = verifyLease(lease, pubKeyPem, { resource: 'voice/doubao', deviceId: DID, nowUnixSec: NOW + 60 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload.did).toBe(DID);
      expect(res.payload.quota_seconds).toBe(1800);
    }
  });
});

describe('verifyLease — shape / malformed', () => {
  it('rejects null', () => {
    const res = verifyLease(null, pubKeyPem, { resource: 'voice/doubao', deviceId: DID, nowUnixSec: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('malformed');
  });

  it('rejects an object missing payload', () => {
    const res = verifyLease({ signature: 'x', alg: 'RSA-SHA256' }, pubKeyPem, { resource: 'voice/doubao', deviceId: DID, nowUnixSec: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('malformed');
  });

  it('rejects payload with wrong ver', () => {
    const lease = mkLease();
    const tampered = { ...lease, payload: { ...lease.payload, ver: 2 as unknown as 1 } };
    const res = verifyLease(tampered, pubKeyPem, { resource: 'voice/doubao', deviceId: DID, nowUnixSec: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('malformed');
  });
});

describe('verifyLease — cryptographic', () => {
  it('rejects a lease signed with a different (rotated) key', () => {
    const lease = mkLease({ key: otherPrivKeyPem });
    const res = verifyLease(lease, pubKeyPem, { resource: 'voice/doubao', deviceId: DID, nowUnixSec: NOW + 60 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_signature');
  });

  it('accepts the same lease against the correct (other) key', () => {
    const lease = mkLease({ key: otherPrivKeyPem });
    const res = verifyLease(lease, otherPubKeyPem, { resource: 'voice/doubao', deviceId: DID, nowUnixSec: NOW + 60 });
    expect(res.ok).toBe(true);
  });

  it('rejects a lease whose payload was tampered after signing', () => {
    const lease = mkLease({ quota: 100 });
    const tampered: VoiceLease = {
      ...lease,
      payload: { ...lease.payload, quota_seconds: 99999 },
    };
    const res = verifyLease(tampered, pubKeyPem, { resource: 'voice/doubao', deviceId: DID, nowUnixSec: NOW + 60 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_signature');
  });
});

describe('verifyLease — time window', () => {
  it('rejects an expired lease', () => {
    const lease = mkLease({ ttl: 60 });
    const res = verifyLease(lease, pubKeyPem, { resource: 'voice/doubao', deviceId: DID, nowUnixSec: NOW + 3600 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('expired');
  });

  it('rejects a not-yet-valid lease beyond skew tolerance', () => {
    const lease = mkLease({ iat: NOW + 600 });
    const res = verifyLease(lease, pubKeyPem, { resource: 'voice/doubao', deviceId: DID, nowUnixSec: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not_yet_valid');
  });

  it('tolerates small clock skew', () => {
    const lease = mkLease({ iat: NOW + 10 });
    const res = verifyLease(lease, pubKeyPem, { resource: 'voice/doubao', deviceId: DID, nowUnixSec: NOW, clockSkewSec: 30 });
    expect(res.ok).toBe(true);
  });
});

describe('verifyLease — binding mismatches', () => {
  it('rejects when the device id does not match', () => {
    const lease = mkLease();
    const res = verifyLease(lease, pubKeyPem, { resource: 'voice/doubao', deviceId: 'dev_other', nowUnixSec: NOW + 60 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('wrong_device');
  });

  it('rejects when the resource does not match', () => {
    const lease = mkLease();
    const res = verifyLease(lease, pubKeyPem, { resource: 'voice/whisper' as 'voice/doubao', deviceId: DID, nowUnixSec: NOW + 60 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('wrong_resource');
  });
});

describe('verifyLease — quota sanity', () => {
  it('rejects a zero-quota lease', () => {
    const lease = mkLease({ quota: 0 });
    const res = verifyLease(lease, pubKeyPem, { resource: 'voice/doubao', deviceId: DID, nowUnixSec: NOW + 60 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no_quota');
  });
});

