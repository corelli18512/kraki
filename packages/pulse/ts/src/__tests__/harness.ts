/**
 * Test harness: a deterministic two-endpoint world with a programmable faulty
 * channel and a virtual clock. No real sockets, no real time — so every
 * real-world failure in spec §9 is reproducible and fast.
 *
 * The harness models the LINK the way TCP/TLS/WebSocket actually behaves:
 * ordered and fail-stop while connected (spec §1). "Drop", "reorder",
 * "duplicate" here are deliberately ADVERSARIAL — they inject conditions the
 * live link normally prevents, so we can prove the endpoint's resume/dedup
 * logic is defensive even if the transport misbehaves.
 */

import { Endpoint } from '../endpoint.js';
import type { Effect, EndpointOptions } from '../types.js';

export type Dir = 'AtoB' | 'BtoA';

/** A frame in flight, tagged with direction and the sender's identity. */
interface InFlight {
  dir: Dir;
  bytes: Uint8Array;
}

/**
 * Drives two endpoints and the channel between them under one virtual clock.
 *
 * The channel is "connected" or not per direction pair; when connected, bytes
 * flow subject to the installed faults. Faults are opt-in and explicit.
 */
export class World {
  now = 0;
  readonly a: Endpoint;
  readonly b: Endpoint;

  /** Payloads delivered to the application at each side, in delivery order. */
  readonly deliveredA: Array<{ seq: bigint; payload: Uint8Array }> = [];
  readonly deliveredB: Array<{ seq: bigint; payload: Uint8Array }> = [];
  /** reset-inbound effects observed at each side. */
  readonly resetsA: Array<{ fromSeq: bigint; peerEpoch: string }> = [];
  readonly resetsB: Array<{ fromSeq: bigint; peerEpoch: string }> = [];

  private linkUp = false;
  /** Whether a dial would currently succeed. Distinct from linkUp (currently
   *  connected): after a disconnect/blackhole the path is unavailable until the
   *  test calls reopen(), so auto-dials fail and reschedule. */
  private linkAvailable = false;
  // Fault programming:
  private dropCount: Record<Dir, number> = { AtoB: 0, BtoA: 0 };
  private dropPredicate: ((dir: Dir, bytes: Uint8Array) => boolean) | null = null;
  private dupCount: Record<Dir, number> = { AtoB: 0, BtoA: 0 };
  private blackholed = false;
  private reorderBuffer: InFlight[] | null = null;

  constructor(aOpts: EndpointOptions, bOpts: EndpointOptions) {
    this.a = new Endpoint(aOpts);
    this.b = new Endpoint(bOpts);
  }

  // ── Deterministic random source usable by endpoints (0.5 unless overridden)

  // ── Clock ──────────────────────────────────────────────────────────────

  /** Advance virtual time by `ms`, ticking both endpoints at each of their
   *  requested deadlines (and at the final instant). */
  advance(ms: number): void {
    const target = this.now + ms;
    // Loop: repeatedly jump to the earliest requested deadline within window.
    for (;;) {
      const da = this.a.nextDeadline();
      const db = this.b.nextDeadline();
      const next = Math.min(
        da ?? Number.POSITIVE_INFINITY,
        db ?? Number.POSITIVE_INFINITY,
      );
      if (next === Number.POSITIVE_INFINITY || next > target) break;
      if (next > this.now) this.now = next;
      this.pump(this.a.onTick(this.now), 'AtoB');
      this.pump(this.b.onTick(this.now), 'BtoA');
    }
    this.now = target;
    this.pump(this.a.onTick(this.now), 'AtoB');
    this.pump(this.b.onTick(this.now), 'BtoA');
  }

  // ── Link control ─────────────────────────────────────────────────────────

  connect(): void {
    this.linkUp = true;
    this.linkAvailable = true;
    this.blackholed = false;
    this.pump(this.a.onConnected(this.now), 'AtoB');
    this.pump(this.b.onConnected(this.now), 'BtoA');
  }

  /** Graceful disconnect: both sides get onDisconnected. */
  disconnect(): void {
    this.linkUp = false;
    this.linkAvailable = false;
    this.pump(this.a.onDisconnected(this.now), 'AtoB');
    this.pump(this.b.onDisconnected(this.now), 'BtoA');
  }

  /** Half-open: the wire silently black-holes; NO onDisconnected fires.
   *  The endpoints still believe they are connected until liveness trips. */
  blackhole(): void {
    this.blackholed = true;
    this.linkAvailable = false;
  }

  /** Reconnect after the endpoints have (independently) decided to reopen.
   *  Mirrors an adapter acting on an `open` effect. */
  reopen(): void {
    this.connect();
  }

  // ── Application send ───────────────────────────────────────────────────────

  sendA(payload: Uint8Array): bigint {
    const { seq, effects } = this.a.send(payload);
    this.pump(effects, 'AtoB');
    return seq;
  }
  sendB(payload: Uint8Array): bigint {
    const { seq, effects } = this.b.send(payload);
    this.pump(effects, 'BtoA');
    return seq;
  }

