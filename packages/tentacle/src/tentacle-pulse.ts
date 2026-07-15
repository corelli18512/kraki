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

import { decodeFrame, decodeFrameWithStream, type Effect, Endpoint, StreamSet } from '@coinfra/pulse';
import { createLogger } from './logger.js';

const logger = createLogger('pulse');
const tracer = createLogger('pulse-trace');

/** Trace is OFF by default. Set env `KRAKI_TRACE_PULSE=1` before daemon start
 *  to enable it (writes ~/.kraki/logs/pulse-trace.log). Left always-on it
 *  emits 4-8 pino info lines per pulse frame, which — under an agent's
 *  streaming delta storm (100+ frames/s) — grows the log to hundreds of MB
 *  per hour and the resulting sync fsync blocks the daemon event loop for
 *  seconds at a time, tripping the relay-client stale-check and knocking
 *  arms offline. */
const TRACE_ENABLED = process.env.KRAKI_TRACE_PULSE === '1';

/** Trace event schema: one JSONL line per pulse boundary crossing at the
 *  tentacle. Match across processes by (comp, evt, seq, len). ns is
 *  monotonic-clock nanoseconds since process start. No-op unless
 *  KRAKI_TRACE_PULSE=1 (see TRACE_ENABLED comment). */
function trace(evt: string, seq: bigint | number, len: number, extra: Record<string, unknown> = {}): void {
  if (!TRACE_ENABLED) return;
  tracer.info({
    ns: process.hrtime.bigint().toString(),
    comp: 'tentacle',
    evt,
    seq: String(seq),
    len,
    ...extra,
  });
}

/** Cheap payload fingerprint so we can correlate the same encrypted blob
 *  across arm→head→tentacle hops (encrypted bytes are receiver-specific but
 *  a plaintext {blob, keys} JSON is byte-identical between head and tentacle). */
function fp(u: Uint8Array): string {
  let h = 0;
  for (let i = 0; i < Math.min(64, u.length); i++) h = ((h << 5) - h + u[i]) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface TentaclePulseHost {
  /** Send a pulse frame to the relay. When `targetDeviceId` is set, the frame
   *  rides a unicast envelope so head forwards it to exactly that one app;
   *  otherwise a broadcast envelope so head fans it out to all the user's apps. */
  sendPulseFrame(pulseB64: string, targetDeviceId?: string): void;
  /** A reliable payload was delivered in order — the JSON string carrying
   *  {blob, keys} for the normal decrypt+dispatch path. */
  onDelivered(payloadJson: string): void;
  now(): number;
}

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Classify a producer message type into a Pulse stream (spec §13).
 *  Bulk = best-effort background / large (history replay, trace batches,
 *  attachment chunks). Everything else is live. Splitting bulk off the live
 *  stream is what stops a reconnect-time burst from head-of-line blocking
 *  echo / abort / status-card updates on the same downlink. */
export function streamForType(type: string | undefined): number {
  switch (type) {
    case 'session_messages_range_batch':
    case 'turn_trace_batch':
    case 'attachment_data':
      return 1; // STREAM_BULK
    default:
      return 0; // STREAM_LIVE
  }
}

export class TentaclePulse {
  private streams: StreamSet;
  /** Target app for the frame currently being emitted (per send). Empty ⇒ the
   *  frame fans out to all apps (broadcast); set ⇒ unicast to one app. */
  private currentTarget = '';

  constructor(
    private readonly host: TentaclePulseHost,
    epoch: string,
  ) {
    // Two independent streams on the single relay WebSocket (spec §13): live
    // (control + real-time) gets its own seq space so it is never queued
    // behind bulk (history replay, trace batches, attachment chunks). Each
    // stream gets its own epoch so a RESET/burst on bulk cannot disturb live.
    const base = epoch;
    this.streams = new StreamSet([
      new Endpoint({ epoch: `${base}:live`, durable: { supported: false }, streamId: 0 }),
      new Endpoint({ epoch: `${base}:bulk`, durable: { supported: false }, streamId: 1 }),
    ]);
  }

  /** Send a reliable message (a JSON string carrying {blob, keys}) via pulse on
   *  stream `stream` (0=live, 1=bulk). `targetDeviceId` addresses one app
   *  (unicast); omit it to fan out to all apps (broadcast). `durable` marks it
   *  for head persistence while the target app is offline (default false —
   *  sync snapshots self-heal on reconnect). */
  send(payloadJson: string, targetDeviceId = '', durable = false, coalesceKey?: string, stream = 0): void {
    const payload = enc.encode(payloadJson);
    this.currentTarget = targetDeviceId;
    const { seq, effects } = this.streams.send(stream, payload, { durable, coalesceKey });
    trace('SEND', seq, payload.length, { fp: fp(payload), to: targetDeviceId || '(broadcast)', durable, coalesceKey, stream });
    this.run(effects);
    this.currentTarget = '';
  }

  /** The relay connection is up — resume every stream. */
  onConnected(): void {
    trace('CONNECTED', 0, 0);
    this.run(this.streams.onConnected(this.host.now()));
  }

  /** The relay connection dropped. */
  onDisconnected(): void {
    trace('DISCONNECTED', 0, 0);
    this.streams.onDisconnected(this.host.now());
  }

  /** An inbound pulse frame arrived from the relay — demux by streamId. */
  onFrame(pulseB64: string): void {
    const bytes = new Uint8Array(Buffer.from(pulseB64, 'base64'));
    const d = decodeFrameWithStream(bytes);
    if (d) {
      trace('RX', d.frame.t === 'data' ? d.frame.seq : 0, bytes.length, { kind: d.frame.t, stream: d.streamId });
    } else {
      trace('RX', 0, bytes.length, { kind: '?' });
    }
    this.run(this.streams.onBytes(bytes, this.host.now()));
  }

  /** Periodic tick for every stream (heartbeat + liveness). */
  tick(): void {
    this.run(this.streams.onTick(this.host.now()));
  }

  private run(effects: Effect[]): void {
    for (const e of effects) {
      switch (e.t) {
        case 'transmit': {
          const frame = decodeFrame(e.bytes);
          trace('TX', frame?.t === 'data' ? frame.seq : 0, e.bytes.length, { kind: frame?.t ?? '?', to: this.currentTarget || '(broadcast)' });
          this.host.sendPulseFrame(b64(e.bytes), this.currentTarget || undefined);
          break;
        }
        case 'deliver':
          trace('DELIVER', e.seq, e.payload.length, { fp: fp(e.payload) });
          // The delivered payload is the JSON {blob, keys} string.
          this.host.onDelivered(dec.decode(e.payload));
          break;
        case 'reset-inbound':
          trace('RESET-INBOUND', e.fromSeq, 0, { peerEpoch: e.peerEpoch });
          logger.warn({ fromSeq: String(e.fromSeq) }, 'pulse reset-inbound (relay stream reset)');
          break;
        // acked/store/unstore/open/close: nothing for the tentacle to do here
        // (not durable-supported; link lifecycle driven explicitly).
      }
    }
  }
}
