/**
 * Device trust on the Tentacle: seal outbound payloads to pinned app keys,
 * authenticate inbound commands, and accept pairings.
 *
 * Two modes, from `<KRAKI_HOME>/trust/policy.json` (`kraki devices enforce
 * on|off`, or a paired app), overridable with `KRAKI_DEVICE_TRUST`:
 * - **enforced**: only paired apps receive
 *   anything and only their signed messages are acted on. The relay can drop
 *   or delay traffic, but cannot read it, inject commands or enroll a device.
 * - **compatible**: paired apps get signed X25519 payloads and must
 *   sign; unpaired apps keep the legacy RSA path. This is the migration step:
 *   pair every app, then enforce.
 *
 * See docs/e2e-trust.md.
 */

import {
  ANY_RECIPIENT, checkSignedMessage, decryptFromBlob, decryptV2, encryptToBlob, encryptV2, importPublicKey,
  isRawPublicKey, isSignedMessage, isV2Payload, signMessage, verifySignature,
  type PairingClaim, type SignedMessage,
} from '@kraki/crypto';
import type { KeyManager } from '../key-manager.js';
import { TrustStore, type TrustedDevice } from '../trust-store.js';
import { logger } from './shared.js';

/** `consumerKeys` value for a paired app without a pinned RSA key: it gets
 *  X25519 payloads only (and no RSA push preview). */
export const NO_RSA_KEY = 'x25519-only';
/** Marks a device-trust push preview in the preview's per-device `keys`. */
export const PUSH_V2_PREFIX = 'v2.';

export type OpenResult =
  | { kind: 'message'; inner: Record<string, unknown>; signed: boolean; toAll?: boolean }
  | { kind: 'pair_request'; signed: SignedMessage; inner: Record<string, unknown> }
  | { kind: 'rejected'; reason: string };

export interface PairOutcome {
  ok: boolean;
  appId: string;
  reason?: string;
  /** The app's X25519 key from the claim (to answer even on failure). */
  encryptionKey?: string;
  device?: TrustedDevice;
}

/** A fixed mode from the environment, if set. */
export function deviceTrustModeFromEnv(): 'enforce' | 'compatible' | undefined {
  const v = process.env.KRAKI_DEVICE_TRUST;
  if (v === 'enforce' || v === '1') return 'enforce';
  if (v === 'compatible' || v === '0') return 'compatible';
  return undefined;
}

/** Messages only a paired app may send (checked by signature). */
export const TRUST_ADMIN_TYPES: ReadonlySet<string> = new Set([
  'request_trusted_devices',
  'revoke_device',
  'set_trust_policy',
]);

export class DeviceTrust {
  readonly stats = { signedIn: 0, unsignedIn: 0, rejected: 0, v2Out: 0, rsaOut: 0, paired: 0 };

  constructor(
    private readonly keyManager: KeyManager,
    readonly store: TrustStore,
    /** Fixed mode (option / environment); undefined follows the policy file. */
    private readonly fixedMode: 'enforce' | 'compatible' | undefined,
    private readonly selfId: () => string | undefined,
  ) {}

  get enforced(): boolean {
    return this.fixedMode ? this.fixedMode === 'enforce' : this.store.enforced;
  }

  /** Whether the mode can be changed (not fixed by option/environment). */
  get policyLocked(): boolean {
    return this.fixedMode !== undefined;
  }

  isTrusted(appId: string): boolean {
    return this.store.has(appId);
  }

  /** The `consumerKeys` value for a paired app: its pinned RSA key, never the relay's. */
  consumerKeyFor(appId: string): string | undefined {
    const d = this.store.get(appId);
    return d ? (d.rsaKey ?? NO_RSA_KEY) : undefined;
  }

  // ── Outbound ──────────────────────────────────────────

  private sign(body: string, to: string): string {
    const self = this.selfId();
    if (!self) throw new Error('No device ID');
    return JSON.stringify(signMessage(body, self, to, this.keyManager.getIdentityKey().privateKey));
  }

