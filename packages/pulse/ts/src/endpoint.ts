/**
 * Endpoint — the sans-I/O core state machine. See spec/PROTOCOL.md §2–§7.
 *
 * Symmetric and full-duplex: every endpoint is simultaneously producer and
 * consumer. Performs NO I/O — inputs in, {@link Effect}s out. Deterministic
 * given the same inputs, clock ticks, and injected `random`.
 */

import {
  DEFAULT_PARAMS,
  type Effect,
  type EndpointOptions,
  LinkState,
  type Payload,
  type PulseParams,
  type Seq,
  type Snapshot,
} from './types.js';
import { decodeFrame, encodeFrame, type Frame } from './wire.js';

interface OutboxEntry {
  seq: Seq;
  payload: Payload;
}

const b64encode = (u: Uint8Array): string => Buffer.from(u).toString('base64');
const b64decode = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

export class Endpoint {
  private readonly params: PulseParams;
  private readonly random: () => number;

  private epoch: string;
  private sendSeq: Seq = 0n;
  private outbox: OutboxEntry[] = [];
  private outboxBase: Seq = 0n; // (lowest retained seq) - 1

  private recvCursor: Seq = 0n;
  private peerEpoch = '';

  private state: LinkState = LinkState.Disconnected;
  private lastRecvAt = 0;
  private lastSendAt = 0;
  private reconnectAt: number | null = null;
  private attempt = 0;

  constructor(opts: EndpointOptions) {
    this.params = { ...DEFAULT_PARAMS, ...(opts.params ?? {}) };
    this.random = opts.random ?? Math.random;
    this.epoch = opts.epoch;
    if (opts.restore) this.loadSnapshot(opts.restore);
  }

  // ── Inputs ──────────────────────────────────────────────────────────────

  send(payload: Payload): { seq: Seq; effects: Effect[] } {
    this.sendSeq += 1n;
    const seq = this.sendSeq;
    // Outbox entry created BEFORE any transmit (spec §3 ordering rule): the
    // payload is resendable before it is ever entrusted to the wire.
    this.outbox.push({ seq, payload });
    const effects: Effect[] = [];
    if (this.state === LinkState.Connected) {
      effects.push(this.transmit({ t: 'data', seq, ack: this.recvCursor, payload }));
    }
    return { seq, effects };
  }

  onConnected(now: number): Effect[] {
    this.state = LinkState.Connected;
    this.attempt = 0;
    this.reconnectAt = null;
    this.lastRecvAt = now; // give the fresh link a full dead-window grace
    const effects: Effect[] = [];
    effects.push(
      this.transmit(
        { t: 'hello', epoch: this.epoch, recvEpoch: this.peerEpoch, recvCursor: this.recvCursor },
        now,
      ),
    );
    return effects;
  }

  onDisconnected(now: number): Effect[] {
    this.state = LinkState.Disconnected;
    this.attempt += 1;
    this.reconnectAt = now + this.backoffDelay(this.attempt);
    return [];
  }

  onBytes(bytes: Uint8Array, now: number): Effect[] {
    const frame = decodeFrame(bytes);
    if (frame === null) return []; // malformed ⇒ ignore (spec §5.0)
    this.lastRecvAt = now;
    switch (frame.t) {
      case 'hello':
        return this.onHello(frame, now);
      case 'data':
        return this.onData(frame, now);
      case 'ack':
        // An explicit ACK is a consumer signaling its cursor (often a hole).
        // Prune what it has, then resend anything it is missing.
        return this.onPeerCursor(frame.ack, now);
      case 'reset':
        return this.onReset(frame);
      case 'heartbeat':
        // An idle heartbeat reveals the consumer's cursor; if it lags our
        // sendSeq (tail-loss), resend the gap. This is what heals a tail lost
        // right before the producer went quiet.
        return this.onPeerCursor(frame.ack, now);
    }
  }

  onTick(now: number): Effect[] {
    const effects: Effect[] = [];
    if (this.state === LinkState.Connected) {
      if (now - this.lastSendAt >= this.params.heartbeatIntervalMs) {
        effects.push(this.transmit({ t: 'heartbeat', ack: this.recvCursor }, now));
      }
      if (now - this.lastRecvAt >= this.params.deadAfterMs) {
        effects.push({ t: 'close' });
      }
    } else if (this.reconnectAt !== null && now >= this.reconnectAt) {
      this.reconnectAt = null;
      effects.push({ t: 'open' });
    }
    return effects;
  }

  // ── Frame handlers ────────────────────────────────────────────────────────

  private onHello(
    f: Extract<Frame, { t: 'hello' }>,
    now: number,
  ): Effect[] {
    const effects: Effect[] = [];
    this.peerEpoch = f.epoch;

    // (a) Peer resuming against an epoch we no longer have (we cold-started).
    if (f.recvEpoch !== '' && f.recvEpoch !== this.epoch) {
      effects.push(
        this.transmit({ t: 'reset', epoch: this.epoch, oldest: this.outboxBase + 1n }, now),
      );
      this.resendFrom(this.outboxBase + 1n, effects, now);
      return effects;
    }

    // (b) Prune what the peer already has, then resend the rest.
    if (f.recvCursor >= this.outboxBase) {
      this.pruneOutbox(f.recvCursor);
      this.resendFrom(f.recvCursor + 1n, effects, now);
    } else {
      // Peer is behind our oldest retained seq — we pruned what it needs.
      effects.push(
        this.transmit({ t: 'reset', epoch: this.epoch, oldest: this.outboxBase + 1n }, now),
      );
      this.resendFrom(this.outboxBase + 1n, effects, now);
    }
    return effects;
  }

