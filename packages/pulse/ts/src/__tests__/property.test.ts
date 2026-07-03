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
            fc.record({ op: fc.constant('advance' as const), ms: fc.integer({ min: 1, max: 5000 }) }),
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
