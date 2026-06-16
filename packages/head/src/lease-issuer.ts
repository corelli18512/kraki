/**
 * LeaseIssuer — head-side issuance of voice-broker leases.
 *
 * Owns the RSA-4096 signing keypair (persisted on disk so leases issued
 * before a restart remain verifiable after one). Pure functions for
 * issuance; the actual quota check lives in the WS handler that consults
 * Storage.sumVoiceLeaseQuotaIssuedToday.
 *
 * Wire format = @kraki/protocol's VoiceLease; signing primitive =
 * @kraki/crypto's signChallenge(canonicalJson(payload), privateKey).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { generateKeyPair, signChallenge, canonicalJson } from '@kraki/crypto';
import type { VoiceLease, VoiceLeasePayload, VoiceResource } from '@kraki/protocol';

const KEY_FILENAME_PRIVATE = 'voice-lease.priv.pem';
const KEY_FILENAME_PUBLIC = 'voice-lease.pub.pem';

export interface IssueLeaseInput {
  userId: string;
  deviceId: string;
  quotaSeconds: number;
  ttlSeconds: number;
  resource: VoiceResource;
  /** Override clock for testing. Defaults to Date.now()/1000. */
  nowUnixSec?: number;
  /** Override jti for testing / determinism. */
  jti?: string;
}

export class LeaseIssuer {
  private constructor(
    private readonly privateKeyPem: string,
    private readonly publicKeyPem: string,
  ) {}

  /**
   * Load the lease keypair from `dir`, generating one on first use.
   * Idempotent: if the files already exist they're reused as-is.
   * The private key file is chmod 600.
   */
  static loadOrGenerate(dir: string): LeaseIssuer {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const privPath = resolve(dir, KEY_FILENAME_PRIVATE);
    const pubPath = resolve(dir, KEY_FILENAME_PUBLIC);

    if (existsSync(privPath) && existsSync(pubPath)) {
      const privateKey = readFileSync(privPath, 'utf-8');
      const publicKey = readFileSync(pubPath, 'utf-8');
      return new LeaseIssuer(privateKey, publicKey);
    }

    const kp = generateKeyPair();
    writeFileSync(privPath, kp.privateKey, { encoding: 'utf-8' });
    writeFileSync(pubPath, kp.publicKey, { encoding: 'utf-8' });
    try {
      chmodSync(privPath, 0o600);
    } catch {
      // Best effort: on filesystems that don't support unix perms we just skip.
    }
    return new LeaseIssuer(kp.privateKey, kp.publicKey);
  }

  /** PEM-encoded public key. Distribute to brokers via env / file deploy. */
  getPublicKeyPem(): string {
    return this.publicKeyPem;
  }

  /**
   * Mint a signed lease. Pure function — no I/O. Caller is responsible
   * for quota checks and for persisting the lease via
   * `Storage.recordVoiceLease`.
   */
  issue(input: IssueLeaseInput): VoiceLease {
    const now = input.nowUnixSec ?? Math.floor(Date.now() / 1000);
    const payload: VoiceLeasePayload = {
      ver: 1,
      iss: 'kraki-head',
      sub: input.userId,
      did: input.deviceId,
      iat: now,
      exp: now + input.ttlSeconds,
      quota_seconds: input.quotaSeconds,
      resource: input.resource,
      jti: input.jti ?? randomUUID(),
    };
    const canonical = canonicalJson(payload as unknown as Record<string, unknown>);
    const signature = signChallenge(canonical, this.privateKeyPem);
    return { payload, signature, alg: 'RSA-SHA256' };
  }
}

/** Resolve the default keypair directory if VOICE_LEASE_DIR is unset. */
export function defaultVoiceLeaseDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return resolve(process.cwd(), '.kraki-head');
  return resolve(home, '.kraki-head');
}

/** Internal — for tests that want to know where keys live without leaking the const. */
export const _LEASE_KEY_FILENAMES = {
  private: KEY_FILENAME_PRIVATE,
  public: KEY_FILENAME_PUBLIC,
} as const;