  /**
   * Encrypt `plaintext` for `targets`. Paired apps get one signed X25519
   * payload; in compatible mode the rest get the legacy RSA payload (using
   * `legacyKey`). Returns one entry per payload with its target subset.
   */
  seal(
    plaintext: string,
    targets: string[],
    legacyKey: (deviceId: string) => string | undefined,
  ): Array<{ payload: string; targets: string[] }> {
    const out: Array<{ payload: string; targets: string[] }> = [];
    const trusted = targets.filter((t) => this.store.has(t));
    if (trusted.length > 0) {
      const signed = this.sign(plaintext, trusted.length === 1 ? trusted[0]! : ANY_RECIPIENT);
      const blob = encryptV2(signed, trusted.map((t) => ({ recipientId: t, publicKey: this.store.get(t)!.encryptionKey })));
      this.stats.v2Out++;
      out.push({ payload: JSON.stringify({ v: 2, blob }), targets: trusted });
    }
    if (!this.enforced) {
      const legacy = targets.filter((t) => !this.store.has(t));
      const recipients: Array<{ deviceId: string; publicKey: string }> = [];
      for (const t of legacy) {
        const key = legacyKey(t);
        if (!key || key === NO_RSA_KEY) continue;
        try { recipients.push({ deviceId: t, publicKey: importPublicKey(key) }); } catch { /* invalid key */ }
      }
      if (recipients.length > 0) {
        const { blob, keys } = encryptToBlob(plaintext, recipients);
        this.stats.rsaOut++;
        out.push({ payload: JSON.stringify({ blob, keys }), targets: recipients.map((r) => r.deviceId) });
      }
    }
    return out;
  }

  /** Signed X25519 payload to an explicit key (pair results). */
  sealToKey(plaintext: string, target: string, encryptionKey: string): string {
    const blob = encryptV2(this.sign(plaintext, target), [{ recipientId: target, publicKey: encryptionKey }]);
    return JSON.stringify({ v: 2, blob });
  }

  /**
   * A push preview for one paired app: signed and encrypted to its pinned
   * X25519 key, as the `v2.`-prefixed entry of the preview's `keys` map. The
   * Head forwards `{blob, key}` per device unchanged; the app (or iOS
   * Notification Service Extension) verifies the signature before showing it.
   */
  sealPushPreview(preview: string, appId: string): string | undefined {
    const device = this.store.get(appId);
    if (!device) return undefined;
    return PUSH_V2_PREFIX + encryptV2(this.sign(preview, appId), [{ recipientId: appId, publicKey: device.encryptionKey }]);
  }

  /** Signed message RSA-encrypted to a relay-reported key — only for notices
   *  that carry nothing secret (`trust_required`). */
  sealSignedToRelayKey(plaintext: string, target: string, compactRsaKey: string): string {
    const { blob, keys } = encryptToBlob(this.sign(plaintext, target), [{ deviceId: target, publicKey: importPublicKey(compactRsaKey) }]);
    return JSON.stringify({ blob, keys });
  }

  // ── Inbound ───────────────────────────────────────────

  private decrypt(parsed: Record<string, unknown>): string {
    const self = this.selfId();
    if (!self) throw new Error('No device ID');
    if (isV2Payload(parsed)) return decryptV2(parsed.blob, self, this.keyManager.getE2EKey().privateKey);
    const { blob, keys } = parsed as { blob: string; keys: Record<string, string> };
    return decryptFromBlob({ blob, keys }, self, this.keyManager.getKeyPair().privateKey);
  }

  /**
   * Decrypt and authenticate an app payload. `sender` is the relay-stamped
   * `src` (or the local-link peer). The signature, not the relay, decides
   * who sent it; the relay's stamp must merely agree.
   */
  open(parsed: Record<string, unknown>, sender: string | undefined): OpenResult {
    const reject = (reason: string, extra: Record<string, unknown> = {}): OpenResult => {
      this.stats.rejected++;
      logger.warn({ reason, src: sender, ...extra }, 'Rejected app payload (device trust)');
      return { kind: 'rejected', reason };
    };
    const outer = JSON.parse(this.decrypt(parsed)) as unknown;

    if (isSignedMessage(outer)) {
      if (sender !== undefined && outer.from !== sender) return reject('sender_mismatch', { from: outer.from });
      let inner: Record<string, unknown>;
      try { inner = JSON.parse(outer.body) as Record<string, unknown>; } catch { return reject('bad_body'); }
      if (typeof inner !== 'object' || inner === null) return reject('bad_body');
      const claimed = inner.deviceId;
      if (claimed !== undefined && claimed !== '' && claimed !== outer.from) return reject('device_mismatch');
      inner.deviceId = outer.from;
      // Pairing is verified on its own terms (signed by the key it enrolls),
      // also for an app that is already paired: re-pairing after a new QR scan
      // or a lost pair_result must reach the pairing handler.
      if (inner.type === 'pair_request') return { kind: 'pair_request', signed: outer, inner };
      const device = this.store.get(outer.from);
      if (device) {
        const rejection = checkSignedMessage(outer, device.identityKey, this.selfId()!, this.store.replayGuard);
        if (rejection) return reject(rejection, { from: outer.from, type: inner.type });
        // Persist the nonce before acting: a crash must not reopen the replay window.
        if (!this.store.noteAccepted()) return reject('replay_store_unwritable', { from: outer.from });
        this.stats.signedIn++;
        return { kind: 'message', inner, signed: true, toAll: outer.to === ANY_RECIPIENT };
      }
      if (this.enforced) return reject('untrusted_sender', { from: outer.from, type: inner.type });
      this.stats.unsignedIn++;
      return { kind: 'message', inner, signed: false };
    }

    const inner = outer as Record<string, unknown>;
    if (typeof inner !== 'object' || inner === null) return reject('bad_body');
    if (this.enforced) return reject('unsigned', { type: inner.type });
    // A paired app always signs; unsigned traffic in its name — by the relay's
    // stamp or by the deviceId it claims — is forged.
    if (sender !== undefined && this.store.has(sender)) return reject('unsigned_from_paired', { type: inner.type });
    if (typeof inner.deviceId === 'string' && this.store.has(inner.deviceId)) {
      return reject('unsigned_from_paired', { type: inner.type });
    }
    this.stats.unsignedIn++;
    return { kind: 'message', inner, signed: false };
  }