  // ── Fault programming ──────────────────────────────────────────────────────

  dropNext(dir: Dir, n: number): void {
    this.dropCount[dir] += n;
  }
  dropMatching(pred: (dir: Dir, bytes: Uint8Array) => boolean): void {
    this.dropPredicate = pred;
  }
  clearDropMatching(): void {
    this.dropPredicate = null;
  }
  duplicateNext(dir: Dir, n: number): void {
    this.dupCount[dir] += n;
  }

  /** Begin buffering all frames instead of delivering; released, reversed,
   *  by {@link flushReordered}. Simulates adversarial reordering. */
  beginReorder(): void {
    this.reorderBuffer = [];
  }
  flushReordered(): void {
    const buf = this.reorderBuffer ?? [];
    this.reorderBuffer = null;
    // deliver in REVERSE order to maximally stress ordering logic
    for (let i = buf.length - 1; i >= 0; i--) {
      const f = buf[i]!;
      this.deliver(f);
    }
  }

  // ── Internal plumbing ──────────────────────────────────────────────────────

  /** Carry out a batch of effects from the endpoint identified by outbound dir. */
  private pump(effects: Effect[], dir: Dir): void {
    for (const e of effects) this.applyEffect(e, dir);
  }

  private applyEffect(e: Effect, dir: Dir): void {
    // `dir` is the OUTBOUND direction of the endpoint that produced this effect
    // (A ⇒ 'AtoB', B ⇒ 'BtoA'). `transmit` crosses to the other side; `deliver`
    // and `reset-inbound` belong to the PRODUCING side's own application.
    const producedByA = dir === 'AtoB';
    switch (e.t) {
      case 'transmit':
        this.enqueue({ dir, bytes: e.bytes });
        break;
      case 'deliver':
        (producedByA ? this.deliveredA : this.deliveredB).push({
          seq: e.seq,
          payload: e.payload,
        });
        break;
      case 'reset-inbound':
        (producedByA ? this.resetsA : this.resetsB).push({
          fromSeq: e.fromSeq,
          peerEpoch: e.peerEpoch,
        });
        break;
      case 'open':
        // Endpoint asked to dial. If the test has since made the link
        // available, connect(); otherwise model a FAILED dial by feeding
        // onDisconnected back, which reschedules the next retry — proving the
        // endpoint keeps trying and never wedges.
        if (this.linkAvailable) {
          this.connect();
        } else {
          this.pump(
            producedByA ? this.a.onDisconnected(this.now) : this.b.onDisconnected(this.now),
            dir,
          );
        }
        break;
      case 'close':
        // Endpoint declared its link dead (e.g. liveness). Model the socket
        // teardown: that side (and, for a real duplex socket, the other) get
        // onDisconnected. We only disconnect if we currently believe up.
        if (this.linkUp || this.blackholed) this.disconnect();
        break;
    }
  }

  private enqueue(f: InFlight): void {
    if (this.reorderBuffer) {
      this.reorderBuffer.push(f);
      return;
    }
    this.deliver(f);
  }

  private deliver(f: InFlight): void {
    // Link down or black-holed ⇒ bytes vanish (fail-stop / silent).
    if (!this.linkUp || this.blackholed) return;

    // Drop-by-predicate:
    if (this.dropPredicate && this.dropPredicate(f.dir, f.bytes)) return;
    // Drop-next-N:
    if (this.dropCount[f.dir] > 0) {
      this.dropCount[f.dir] -= 1;
      return;
    }

    this.route(f);

    // Duplicate-next-N: deliver a second copy.
    if (this.dupCount[f.dir] > 0) {
      this.dupCount[f.dir] -= 1;
      this.route(f);
    }
  }

  private route(f: InFlight): void {
    if (f.dir === 'AtoB') {
      this.pump(this.b.onBytes(f.bytes, this.now), 'BtoA');
    } else {
      this.pump(this.a.onBytes(f.bytes, this.now), 'AtoB');
    }
  }
}

// ── Small helpers for tests ──────────────────────────────────────────────────

let epochCounter = 0;
/** Deterministic unique epoch per call (tests need distinct cold-start epochs). */
export function freshEpoch(prefix = 'ep'): string {
  epochCounter += 1;
  return `${prefix}-${epochCounter}`;
}

export function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

/** Payloads as ascending byte markers, for identity assertions. */
export function marker(n: number): Uint8Array {
  return new Uint8Array([n & 0xff]);
}

export function payloadsOf(
  delivered: Array<{ seq: bigint; payload: Uint8Array }>,
): number[] {
  return delivered.map((d) => d.payload[0] ?? -1);
}

export function seqsOf(
  delivered: Array<{ seq: bigint; payload: Uint8Array }>,
): bigint[] {
  return delivered.map((d) => d.seq);
}
