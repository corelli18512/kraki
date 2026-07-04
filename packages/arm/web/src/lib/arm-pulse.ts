import { type Effect, Endpoint } from '@kraki/pulse';
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
  /** Target tentacle for the frame currently being emitted (per send). */
  private currentTarget = '';

  constructor(
    private readonly host: ArmPulseHost,
    private readonly enabled: boolean,
    epoch: string,
  ) {
    this.endpoint = new Endpoint({ epoch, durable: { supported: false } });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Send a reliable message (a JSON string {blob, keys}) toward a tentacle.
   *  `durable` marks it for relay persistence while the tentacle is offline.
   *  Returns the assigned pulse seq so the caller can track it for rollback. */
  send(payloadJson: string, targetDeviceId: string, durable: boolean): bigint {
    this.currentTarget = targetDeviceId;
    const { seq, effects } = this.endpoint.send(enc.encode(payloadJson), { durable });
    this.run(effects);
    this.currentTarget = '';
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
        case 'transmit':
          this.host.sendPulseFrame(b64(e.bytes), this.currentTarget);
          break;
        case 'deliver':
          this.host.onDelivered(dec.decode(e.payload));
          break;
        case 'acked':
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