  /**
   * Verify a pair_request: signed by the key it enrolls (possession), bound to
   * this computer, fresh, and either proven with the QR secret or matched by a
   * same-machine enrollment file.
   */
  handlePairRequest(signed: SignedMessage, inner: Record<string, unknown>): PairOutcome {
    const self = this.selfId();
    const payload = (inner.payload ?? {}) as {
      claim?: Partial<PairingClaim>;
      proof?: unknown;
      local?: unknown;
      name?: unknown;
    };
    const c = payload.claim ?? {};
    const appId = signed.from;
    const fail = (reason: string): PairOutcome => {
      logger.warn({ appId, reason }, 'Pairing rejected');
      return { ok: false, appId, reason, ...(isRawPublicKey(c.encryptionKey) ? { encryptionKey: c.encryptionKey } : {}) };
    };
    if (!self) return fail('not_ready');
    if (c.appId !== appId) return fail('app_mismatch');
    if (c.tentacleId !== self) return fail('wrong_computer');
    if (!isRawPublicKey(c.identityKey) || !isRawPublicKey(c.encryptionKey)) return fail('bad_keys');
    if (typeof c.ts !== 'number') return fail('bad_claim');
    if (c.rsaKey !== undefined && typeof c.rsaKey !== 'string') return fail('bad_claim');
    if (signed.to !== self) return fail('wrong_recipient');
    if (!verifySignature(signed, c.identityKey)) return fail('bad_signature');
    // Anyone can sign a pair_request (with the key it enrolls), so its nonce
    // is recorded only once the pairing succeeds: failed attempts cost no
    // memory or disk. Replaying a successful one is harmless (one-time QR
    // secret / consumed enrollment file; identical keys only confirm again).
    const replay = this.store.replayGuard.peek(signed);
    if (replay) return fail(replay);
    const succeed = (outcome: PairOutcome): PairOutcome => {
      this.store.replayGuard.record(signed);
      return this.store.noteAccepted() ? outcome : fail('replay_store_unwritable');
    };
    // Already paired with exactly these keys (a re-scan, or the first
    // pair_result was lost): possession of the trusted identity key, proven
    // by the signature above, is enough to confirm again.
    const existing = this.store.get(appId);
    if (existing && existing.identityKey === c.identityKey && existing.encryptionKey === c.encryptionKey
      && (existing.rsaKey ?? undefined) === (c.rsaKey || undefined)) {
      return succeed({ ok: true, appId, encryptionKey: existing.encryptionKey, device: existing });
    }
    const claim: PairingClaim = {
      tentacleId: c.tentacleId, appId, identityKey: c.identityKey, encryptionKey: c.encryptionKey,
      ...(c.rsaKey ? { rsaKey: c.rsaKey } : {}), ts: c.ts,
    };
    const name = typeof payload.name === 'string' ? payload.name.slice(0, 120) : undefined;
    const ok = payload.local === true
      ? this.store.acceptLocalEnrollment(appId, claim.identityKey, claim.encryptionKey)
      : typeof payload.proof === 'string' && this.store.acceptQrPairing(claim, payload.proof, name);
    if (!ok) return fail(payload.local === true ? 'no_local_enrollment' : 'bad_proof');
    this.stats.paired++;
    return succeed({ ok: true, appId, encryptionKey: claim.encryptionKey, device: this.store.get(appId) });
  }
}
