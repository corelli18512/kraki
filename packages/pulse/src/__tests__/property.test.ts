/**
 * Property-based fault testing — the "Jepsen-lite" for pulse.
 *
 * Instead of hand-picking failure scenarios, fast-check generates thousands of
 * RANDOM fault programs (interleavings of send / disconnect / reopen /
 * blackhole / drop / duplicate / latency / tick) and runs each through the
 * World harness. After each program we drive the link healthy and let time
 * pass, then assert the core invariants that must hold for ANY interleaving:
 *
 *   I1  no loss        — every payload the app sent is eventually delivered
 *   I2  in order       — delivered seqs are strictly ascending 1..N
 *   I3  exactly once    — no payload delivered twice
 *   I4  drained        — once settled, the outbox is empty (all acked)
 *   I5  wedge-free     — the endpoint returns to connected
 *
 * This catches the combinations a human enumeration misses.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS } from '../types.js';
import { marker, payloadsOf, seqsOf, World } from './harness.js';

/** One step of a random fault program. */
type Op =
  | { op: 'sendA' }
  | { op: 'sendB' }
  | { op: 'disconnect' }
  | { op: 'reopen' }
  | { op: 'blackhole' }
  | { op: 'dropA'; n: number }
  | { op: 'dropB'; n: number }
  | { op: 'dupA'; n: number }
  | { op: 'latency'; ms: number }
  | { op: 'advance'; ms: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.constant({ op: 'sendA' as const }),
  fc.constant({ op: 'sendA' as const }), // weight sends higher
  fc.constant({ op: 'sendB' as const }),
  fc.constant({ op: 'disconnect' as const }),
  fc.constant({ op: 'reopen' as const }),
  fc.constant({ op: 'blackhole' as const }),
  fc.record({ op: fc.constant('dropA' as const), n: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ op: fc.constant('dropB' as const), n: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ op: fc.constant('dupA' as const), n: fc.integer({ min: 1, max: 2 }) }),
  fc.record({ op: fc.constant('latency' as const), ms: fc.integer({ min: 0, max: 5000 }) }),
  fc.record({ op: fc.constant('advance' as const), ms: fc.integer({ min: 1, max: 40_000 }) }),
);

function runProgram(program: Op[]): {
  w: World;
  sentA: number[];
  sentB: number[];
} {
  const random = () => 0.5;
  const w = new World({ epoch: 'node-A', random }, { epoch: 'phone-B', random });
  w.connect();
  const sentA: number[] = [];
  const sentB: number[] = [];
  let markerA = 0;
  let markerB = 0;

  for (const step of program) {
    switch (step.op) {
      case 'sendA':
        markerA += 1;
        sentA.push(markerA);
        w.sendA(marker(markerA));
        break;
      case 'sendB':
        markerB += 1;
        sentB.push(markerB);
        w.sendB(marker(markerB));
        break;
      case 'disconnect':
        w.disconnect();
        break;
      case 'reopen':
        w.reopen();
        break;
      case 'blackhole':
        w.blackhole();
        break;
      case 'dropA':
        w.dropNext('AtoB', step.n);
        break;
      case 'dropB':
        w.dropNext('BtoA', step.n);
        break;
      case 'dupA':
        w.duplicateNext('AtoB', step.n);
        break;
      case 'latency':
        w.latency(step.ms);
        break;
      case 'advance':
        w.advance(step.ms);
        break;
    }
  }

  // ── Settle: heal the link and let the system converge on its own ──
  // heal() makes the path healthy: the endpoints' own auto-reconnect succeeds
  // and any liveness teardown self-heals. Advancing several heartbeat windows
  // lets every cursor exchange + resend chain complete.
  w.heal();
  for (let i = 0; i < 8; i++) {
    w.advance(DEFAULT_PARAMS.heartbeatIntervalMs + 1000);
  }

  return { w, sentA, sentB };
}

function assertInvariants(
  delivered: Array<{ seq: bigint; payload: Uint8Array }>,
  sent: number[],
  label: string,
): void {
  const seqs = seqsOf(delivered);
  const payloads = payloadsOf(delivered);

  // I2 in order + I3 exactly once: delivered seqs are exactly 1..k contiguous.
  for (let i = 0; i < seqs.length; i++) {
    expect(seqs[i], `${label}: seq at index ${i} not contiguous`).toBe(BigInt(i + 1));
  }
  // I1 no loss: everything sent was delivered (payloads are ascending markers).
  expect(payloads, `${label}: delivered payloads != sent`).toEqual(sent);
}

describe('property: any fault interleaving preserves the core invariants', () => {
  it('no loss / in order / exactly once / drained, over random programs', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), (program) => {
        const { w, sentA, sentB } = runProgram(program);

        // I1–I3 both directions
        assertInvariants(w.deliveredB, sentA, 'A→B');
        assertInvariants(w.deliveredA, sentB, 'B→A');

        // I4 drained: everything acked once settled.
        expect(w.a.outboxSize, 'A outbox not drained').toBe(0);
        expect(w.b.outboxSize, 'B outbox not drained').toBe(0);

        // I5 wedge-free: back to connected.
        expect(w.a.link, 'A not reconnected').toBe('connected');
        expect(w.b.link, 'B not reconnected').toBe('connected');
      }),
      { numRuns: 2000 },
    );
  });

  it('never delivers a payload twice, even with heavy duplication + reorder', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constant({ op: 'sendA' as const }),
            fc.record({ op: fc.constant('dupA' as const), n: fc.integer({ min: 1, max: 4 }) }),
            fc.record({
              op: fc.constant('advance' as const),
              ms: fc.integer({ min: 1, max: 5000 }),
            }),
          ),
          { minLength: 1, maxLength: 40 },
        ),
        (program) => {
          const { w, sentA } = runProgram(program as Op[]);
          const payloads = payloadsOf(w.deliveredB);
          // Exactly-once: no duplicates in the delivered stream.
          expect(new Set(payloads).size).toBe(payloads.length);
          // And still complete + ordered.
          assertInvariants(w.deliveredB, sentA, 'A→B dup-heavy');
        },
      ),
      { numRuns: 1000 },
    );
  });
});

