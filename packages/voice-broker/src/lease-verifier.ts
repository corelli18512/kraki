/**
 * Voice lease verifier — offline cryptographic check that the broker
 * performs at handshake to authorise a session.
 *
 * Public-key pinning model: the head ships its lease signing **public key**
 * to the broker (out-of-band, via env var or file). The broker calls
 * `verifyLease(...)` with that pinned PEM. There is no network round-trip
 * back to head and no JWKS rotation — explicit rotations happen via
 * redeploy.
 *
 * Returned reasons map 1:1 to the values broker emits over the wire so the
 * client can react sensibly.
 */

import { verifyChallenge, canonicalJson } from '@kraki/crypto';
import type { VoiceLease, VoiceLeasePayload, VoiceResource } from '@kraki/protocol';

export type VerifyReason =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'wrong_resource'
  | 'wrong_device'
  | 'no_quota';

export interface VerifyOk {
  ok: true;
  payload: VoiceLeasePayload;
}

export interface VerifyFail {
  ok: false;
  reason: VerifyReason;
  detail?: string;
}

export interface VerifyInput {
  /** Required resource (e.g. 'voice/doubao'). */
  resource: VoiceResource;
  /** Required device id (broker enforces deviceId match per session). */
  deviceId: string;
  /** Current time (unix sec) — injected for testability. Defaults to now. */
  nowUnixSec?: number;
  /** Tolerance for "not_yet_valid" clock skew, in seconds. Default 30. */
  clockSkewSec?: number;
}

/**
 * Validate a lease against a pinned public key + expected resource/device.
 *
 * Pure function — no I/O, no logging. Callers wrap with their own logging.
 */
export function verifyLease(
  lease: unknown,
  publicKeyPem: string,
  expected: VerifyInput
): VerifyOk | VerifyFail {
  // 1. Shape check — defensive parsing because the lease comes off the wire.
  if (!isVoiceLeaseShape(lease)) {
    return { ok: false, reason: 'malformed', detail: 'lease shape invalid' };
  }
  const p = lease.payload;

  // 2. Resource & device match (cheap, do before expensive signature check
  //    so an obviously-wrong lease fails fast).
  if (p.resource !== expected.resource) {
    return { ok: false, reason: 'wrong_resource', detail: `expected ${expected.resource} got ${p.resource}` };
  }
  if (p.did !== expected.deviceId) {
    return { ok: false, reason: 'wrong_device', detail: `lease bound to ${p.did}` };
  }

  // 3. Time window.
  const now = expected.nowUnixSec ?? Math.floor(Date.now() / 1000);
  const skew = expected.clockSkewSec ?? 30;
  if (p.iat > now + skew) {
    return { ok: false, reason: 'not_yet_valid', detail: `iat=${p.iat} now=${now}` };
  }
  if (p.exp <= now) {
    return { ok: false, reason: 'expired', detail: `exp=${p.exp} now=${now}` };
  }

  // 4. Quota sanity (a zero-quota lease is meaningless).
  if (!Number.isFinite(p.quota_seconds) || p.quota_seconds <= 0) {
    return { ok: false, reason: 'no_quota', detail: `quota=${p.quota_seconds}` };
  }

  // 5. Cryptographic signature — last step because it's the most expensive.
  let canonical: string;
  try {
    canonical = canonicalJson(p as unknown as Record<string, unknown>);
  } catch (err) {
    return { ok: false, reason: 'malformed', detail: `canonical serialize: ${(err as Error).message}` };
  }
  let verified: boolean;
  try {
    verified = verifyChallenge(canonical, lease.signature, publicKeyPem);
  } catch (err) {
    return { ok: false, reason: 'bad_signature', detail: (err as Error).message };
  }
  if (!verified) {
    return { ok: false, reason: 'bad_signature' };
  }

  return { ok: true, payload: p };
}

// ---------------------------------------------------------------------------
// Shape guard — narrow `unknown` to `VoiceLease` without importing a runtime
// guard from @kraki/protocol (protocol is pure types per house style).
// ---------------------------------------------------------------------------
function isVoiceLeaseShape(x: unknown): x is VoiceLease {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.signature !== 'string' || o.signature.length === 0) return false;
  // alg is optional on the wire today — head currently always sets
  // 'RSA-SHA256'. Reject if explicitly set to anything else, but tolerate
  // missing (e.g. older clients) since the signature scheme is fixed.
  if (o.alg !== undefined && o.alg !== 'RSA-SHA256') return false;
  if (!o.payload || typeof o.payload !== 'object') return false;
  const p = o.payload as Record<string, unknown>;
  return (
    p.ver === 1 &&
    typeof p.iss === 'string' &&
    typeof p.sub === 'string' &&
    typeof p.did === 'string' &&
    typeof p.iat === 'number' &&
    typeof p.exp === 'number' &&
    typeof p.quota_seconds === 'number' &&
    typeof p.resource === 'string' &&
    typeof p.jti === 'string'
  );
}
