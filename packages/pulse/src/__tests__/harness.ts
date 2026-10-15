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
  /** Monotonic send order, for deterministic tie-breaking on equal arrival. */
  order: number;
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
  readonly deliveredA: Array<{ seq: bigint; payload: Uint8Array; coalesceKey?: string }> = [];
  readonly deliveredB: Array<{ seq: bigint; payload: Uint8Array; coalesceKey?: string }> = [];
  /** reset-inbound effects observed at each side. */
  readonly resetsA: Array<{ fromSeq: bigint; peerEpoch: string }> = [];
  readonly resetsB: Array<{ fromSeq: bigint; peerEpoch: string }> = [];
  /** Highest acked seq observed at each side (the delivery-confirmation floor
   *  for messages that side SENT). Last value = latest. */
  readonly ackedA: bigint[] = [];
  readonly ackedB: bigint[] = [];
  /** `purged` effects (send-time coalescing / host GC) observed at each side. */
  readonly purgedA: Array<{ droppedSeqs: bigint[]; reason: string }> = [];
  readonly purgedB: Array<{ droppedSeqs: bigint[]; reason: string }> = [];
  /** Durable store effects observed at each side: entries the adapter would
   *  persist. Keyed by seq → payload byte marker. unstore removes ≤ seqUpTo. */
  readonly storeA = new Map<bigint, number>();
  readonly storeB = new Map<bigint, number>();

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
  /** When true, the underlying path is healthy: an endpoint's own `open`
   *  (auto-reconnect) succeeds, and a liveness `close` becomes a transient
   *  disconnect the endpoint recovers from by itself. Used to model "the
   *  network is now good; let pulse converge" without the test manually
   *  re-dialing after every internal teardown. */
  private healing = false;
  /** One-way propagation delay in virtual ms. 0 ⇒ synchronous delivery (the
   *  default; keeps existing scenarios' timing exact). */
  private latencyMs = 0;
  /** Deterministic per-frame jitter added on top of latencyMs: frame k is
   *  delayed by latencyMs + (k % (jitterMs+1)). 0 ⇒ no jitter. */
  private jitterMs = 0;
  private frameCounter = 0;
  /** Frames propagating through the wire, ascending by arrival time. */
  private inFlight: Array<{ f: InFlight; arriveAt: number }> = [];

  constructor(aOpts: EndpointOptions, bOpts: EndpointOptions) {
    this.a = new Endpoint(aOpts);
    this.b = new Endpoint(bOpts);
  }

  // ── Deterministic random source usable by endpoints (0.5 unless overridden)

  // ── Clock ──────────────────────────────────────────────────────────────

  /** Advance virtual time by `ms`, ticking both endpoints at each of their
   *  requested deadlines AND delivering in-flight frames at their arrival
   *  time (and at the final instant). */
  advance(ms: number): void {
    const target = this.now + ms;
    // Loop: repeatedly jump to the earliest pending event (a timer deadline or
    // an in-flight frame arrival) within the window.
    for (;;) {
      const da = this.a.nextDeadline();
      const db = this.b.nextDeadline();
      const dw = this.earliestArrival();
      const next = Math.min(
        da ?? Number.POSITIVE_INFINITY,
        db ?? Number.POSITIVE_INFINITY,
        dw ?? Number.POSITIVE_INFINITY,
      );
      if (next === Number.POSITIVE_INFINITY || next > target) break;
      if (next > this.now) this.now = next;
      this.deliverArrivalsUpTo(this.now);
      this.pump(this.a.onTick(this.now), 'AtoB');
      this.pump(this.b.onTick(this.now), 'BtoA');
    }
    this.now = target;
    this.deliverArrivalsUpTo(this.now);
    this.pump(this.a.onTick(this.now), 'AtoB');
    this.pump(this.b.onTick(this.now), 'BtoA');
  }

  private earliestArrival(): number | null {
    let min: number | null = null;
    for (const e of this.inFlight) {
      if (min === null || e.arriveAt < min) min = e.arriveAt;
    }
    return min;
  }

  /** Deliver every in-flight frame whose arrival time has come. Frames whose
   *  link died mid-flight are dropped (fail-stop): a real socket loses bytes
   *  still in its buffer when it closes. */
  private deliverArrivalsUpTo(t: number): void {
    if (this.inFlight.length === 0) return;
    // Ascending by arrival, then by send order (frameCounter) for determinism.
    const ready = this.inFlight
      .filter((e) => e.arriveAt <= t)
      .sort((x, y) => x.arriveAt - y.arriveAt || x.f.order - y.f.order);
    this.inFlight = this.inFlight.filter((e) => e.arriveAt > t);
    for (const e of ready) this.route(e.f);
  }

  // ── Link control ─────────────────────────────────────────────────────────

  connect(): void {
    this.linkUp = true;
    this.linkAvailable = true;
    this.blackholed = false;
    this.pump(this.a.onConnected(this.now), 'AtoB');
    this.pump(this.b.onConnected(this.now), 'BtoA');
  }

  /** Graceful disconnect: both sides get onDisconnected. Frames still in
   *  flight are lost (fail-stop: a closing socket drops buffered bytes). */
  disconnect(): void {
    this.linkUp = false;
    if (!this.healing) this.linkAvailable = false;
    this.inFlight = [];
    this.pump(this.a.onDisconnected(this.now), 'AtoB');
    this.pump(this.b.onDisconnected(this.now), 'BtoA');
  }

  /** Put the world into a healthy state and let the endpoints reconnect and
   *  converge on their own: the path is available, so each endpoint's own
   *  `open` (auto-reconnect) succeeds, and any liveness teardown self-heals.
   *  Models "the network is now good" — the settle phase of a fault program. */
  heal(): void {
    this.healing = true;
    this.blackholed = false;
    this.linkAvailable = true;
    this.latencyMs = 0;
    this.jitterMs = 0;
    this.dropCount = { AtoB: 0, BtoA: 0 };
    this.dropPredicate = null;
    this.dupCount = { AtoB: 0, BtoA: 0 };
    // If the link was blackholed, the endpoints still THINK they're connected
    // but no traffic flows; force a clean reconnect so liveness + resume run.
    if (this.linkUp) this.disconnect();
    this.connect();
  }

  /** Half-open: the wire silently black-holes; NO onDisconnected fires.
   *  The endpoints still believe they are connected until liveness trips.
   *  In-flight bytes vanish (the black hole eats them). */
  blackhole(): void {
    this.blackholed = true;
    this.linkAvailable = false;
    this.inFlight = [];
  }

  /** Reconnect after the endpoints have (independently) decided to reopen.
   *  Mirrors an adapter acting on an `open` effect. */
  reopen(): void {
    this.connect();
  }

  // ── Application send ───────────────────────────────────────────────────────

  sendA(payload: Uint8Array, opts?: { durable?: boolean; coalesceKey?: string }): bigint {
    const { seq, effects } = this.a.send(payload, opts);
    this.pump(effects, 'AtoB');
    return seq;
  }
  sendB(payload: Uint8Array, opts?: { durable?: boolean; coalesceKey?: string }): bigint {
    const { seq, effects } = this.b.send(payload, opts);
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

  /** Set one-way propagation delay (virtual ms) for all subsequent frames.
   *  Frames already in flight keep their scheduled arrival. */
  latency(ms: number): void {
    this.latencyMs = ms;
  }
  /** Add deterministic per-frame jitter on top of latency: frame k gets an
   *  extra `k % (ms+1)` delay, so consecutive frames spread out (and can even
   *  cross — exercising the endpoint's in-order guarantee under real jitter). */
  jitter(ms: number): void {
    this.jitterMs = ms;
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
  pump(effects: Effect[], dir: Dir): void {
    for (const e of effects) this.applyEffect(e, dir);
  }

  private applyEffect(e: Effect, dir: Dir): void {
    // `dir` is the OUTBOUND direction of the endpoint that produced this effect
    // (A ⇒ 'AtoB', B ⇒ 'BtoA'). `transmit` crosses to the other side; `deliver`
    // and `reset-inbound` belong to the PRODUCING side's own application.
    const producedByA = dir === 'AtoB';
    switch (e.t) {
      case 'transmit':
        this.enqueue({ dir, bytes: e.bytes, order: ++this.frameCounter });
        break;
      case 'deliver':
        (producedByA ? this.deliveredA : this.deliveredB).push({
          seq: e.seq,
          payload: e.payload,
          coalesceKey: e.coalesceKey,
        });
        break;
      case 'reset-inbound':
        (producedByA ? this.resetsA : this.resetsB).push({
          fromSeq: e.fromSeq,
          peerEpoch: e.peerEpoch,
        });
        break;
      case 'acked':
        (producedByA ? this.ackedA : this.ackedB).push(e.seqUpTo);
        break;
      case 'store': {
        // Model the adapter persisting (seq → payload) to disk.
        const store = producedByA ? this.storeA : this.storeB;
        store.set(e.seq, e.payload[0] ?? -1);
        break;
      }
      case 'unstore': {
        // Delete durable entries with seq ≤ seqUpTo.
        const store = producedByA ? this.storeA : this.storeB;
        for (const seq of [...store.keys()]) {
          if (seq <= e.seqUpTo) store.delete(seq);
        }
        break;
      }
      case 'purged':
        (producedByA ? this.purgedA : this.purgedB).push({
          droppedSeqs: e.droppedSeqs,
          reason: e.reason,
        });
        break;
      case 'open':
        // Endpoint asked to dial. The two endpoints share one link, so a dial
        // from either side brings it up for both — but only once (idempotent):
        // a second open while already up is a no-op, not a re-connect that would
        // reset the peer's liveness state.
        if (this.linkUp) break;
        if (this.linkAvailable) {
          this.connect();
        } else {
          // Model a FAILED dial by feeding onDisconnected back, which reschedules
          // the next retry — proving the endpoint keeps trying and never wedges.
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

    this.propagate(f);

    // Duplicate-next-N: a second copy enters the wire (same latency path).
    if (this.dupCount[f.dir] > 0) {
      this.dupCount[f.dir] -= 1;
      this.propagate({ ...f, order: ++this.frameCounter });
    }
  }

  /** Put a frame onto the wire. With zero latency it arrives synchronously
   *  (preserving existing scenarios' exact timing); with latency/jitter it
   *  becomes an in-flight frame delivered later by the clock. */
  private propagate(f: InFlight): void {
    if (this.latencyMs === 0 && this.jitterMs === 0) {
      this.route(f);
      return;
    }
    const extra = this.jitterMs === 0 ? 0 : f.order % (this.jitterMs + 1);
    this.inFlight.push({ f, arriveAt: this.now + this.latencyMs + extra });
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

export function payloadsOf(delivered: Array<{ seq: bigint; payload: Uint8Array }>): number[] {
  return delivered.map((d) => d.payload[0] ?? -1);
}

export function seqsOf(delivered: Array<{ seq: bigint; payload: Uint8Array }>): bigint[] {
  return delivered.map((d) => d.seq);
}
