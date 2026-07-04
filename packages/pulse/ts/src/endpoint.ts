/**
 * Endpoint — the sans-I/O core state machine. See spec/PROTOCOL.md §2–§7.
 *
 * Symmetric and full-duplex: every endpoint is simultaneously producer and
 * consumer. Performs NO I/O — inputs in, {@link Effect}s out. Deterministic
 * given the same inputs, clock ticks, and injected `random`.
 */

import {
  DEFAULT_PARAMS,
  type DurableConfig,
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
  /** Sent with durable:true — persist across restart (only if we support it). */
  durable: boolean;
  /** When first assigned a send time, for retention expiry (ms). */
  sentAt: number;
}

// Isomorphic base64 for snapshot payloads (runs in Node AND the browser). The
// core must not depend on Buffer — a browser caller imports this too.
function b64encode(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  // btoa in the browser; Buffer fallback only if btoa is absent (old Node).
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(u).toString('base64');
}
function b64decode(s: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export class Endpoint {
  private readonly params: PulseParams;
  private readonly random: () => number;

  private epoch: string;
  private sendSeq: Seq = 0n;
  private outbox: OutboxEntry[] = [];
  private outboxBase: Seq = 0n; // (lowest retained seq) - 1

  private recvCursor: Seq = 0n;
  private peerEpoch = '';

  /** My durability capability (advertised in my HELLO). */
  private readonly durable: DurableConfig;
  /** Whether the peer advertised it can persist (learned from its HELLO). */
  private peerDurableSupported = false;

  private state: LinkState = LinkState.Disconnected;
  private lastRecvAt = 0;
  private lastSendAt = 0;
  private reconnectAt: number | null = null;
  private attempt = 0;
  /** Last-known clock (ms), updated on every timed input. Used to stamp sentAt
   *  on send() which has no `now` of its own. */
  private clock = 0;

  constructor(opts: EndpointOptions) {
    this.params = { ...DEFAULT_PARAMS, ...(opts.params ?? {}) };
    this.random = opts.random ?? Math.random;
    this.epoch = opts.epoch;
    this.durable = opts.durable ?? { supported: false };
    if (opts.restore) this.loadSnapshot(opts.restore);
  }

  // ── Inputs ──────────────────────────────────────────────────────────────

  send(payload: Payload, opts?: { durable?: boolean }): { seq: Seq; effects: Effect[] } {
    this.sendSeq += 1n;
    const seq = this.sendSeq;
    // A message is durable only if the app asked AND we can persist. If the app
    // asked but we can't, it degrades to a normal in-memory entry (spec §8.1).
    const durable = opts?.durable === true && this.durable.supported;
    // Outbox entry created BEFORE any transmit (spec §3 ordering rule): the
    // payload is resendable before it is ever entrusted to the wire.
    this.outbox.push({ seq, payload, durable, sentAt: this.clock });
    const effects: Effect[] = [];
    // Persist to durable storage immediately (before transmit), so it survives a
    // restart even if the socket is down right now. Only seq+bytes — no target.
    if (durable) effects.push({ t: 'store', seq, payload });
    if (this.state === LinkState.Connected) {
      // The DATA durable bit is set only if the PEER can persist it; otherwise
      // it's pointless on the wire. (Our own `durable` above governs OUR outbox
      // persistence; this bit tells the peer to persist on ITS side if it's the
      // one that will hold the message onward — e.g. a store-and-forward node.)
      const wireDurable = opts?.durable === true && this.peerDurableSupported;
      effects.push(this.transmit({ t: 'data', seq, ack: this.recvCursor, payload, durable: wireDurable }));
    }
    return { seq, effects };
  }

  onConnected(now: number): Effect[] {
    this.clock = now;
    this.state = LinkState.Connected;
    this.attempt = 0;
    this.reconnectAt = null;
    this.lastRecvAt = now; // give the fresh link a full dead-window grace
    const effects: Effect[] = [];
    effects.push(
      this.transmit(
        {
          t: 'hello',
          epoch: this.epoch,
          recvEpoch: this.peerEpoch,
          recvCursor: this.recvCursor,
          durableSupported: this.durable.supported,
          maxRetentionMs: BigInt(this.durable.maxRetentionMs ?? 0),
        },
        now,
      ),
    );
    return effects;
  }

  onDisconnected(now: number): Effect[] {
    this.clock = now;
    this.state = LinkState.Disconnected;
    this.attempt += 1;
    this.reconnectAt = now + this.backoffDelay(this.attempt);
    return [];
  }

  onBytes(bytes: Uint8Array, now: number): Effect[] {
    this.clock = now;
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
    this.clock = now;
    const effects: Effect[] = [];
    // Expire durable outbox entries older than our retention window: drop them
    // and tell the adapter to delete them from disk. They will never be resent.
    this.expireDurable(now, effects);
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

  /** Drop durable outbox entries past the retention window; emit unstore for
   *  each so the adapter clears disk. Only runs when we have a finite retention
   *  and are the durable-supported side. */
  private expireDurable(now: number, effects: Effect[]): void {
    const ttl = this.durable.maxRetentionMs ?? 0;
    if (!this.durable.supported || ttl <= 0) return;
    const expired = this.outbox.filter((e) => e.durable && now - e.sentAt >= ttl);
    if (expired.length === 0) return;
    // Remove expired entries. unstore floor = highest expired seq that is also
    // contiguous from outboxBase is not required; we emit a precise unstore per
    // the highest expired seq (adapter deletes ≤ that among durable ids it holds).
    const expiredSeqs = new Set(expired.map((e) => e.seq));
    this.outbox = this.outbox.filter((e) => !expiredSeqs.has(e.seq));
    const highest = expired.reduce((m, e) => (e.seq > m ? e.seq : m), 0n);
    effects.push({ t: 'unstore', seqUpTo: highest });
  }

  // ── Frame handlers ────────────────────────────────────────────────────────

  private onHello(
    f: Extract<Frame, { t: 'hello' }>,
    now: number,
  ): Effect[] {
    const effects: Effect[] = [];
    this.peerEpoch = f.epoch;
    // Learn whether the peer can persist — governs the wire durable bit we set.
    this.peerDurableSupported = f.durableSupported;

    // (a) Peer resuming against an epoch we no longer have (we cold-started).
    if (f.recvEpoch !== '' && f.recvEpoch !== this.epoch) {
      effects.push(
        this.transmit({ t: 'reset', epoch: this.epoch, oldest: this.outboxBase + 1n }, now),
      );
      this.resendFrom(this.outboxBase + 1n, effects, now);
      return effects;
    }

    // (b) Prune what the peer already has, then resend the rest — announcing any
    // gap at the head of our outbox (e.g. a non-durable entry lost in a restart).
    if (f.recvCursor >= this.outboxBase) {
      this.pruneOutbox(f.recvCursor, effects);
      this.resendWithGapAnnounce(f.recvCursor + 1n, effects, now);
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
    const effects: Effect[] = [];
    this.pruneOutbox(f.ack, effects); // peer piggybacks its receipt of our outbound
    if (f.seq === this.recvCursor + 1n) {
      this.recvCursor = f.seq;
      effects.push({ t: 'deliver', seq: f.seq, payload: f.payload, durable: f.durable });
    } else if (f.seq <= this.recvCursor) {
      // Duplicate (a resend because our earlier ack was lost). Re-advertise our
      // cursor so the sender learns we already have it and stops resending —
      // without this, a lost ack can wedge the sender resending forever and it
      // never observes delivery. (Same rationale as TCP's dup-ACK.)
      effects.push(this.transmit({ t: 'ack', ack: this.recvCursor }, now));
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
    const effects: Effect[] = [];
    this.pruneOutbox(peerCursor, effects);
    if (peerCursor < this.sendSeq) {
      this.resendWithGapAnnounce(peerCursor + 1n, effects, now);
    }
    return effects;
  }

  /** Resend outbox entries from `fromSeq`, but first announce (via RESET) any
   *  gap at the head: if our oldest retained seq is beyond `fromSeq`, we can
   *  never fill `fromSeq..oldest-1` (they were discarded — e.g. a non-durable
   *  entry lost in a restart). Without the RESET the peer treats the resend as a
   *  hole, re-ACKs, and we livelock resending forever. */
  private resendWithGapAnnounce(fromSeq: Seq, effects: Effect[], now: number): void {
    const oldest = this.oldestRetainedSeq();
    if (oldest !== null && oldest > fromSeq) {
      effects.push(this.transmit({ t: 'reset', epoch: this.epoch, oldest }, now));
    }
    this.resendFrom(fromSeq, effects, now);
  }

  /** Lowest seq still held in the outbox, or null if empty. */
  private oldestRetainedSeq(): Seq | null {
    let min: Seq | null = null;
    for (const e of this.outbox) {
      if (min === null || e.seq < min) min = e.seq;
    }
    return min;
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
        // Preserve durable intent on resend: the wire bit reflects whether the
        // peer can persist, matching the original send.
        const wireDurable = e.durable && this.peerDurableSupported;
        effects.push(
          this.transmit(
            { t: 'data', seq: e.seq, ack: this.recvCursor, payload: e.payload, durable: wireDurable },
            now,
          ),
        );
      }
    }
  }

  private pruneOutbox(ackSeq: Seq, effects?: Effect[]): void {
    if (ackSeq <= this.outboxBase) return;
    // Any durable entries being pruned are now confirmed delivered — tell the
    // adapter it may delete them from disk.
    const hadDurable = this.outbox.some((e) => e.seq <= ackSeq && e.durable);
    this.outbox = this.outbox.filter((e) => e.seq > ackSeq);
    this.outboxBase = ackSeq;
    // Surface the confirmed delivery floor so the app can resolve/roll back
    // optimistic UI for messages it sent. Observational only.
    effects?.push({ t: 'acked', seqUpTo: ackSeq });
    if (hadDurable) effects?.push({ t: 'unstore', seqUpTo: ackSeq });
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
      outbox: this.outbox.map((e) => ({
        seq: e.seq.toString(),
        payloadB64: b64encode(e.payload),
        durable: e.durable,
        sentAt: e.sentAt,
      })),
      recvCursor: this.recvCursor.toString(),
      peerEpoch: this.peerEpoch,
    };
  }

  private loadSnapshot(s: Snapshot): void {
    this.epoch = s.epoch;
    this.sendSeq = BigInt(s.sendSeq);
    this.outboxBase = BigInt(s.outboxBase);
    this.outbox = s.outbox.map((e) => ({
      seq: BigInt(e.seq),
      payload: b64decode(e.payloadB64),
      durable: e.durable ?? false,
      sentAt: e.sentAt ?? 0,
    }));
    this.recvCursor = BigInt(s.recvCursor);
    this.peerEpoch = s.peerEpoch;
  }
}
