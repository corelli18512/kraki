import { decodeFrame, type Effect, Endpoint } from '@coinfra/pulse';
import type { InnerMessage } from '@kraki/protocol';
import { createLogger } from './logger';

const logger = createLogger('pulse');

/**
 * ArmPulse — the arm's single per-hop pulse endpoint to the relay.
 *
 * The arm has one WebSocket (to head), so it runs one {@link Endpoint}. Reliable
 * consumer messages (already encrypted to an opaque blob) are handed to the
 * endpoint; the pulse frame rides the envelope `pulse` field. head acks, fans
 * out, and — for durable messages (delete_session) — holds them for an offline
 * tentacle. The arm is NOT durable-supported (it's the frequently-offline side;
 * the relay holds durable state, not the phone).
 *
 * The endpoint also drives the optimistic-UI resolution: `acked(seqUpTo)` tells
 * the app which sends the relay has confirmed, so the app can finalize an
 * optimistic action or, on timeout with no ack, roll it back.
 */
export interface ArmPulseHost {
  /** Send a pulse frame to the relay (unicast envelope, `pulse` field). */
  sendPulseFrame(pulseB64: string, targetDeviceId: string): void;
  /** A reliable payload was delivered in order — the JSON string {blob, keys}. */
  onDelivered(payloadJson: string): void;
  /** The relay confirmed receipt of every send with seq ≤ seqUpTo. */
  onAcked(seqUpTo: bigint): void;
  now(): number;
}

// Browser-safe base64 (btoa/atob over Latin-1 bytes).
function b64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const enc = new TextEncoder();
const dec = new TextDecoder();

export class ArmPulse {
  private endpoint: Endpoint;
  /** Per-send target, keyed by the DATA frame's seq. A single mutable
   *  "currentTarget" is WRONG: retransmits (from onConnected/onFrame/tick, e.g.
   *  after packet loss or reconnect) fire OUTSIDE the synchronous send() window,
   *  so they'd emit with an empty target. For E2E traffic an empty `to` degrades
   *  to broadcast (tolerated — only the right tentacle can decrypt). But for
   *  PLAINTEXT head-bound control (HEAD_PULSE_TARGET) an empty `to` would both
   *  miss the head's self-dispatch AND leak the control JSON to every device. So
   *  the target must be recovered per DATA seq on every transmit, resends
   *  included. Control frames (hello/ack/heartbeat/reset) carry no target. */
  private targetBySeq = new Map<bigint, string>();

  constructor(
    private readonly host: ArmPulseHost,
    epoch: string,
  ) {
    this.endpoint = new Endpoint({ epoch, durable: { supported: false } });
  }

  /** Send a reliable message (a JSON string {blob, keys}, or plaintext control
   *  JSON for HEAD_PULSE_TARGET) toward `targetDeviceId`. `durable` marks it for
   *  relay persistence while the target is offline. Returns the assigned pulse
   *  seq so the caller can track it for rollback. */
  send(payloadJson: string, targetDeviceId: string, durable: boolean): bigint {
    const { seq, effects } = this.endpoint.send(enc.encode(payloadJson), { durable });
    this.targetBySeq.set(seq, targetDeviceId);
    this.run(effects);
    return seq;
  }

  onConnected(): void {
    this.run(this.endpoint.onConnected(this.host.now()));
  }
  onDisconnected(): void {
    this.endpoint.onDisconnected(this.host.now());
  }
  onFrame(pulseB64: string): void {
    this.run(this.endpoint.onBytes(unb64(pulseB64), this.host.now()));
  }
  tick(): void {
    this.run(this.endpoint.onTick(this.host.now()));
  }

  private run(effects: Effect[]): void {
    for (const e of effects) {
      switch (e.t) {
        case 'transmit': {
          // Recover the target for THIS frame from its DATA seq, so retransmits
          // (fired outside send()) carry the right `to` — critical for plaintext
          // head-bound control (see targetBySeq). Non-data control frames
          // (hello/ack/heartbeat/reset) have no target → empty.
          const frame = decodeFrame(e.bytes);
          const target = frame?.t === 'data' ? (this.targetBySeq.get(frame.seq) ?? '') : '';
          this.host.sendPulseFrame(b64(e.bytes), target);
          break;
        }
        case 'deliver':
          this.host.onDelivered(dec.decode(e.payload));
          break;
        case 'acked':
          // Prune targets the relay has confirmed — they'll never be resent.
          for (const s of this.targetBySeq.keys()) {
            if (s <= e.seqUpTo) this.targetBySeq.delete(s);
          }
          this.host.onAcked(e.seqUpTo);
          break;
        case 'reset-inbound':
          logger.warn('pulse reset-inbound (relay stream reset)', { from: String(e.fromSeq) });
          break;
        // store/unstore/open/close: arm is not durable-supported; lifecycle
        // driven explicitly.
      }
    }
  }
}

export type { InnerMessage };
