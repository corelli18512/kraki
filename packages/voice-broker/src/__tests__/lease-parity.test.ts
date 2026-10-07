/**
 * Lease verification exists twice: src/lease-verifier.ts (development broker,
 * @kraki/crypto) and deploy/kraki-lease-authorizer.mjs (production adapter,
 * dependency-free). They must agree on canonical JSON and on which leases are
 * valid, or production and development silently diverge.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { signChallenge, canonicalJson } from '@kraki/crypto';
import type { VoiceLease, VoiceLeasePayload } from '@kraki/protocol';
import { verifyLease } from '../lease-verifier.js';
// @ts-expect-error — plain .mjs deploy module without type declarations.
import { canonicalLeasePayload, createKrakiConnectionAuthorizer } from '../../deploy/kraki-lease-authorizer.mjs';

const NOW = 1_800_000_000;
let pub = '';
let priv = '';
let otherPriv = '';

beforeAll(() => {
  const a = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b = generateKeyPairSync('rsa', { modulusLength: 2048 });
  pub = a.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  priv = a.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  otherPriv = b.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
});

function payload(overrides: Partial<VoiceLeasePayload> = {}): VoiceLeasePayload {
  return {
    ver: 1, iss: 'kraki-head', sub: 'user-é', did: 'dev_1', iat: NOW - 10, exp: NOW + 600,
    quota_seconds: 300, resource: 'voice/doubao', jti: 'jti-1', ...overrides,
  } as VoiceLeasePayload;
}

function sign(p: VoiceLeasePayload, key = priv): VoiceLease {
  return { payload: p, signature: signChallenge(canonicalJson(p as unknown as Record<string, unknown>), key), alg: 'RSA-SHA256' };
}

async function production(lease: unknown): Promise<boolean> {
  const authorize = createKrakiConnectionAuthorizer(pub, { now: () => NOW });
  const result = await authorize({ authorize: { type: 'authorize', authorization: lease, deviceId: 'dev_1' } });
  return result?.ok === true;
}

function development(lease: unknown): boolean {
  return verifyLease(lease, pub, { resource: 'voice/doubao', deviceId: 'dev_1', nowUnixSec: NOW }).ok;
}

describe('lease verification parity (development broker vs production adapter)', () => {
  it('canonical JSON is byte-identical', () => {
    const p = payload({ sub: 'üñí 用户 "quoted"' });
    expect(canonicalLeasePayload(p)).toBe(canonicalJson(p as unknown as Record<string, unknown>));
  });

  it('both accept a valid lease', async () => {
    const lease = sign(payload());
    expect(development(lease)).toBe(true);
    expect(await production(lease)).toBe(true);
  });

  it.each([
    ['wrong key', () => sign(payload(), otherPriv)],
    ['expired', () => sign(payload({ exp: NOW - 1 }))],
    ['not yet valid', () => sign(payload({ iat: NOW + 3600 }))],
    ['tampered payload', () => ({ ...sign(payload()), payload: payload({ quota_seconds: 99_999 }) })],
    ['zero quota', () => sign(payload({ quota_seconds: 0 }))],
    ['other resource', () => sign(payload({ resource: 'voice/other' as VoiceLeasePayload['resource'] }))],
  ])('both reject: %s', async (_name, make) => {
    const lease = make();
    expect(development(lease)).toBe(false);
    expect(await production(lease)).toBe(false);
  });
});
