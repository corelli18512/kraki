/**
 * Challenge nonces that need no stored state until they are answered.
 *
 * Starting a challenge needs no sign-in: anyone who knows a device id can ask
 * for any number of nonces for it. If issuing stored each nonce in a bounded
 * pool, those requests would push the real device's pending nonce out and
 * block its sign-in. So a nonce carries its own proof instead: when it was
 * issued and two MACs under a per-process secret, one saying "issued here"
 * and one binding it to the device. Only nonces whose answer was accepted are
 * remembered (until they expire), which keeps each one single-use.
 *
 * Layout, 32 bytes sent as 64 hex characters like every Kraki nonce:
 * issued-at ms (6) | random (10) | MAC "issued here" (8) | MAC device (8).
 * A restart changes the secret, so older nonces read as `unknown`.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * - `valid`: issued here for this device, unexpired, not yet accepted.
 * - `expired`: issued here for this device, older than the TTL.
 * - `used`: issued here for this device, and an answer was already accepted.
 * - `foreign`: issued here, for another device.
 * - `unknown`: not issued by this process.
 */
export type ChallengeNonceCheck = 'valid' | 'expired' | 'used' | 'foreign' | 'unknown';

const HEAD_BYTES = 16;
const MAC_BYTES = 8;

export class ChallengeNonces {
  private readonly secret = randomBytes(32);
  /** Accepted nonces and when they expire. */
  private readonly accepted = new Map<string, number>();
  private lastSweep = 0;

  constructor(private readonly ttlMs: number, private readonly now: () => number = () => Date.now()) {}

  issue(deviceId: string): string {
    const head = Buffer.alloc(HEAD_BYTES);
    head.writeUIntBE(Math.max(0, Math.floor(this.now())), 0, 6);
    randomBytes(HEAD_BYTES - 6).copy(head, 6);
    return Buffer.concat([head, this.issuerMac(head), this.deviceMac(head, deviceId)]).toString('hex');
  }

  check(nonce: string, deviceId: string): ChallengeNonceCheck {
    if (!/^[0-9a-f]{64}$/.test(nonce)) return 'unknown';
    const bytes = Buffer.from(nonce, 'hex');
    const head = bytes.subarray(0, HEAD_BYTES);
    if (!timingSafeEqual(bytes.subarray(HEAD_BYTES, HEAD_BYTES + MAC_BYTES), this.issuerMac(head))) return 'unknown';
    if (!timingSafeEqual(bytes.subarray(HEAD_BYTES + MAC_BYTES), this.deviceMac(head, deviceId))) return 'foreign';
    if (this.accepted.has(nonce)) return 'used';
    return head.readUIntBE(0, 6) + this.ttlMs >= this.now() ? 'valid' : 'expired';
  }

  /** An answer to this `valid` nonce was accepted: it reads as `used` from now
   *  on (and `expired` once its TTL is over). */
  accept(nonce: string): void {
    this.sweep();
    this.accepted.set(nonce, Buffer.from(nonce, 'hex').readUIntBE(0, 6) + this.ttlMs);
  }

  /** Forget accepted nonces that have expired anyway (at most once a TTL). */
  sweep(): void {
    const now = this.now();
    if (now - this.lastSweep < this.ttlMs) return;
    this.lastSweep = now;
    for (const [nonce, expiresAt] of this.accepted) {
      if (expiresAt < now) this.accepted.delete(nonce);
    }
  }

  private issuerMac(head: Buffer): Buffer {
    return createHmac('sha256', this.secret).update('issuer\0').update(head).digest().subarray(0, MAC_BYTES);
  }

  private deviceMac(head: Buffer, deviceId: string): Buffer {
    return createHmac('sha256', this.secret).update('device\0').update(head).update(deviceId).digest().subarray(0, MAC_BYTES);
  }
}
