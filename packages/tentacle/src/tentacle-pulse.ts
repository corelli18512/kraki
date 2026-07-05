/**
 * TentaclePulse — the tentacle's single per-hop pulse endpoint to the relay.
 *
 * pulse is a reliable-WebSocket-replacement layer. The tentacle has exactly one
 * WebSocket (to head), so it runs exactly one {@link Endpoint} here. Reliable
 * producer messages (encrypted to an opaque blob) are handed to the endpoint;
 * the resulting pulse frame travels in the envelope `pulse` field. head (a pulse
 * endpoint on its side) acks, and — crucially — fans the payload out to each arm
 * via head's own per-arm endpoints. So the tentacle no longer fans out itself;
 * it sends ONE reliable stream to head.
 *
 * Not durable-supported: the tentacle is the "should-always-be-online" side; the
 * relay holds durable messages for offline arms, not the tentacle.
 */

import { type Effect, Endpoint } from '@coinfra/pulse';
import { createLogger } from './logger.js';

const logger = createLogger('pulse');

export interface TentaclePulseHost {
  /** Send a pulse frame to the relay as a broadcast envelope (head fans out). */
  sendPulseFrame(pulseB64: string): void;
  /** A reliable payload was delivered in order — the JSON string carrying
   *  {blob, keys} for the normal decrypt+dispatch path. */
  onDelivered(payloadJson: string): void;
  now(): number;
}

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
const enc = new TextEncoder();
const dec = new TextDecoder();

export class TentaclePulse {
  private endpoint: Endpoint;

  constructor(
    private readonly host: TentaclePulseHost,
    epoch: string,
  ) {
    this.endpoint = new Endpoint({
      epoch,
      durable: { supported: false },
    });
  }

  /** Send a reliable message (a JSON string carrying {blob, keys}) via pulse. */
  send(payloadJson: string): void {
    const { effects } = this.endpoint.send(enc.encode(payloadJson));
    this.run(effects);
  }

  /** The relay connection is up — resume the stream. */
  onConnected(): void {
    this.run(this.endpoint.onConnected(this.host.now()));
  }

  /** The relay connection dropped. */
  onDisconnected(): void {
    this.endpoint.onDisconnected(this.host.now());
  }

  /** An inbound pulse frame arrived from the relay. */
  onFrame(pulseB64: string): void {
    this.run(this.endpoint.onBytes(new Uint8Array(Buffer.from(pulseB64, 'base64')), this.host.now()));
  }

  /** Periodic tick (heartbeat + liveness). */
  tick(): void {
    this.run(this.endpoint.onTick(this.host.now()));
  }

  private run(effects: Effect[]): void {
    for (const e of effects) {
      switch (e.t) {
        case 'transmit':
          this.host.sendPulseFrame(b64(e.bytes));
          break;
        case 'deliver':
          // The delivered payload is the JSON {blob, keys} string.
          this.host.onDelivered(dec.decode(e.payload));
          break;
        case 'reset-inbound':
          logger.warn({ fromSeq: String(e.fromSeq) }, 'pulse reset-inbound (relay stream reset)');
          break;
        // acked/store/unstore/open/close: nothing for the tentacle to do here
        // (not durable-supported; link lifecycle driven explicitly).
      }
    }
  }
}
