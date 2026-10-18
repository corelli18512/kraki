import { decodeFrame, type Effect, Endpoint, StreamSet } from '@kraki/pulse';
import type { InnerMessage } from '@kraki/protocol';
import { createLogger } from './logger';
import { traceEvent } from './trace';

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
  /** A reliable payload was delivered in order — the JSON string {blob, keys}.
   * Missing stream metadata on legacy frames means live stream 0. */
  onDelivered(payloadJson: string, streamId?: number): void;
  /** The relay confirmed receipt of every send with seq ≤ seqUpTo. */
  onAcked(seqUpTo: bigint): void;
  /** The relay restarted the inbound stream: partial payloads are gone. */
  onResetInbound?(): void;
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
  private streams: StreamSet;
  /** The live endpoint (stream 0) — the one this arm SENDS on. Arm-originated
   *  traffic (input, approvals, aborts, card pulls) is always live; only the
   *  tentacle produces bulk (trace/range/attachment responses). */
  private live: Endpoint;
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
  /** Live seqs whose command belongs to the current connection only (Stop).
   *  If still unacked at disconnect they are purged, never retransmitted
   *  after reconnect where they would hit a successor turn. Mirrors the
   *  native PulseManager.connectionScopedLiveSeqs. */
  private connectionScopedSeqs = new Set<bigint>();
  private connected = false;

  constructor(
    private readonly host: ArmPulseHost,
    epoch: string,
  ) {
    this.live = new Endpoint({ epoch: `${epoch}:live`, durable: { supported: false }, streamId: 0 });
    const bulk = new Endpoint({ epoch: `${epoch}:bulk`, durable: { supported: false }, streamId: 1 });
    this.streams = new StreamSet([this.live, bulk]);
  }

  /** Send a reliable message (a JSON string {blob, keys}, or plaintext control
   *  JSON for HEAD_PULSE_TARGET) toward `targetDeviceId`. `durable` marks it for
   *  relay persistence while the target is offline. Returns the assigned pulse
   *  seq so the caller can track it for rollback.
   *
   *  `connectionScoped` commands are refused (null) while disconnected and
   *  purged if unacked when this connection drops. */
  send(payloadJson: string, targetDeviceId: string, durable: boolean): bigint;
  send(payloadJson: string, targetDeviceId: string, durable: boolean, opts: { connectionScoped?: boolean }): bigint | null;
  send(payloadJson: string, targetDeviceId: string, durable: boolean, opts?: { connectionScoped?: boolean }): bigint | null {
    const scoped = opts?.connectionScoped === true && !durable;
    if (scoped && !this.connected) {
      traceEvent({ comp: 'arm', evt: 'PULSE-SCOPED-REFUSED', target: targetDeviceId });
      return null;
    }
    const payload = enc.encode(payloadJson);
    const { seq, effects } = this.live.send(payload, { durable });
    this.targetBySeq.set(seq, targetDeviceId);
    if (scoped) this.connectionScopedSeqs.add(seq);
    traceEvent({ comp: 'arm', evt: 'PULSE-SEND', seq: String(seq), len: payload.length, target: targetDeviceId, durable });
    this.run(effects);
    return seq;
  }

  onConnected(): void {
    traceEvent({ comp: 'arm', evt: 'PULSE-CONNECTED' });
    this.connected = true;
    this.run(this.streams.onConnected(this.host.now()));
  }
  onDisconnected(): void {
    traceEvent({ comp: 'arm', evt: 'PULSE-DISCONNECTED' });
    this.connected = false;
    this.streams.onDisconnected(this.host.now());
    if (this.connectionScopedSeqs.size > 0) {
      const scoped = this.connectionScopedSeqs;
      const purged = this.live.purge((e) => scoped.has(e.seq), 'connection-scoped-disconnect');
      this.run(purged.effects);
      // Anything not in the outbox any more was already acked.
      this.connectionScopedSeqs.clear();
    }
  }

  /** Test/diagnostic: unacked connection-scoped commands. */
  get connectionScopedCount(): number {
    return this.connectionScopedSeqs.size;
  }
  onFrame(pulseB64: string): void {
    const bytes = unb64(pulseB64);
    const frame = decodeFrame(bytes);
    traceEvent({ comp: 'arm', evt: 'PULSE-RX', seq: frame?.t === 'data' ? String(frame.seq) : '0', len: bytes.length, kind: frame?.t ?? '?' });
    this.run(this.streams.onBytes(bytes, this.host.now()));
  }
  tick(): void {
    this.run(this.streams.onTick(this.host.now()));
  }

  private run(effects: Effect[]): void {
    for (const e of effects) {
      switch (e.t) {
        case 'transmit': {
          const frame = decodeFrame(e.bytes);
          const target = frame?.t === 'data' ? (this.targetBySeq.get(frame.seq) ?? '') : '';
          traceEvent({ comp: 'arm', evt: 'PULSE-TX', seq: frame?.t === 'data' ? String(frame.seq) : '0', len: e.bytes.length, kind: frame?.t ?? '?', target });
          this.host.sendPulseFrame(b64(e.bytes), target);
          break;
        }
        case 'deliver':
          traceEvent({ comp: 'arm', evt: 'PULSE-DELIVER', seq: String(e.seq), len: e.payload.length });
          this.host.onDelivered(dec.decode(e.payload), e.streamId ?? 0);
          break;
        case 'acked':
          traceEvent({ comp: 'arm', evt: 'PULSE-ACKED', seq: String(e.seqUpTo) });
          for (const s of this.targetBySeq.keys()) {
            if (s <= e.seqUpTo) this.targetBySeq.delete(s);
          }
          for (const s of this.connectionScopedSeqs) {
            if (s <= e.seqUpTo) this.connectionScopedSeqs.delete(s);
          }
          this.host.onAcked(e.seqUpTo);
          break;
        case 'purged':
          traceEvent({ comp: 'arm', evt: 'PULSE-PURGED', seq: e.droppedSeqs.map(String).join(','), reason: e.reason });
          for (const s of e.droppedSeqs) {
            this.targetBySeq.delete(s);
            this.connectionScopedSeqs.delete(s);
          }
          break;
        case 'reset-inbound':
          traceEvent({ comp: 'arm', evt: 'PULSE-RESET-INBOUND', seq: String(e.fromSeq) });
          logger.warn('pulse reset-inbound (relay stream reset)', { from: String(e.fromSeq) });
          this.host.onResetInbound?.();
          break;
      }
    }
  }
}

export type { InnerMessage };