  private onData(f: Extract<Frame, { t: 'data' }>, now: number): Effect[] {
    this.pruneOutbox(f.ack); // peer piggybacks its receipt of our outbound
    const effects: Effect[] = [];
    if (f.seq === this.recvCursor + 1n) {
      this.recvCursor = f.seq;
      effects.push({ t: 'deliver', seq: f.seq, payload: f.payload });
    } else if (f.seq <= this.recvCursor) {
      // duplicate (resend overlap) — safe to drop, never re-deliver
    } else {
      // hole: seq > recvCursor+1. Do not deliver; ask peer to rewind.
      effects.push(this.transmit({ t: 'ack', ack: this.recvCursor }, now));
    }
    return effects;
  }

  /**
   * A peer advertised its receive cursor (via explicit ACK or idle HEARTBEAT).
   * Prune what it confirms, and if it is behind our latest send, resend the gap
   * so tail-loss and holes self-heal without a reconnect.
   */
  private onPeerCursor(peerCursor: Seq, now: number): Effect[] {
    this.pruneOutbox(peerCursor);
    const effects: Effect[] = [];
    if (peerCursor < this.sendSeq) {
      this.resendFrom(peerCursor + 1n, effects, now);
    }
    return effects;
  }

  private onReset(f: Extract<Frame, { t: 'reset' }>): Effect[] {
    this.peerEpoch = f.epoch;
    if (f.oldest > this.recvCursor + 1n) {
      // Unavoidable gap: (recvCursor+1 .. oldest-1) are gone forever.
      this.recvCursor = f.oldest - 1n;
      return [{ t: 'reset-inbound', fromSeq: f.oldest, peerEpoch: f.epoch }];
    }
    // else: no gap; peer will resend from recvCursor+1 as usual.
    return [];
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private resendFrom(fromSeq: Seq, effects: Effect[], now: number): void {
    for (const e of this.outbox) {
      if (e.seq >= fromSeq) {
        effects.push(
          this.transmit({ t: 'data', seq: e.seq, ack: this.recvCursor, payload: e.payload }, now),
        );
      }
    }
  }

  private pruneOutbox(ackSeq: Seq): void {
    if (ackSeq <= this.outboxBase) return;
    this.outbox = this.outbox.filter((e) => e.seq > ackSeq);
    if (ackSeq > this.outboxBase) this.outboxBase = ackSeq;
  }

  /** Build a transmit effect and mark send activity. `now` optional for the
   *  data-send path where lastSendAt is refreshed by the caller context. */
  private transmit(frame: Frame, now?: number): Effect {
    if (now !== undefined) this.lastSendAt = now;
    return { t: 'transmit', bytes: encodeFrame(frame) };
  }

  private backoffDelay(attempt: number): number {
    const ceil = Math.min(
      this.params.reconnectMaxMs,
      this.params.reconnectBaseMs * this.params.reconnectFactor ** (attempt - 1),
    );
    return Math.floor(this.random() * (ceil + 1)); // full jitter: uniform [0, ceil]
  }

  // ── Observation ────────────────────────────────────────────────────────────

  nextDeadline(): number | null {
    if (this.state === LinkState.Connected) {
      // Earliest of: next heartbeat due, next dead-check due.
      return Math.min(
        this.lastSendAt + this.params.heartbeatIntervalMs,
        this.lastRecvAt + this.params.deadAfterMs,
      );
    }
    return this.reconnectAt;
  }

  get link(): LinkState {
    return this.state;
  }
  get sendSeqValue(): Seq {
    return this.sendSeq;
  }
  get recvCursorValue(): Seq {
    return this.recvCursor;
  }
  get outboxSize(): number {
    return this.outbox.length;
  }

  snapshot(): Snapshot {
    return {
      epoch: this.epoch,
      sendSeq: this.sendSeq.toString(),
      outboxBase: this.outboxBase.toString(),
      outbox: this.outbox.map((e) => ({ seq: e.seq.toString(), payloadB64: b64encode(e.payload) })),
      recvCursor: this.recvCursor.toString(),
      peerEpoch: this.peerEpoch,
    };
  }

  private loadSnapshot(s: Snapshot): void {
    this.epoch = s.epoch;
    this.sendSeq = BigInt(s.sendSeq);
    this.outboxBase = BigInt(s.outboxBase);
    this.outbox = s.outbox.map((e) => ({ seq: BigInt(e.seq), payload: b64decode(e.payloadB64) }));
    this.recvCursor = BigInt(s.recvCursor);
    this.peerEpoch = s.peerEpoch;
  }
}