// ── Durable property: every durable message survives, even across a restart ──

/** One step of a durable fault program. */
type DurOp =
  | { op: 'sendPlain' }
  | { op: 'sendDurable' }
  | { op: 'disconnect' }
  | { op: 'reopen' }
  | { op: 'restartA' }
  | { op: 'advance'; ms: number };

const durOpArb: fc.Arbitrary<DurOp> = fc.oneof(
  fc.constant({ op: 'sendPlain' as const }),
  fc.constant({ op: 'sendDurable' as const }),
  fc.constant({ op: 'sendDurable' as const }), // weight durable higher
  fc.constant({ op: 'disconnect' as const }),
  fc.constant({ op: 'reopen' as const }),
  fc.constant({ op: 'restartA' as const }),
  fc.record({ op: fc.constant('advance' as const), ms: fc.integer({ min: 1, max: 40_000 }) }),
);

describe('property: durable messages survive any interleaving incl. restarts', () => {
  it('every durable A→B message is eventually delivered exactly once; store drains', () => {
    fc.assert(
      fc.property(fc.array(durOpArb, { minLength: 1, maxLength: 50 }), (program) => {
        const random = () => 0.5;
        // A and B both durable-supported so the wire bit is honored and A stores.
        let w = new World(
          { epoch: 'A', random, durable: { supported: true } },
          { epoch: 'B', random, durable: { supported: true } },
        );
        w.connect();
        let markerN = 0;
        const durableMarkers: number[] = []; // markers sent with durable:true
        // Delivery history that PERSISTS across a restart of A (B is unaffected
        // by A restarting, so what B already delivered must not be forgotten).
        const deliveredHistory: Array<{ seq: bigint; marker: number }> = [];
        let deliveredCount = 0;
        const harvestDelivered = () => {
          // Append any new deliveries from the current World's B.
          for (let i = deliveredCount; i < w.deliveredB.length; i++) {
            const d = w.deliveredB[i]!;
            deliveredHistory.push({ seq: d.seq, marker: d.payload[0] ?? -1 });
          }
          deliveredCount = w.deliveredB.length;
        };
        // The adapter's durable disk for A — persists across a restart of A.
        const disk = new Map<bigint, number>();
        const syncDisk = () => {
          // Fold the World's storeA into our persistent disk view.
          for (const [seq, m] of w.storeA) disk.set(seq, m);
          // Honor unstores: anything not in storeA and ≤ current base is gone.
          for (const seq of [...disk.keys()]) if (!w.storeA.has(seq)) disk.delete(seq);
        };

        for (const step of program) {
          switch (step.op) {
            case 'sendPlain':
              markerN += 1;
              w.sendA(marker(markerN));
              break;
            case 'sendDurable':
              markerN += 1;
              durableMarkers.push(markerN);
              w.sendA(marker(markerN), { durable: true });
              break;
            case 'disconnect':
              w.disconnect();
              break;
            case 'reopen':
              w.reopen();
              break;
            case 'advance':
              w.advance(step.ms);
              break;
            case 'restartA': {
              // A restarts: rebuild from snapshot + persisted disk. Non-durable
              // in-flight entries are allowed to be lost; durable ones persist.
              harvestDelivered(); // preserve what old-B delivered
              syncDisk();
              const snap = w.a.snapshot();
              // Reconstruct A's outbox from the durable disk (what the adapter
              // would reload): keep only durable entries in the snapshot.
              const durableSnap = {
                ...snap,
                outbox: snap.outbox.filter((e) => e.durable),
              };
              const bSnap = w.b.snapshot();
              w = new World(
                { epoch: 'A', random, durable: { supported: true }, restore: durableSnap },
                { epoch: 'B', random, durable: { supported: true }, restore: bSnap },
              );
              deliveredCount = 0; // fresh World's deliveredB starts empty
              // Reseed the visible store from disk (adapter had it on disk).
              for (const [seq, m] of disk) w.storeA.set(seq, m);
              w.connect();
              break;
            }
          }
          syncDisk();
        }

        // Settle: heal + advance several heartbeat windows so everything drains.
        w.heal();
        for (let i = 0; i < 8; i++) w.advance(DEFAULT_PARAMS.heartbeatIntervalMs + 1000);
        harvestDelivered(); // fold in the final World's deliveries

        // INVARIANT: every durable marker was delivered to B, exactly once —
        // counting deliveries ACROSS restarts (B is unaffected by A restarting).
        const deliveredMarkers = deliveredHistory.map((d) => d.marker);
        const deliveredSet = new Set(deliveredMarkers);
        for (const m of durableMarkers) {
          expect(deliveredSet.has(m), `durable marker ${m} lost`).toBe(true);
        }
        // Exactly once: no durable marker delivered twice.
        for (const m of durableMarkers) {
          const count = deliveredMarkers.filter((x) => x === m).length;
          expect(count, `durable marker ${m} delivered ${count}×`).toBe(1);
        }
        // Store drains once everything is confirmed.
        expect(w.storeA.size, 'durable store not drained').toBe(0);
      }),
      { numRuns: 1500 },
    );
  });
});
