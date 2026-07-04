/**
 * Real-world failure catalog — every row of spec/PROTOCOL.md §9, as an
 * executable contract. Each `describe` names a real situation a phone/laptop
 * link actually experiences; each `it` asserts the guaranteed behavior.
 *
 * Written BEFORE the implementation, against the Endpoint contract. The core
 * exists to make these green. Everything runs under a virtual clock via the
 * World harness — no real sockets, no real time.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Endpoint } from '../endpoint.js';
import { DEFAULT_PARAMS, type Effect } from '../types.js';
import { decodeFrame } from '../wire.js';
import {
  freshEpoch,
  marker,
  payloadsOf,
  seqsOf,
  World,
} from './harness.js';

const A_EPOCH = 'node-A';
const B_EPOCH = 'phone-B';

function makeWorld(): World {
  // Fixed random ⇒ deterministic jitter. Distinct epochs per side.
  const random = () => 0.5;
  return new World(
    { epoch: A_EPOCH, random },
    { epoch: B_EPOCH, random },
  );
}

describe('CLEAN-DISCONNECT: graceful close then reopen loses nothing', () => {
  let w: World;
  beforeEach(() => {
    w = makeWorld();
    w.connect();
  });

  it('delivers everything sent before the drop, in order, exactly once', () => {
    w.sendA(marker(1));
    w.sendA(marker(2));
    expect(payloadsOf(w.deliveredB)).toEqual([1, 2]);

    w.disconnect();
    w.sendA(marker(3)); // produced while down
    w.sendA(marker(4));
    expect(payloadsOf(w.deliveredB)).toEqual([1, 2]); // nothing new while down

    w.reopen();
    // resume handshake pulls 3,4 exactly once, in order
    expect(payloadsOf(w.deliveredB)).toEqual([1, 2, 3, 4]);
    expect(seqsOf(w.deliveredB)).toEqual([1n, 2n, 3n, 4n]);
  });

  it('drains the outbox once the peer acknowledges the resent messages', () => {
    w.sendA(marker(1));
    w.disconnect();
    w.sendA(marker(2));
    expect(w.a.outboxSize).toBeGreaterThan(0);
    w.reopen();
    w.advance(DEFAULT_PARAMS.heartbeatIntervalMs + 1); // let acks settle
    expect(w.a.outboxSize).toBe(0);
  });
});

describe('PRODUCE-WHILE-DOWN: sending on a dead link never drops the payload', () => {
  it('queues offline sends and flushes them on resume', () => {
    const w = makeWorld();
    w.connect();
    w.disconnect();
    for (let i = 1; i <= 5; i++) w.sendA(marker(i));
    expect(payloadsOf(w.deliveredB)).toEqual([]);
    w.reopen();
    expect(payloadsOf(w.deliveredB)).toEqual([1, 2, 3, 4, 5]);
  });

  it('assigns contiguous seqs to offline-produced messages', () => {
    const w = makeWorld();
    w.connect();
    const s1 = w.sendA(marker(1));
    w.disconnect();
    const s2 = w.sendA(marker(2));
    const s3 = w.sendA(marker(3));
    expect([s1, s2, s3]).toEqual([1n, 2n, 3n]);
  });
});

describe('OFFLINE-CATCHUP: a long-offline consumer pulls the whole backlog', () => {
  it('catches up in order regardless of backlog size', () => {
    const w = makeWorld();
    w.connect();
    w.disconnect();
    for (let i = 1; i <= 100; i++) w.sendA(marker(i));
    w.reopen();
    expect(w.deliveredB.length).toBe(100);
    expect(seqsOf(w.deliveredB)).toEqual(
      Array.from({ length: 100 }, (_, i) => BigInt(i + 1)),
    );
  });
});

describe('ABRUPT-KILL: a frame lost at the moment the socket dies is resent', () => {
  it('recovers the in-flight message on the next connection', () => {
    const w = makeWorld();
    w.connect();
    w.sendA(marker(1));
    // message 2 is dropped exactly as the link dies (fail-stop mid-send)
    w.dropNext('AtoB', 1);
    w.sendA(marker(2));
    w.disconnect();
    expect(payloadsOf(w.deliveredB)).toEqual([1]); // 2 was lost on the wire
    w.reopen();
    expect(payloadsOf(w.deliveredB)).toEqual([1, 2]); // resent on resume
  });
});

describe('TAIL-LOSS: last messages lost, then the producer goes idle', () => {
  it('recovers the tail via idle heartbeat cursors within one window', () => {
    const w = makeWorld();
    w.connect();
    w.sendA(marker(1));
    // 2 and 3 are silently lost on the wire; producer then stops sending
    w.dropNext('AtoB', 2);
    w.sendA(marker(2));
    w.sendA(marker(3));
    expect(payloadsOf(w.deliveredB)).toEqual([1]);

    // No new sends. Only the passage of time + heartbeats can heal this.
    w.advance(DEFAULT_PARAMS.heartbeatIntervalMs + 1);
    expect(payloadsOf(w.deliveredB)).toEqual([1, 2, 3]);
  });
});

describe('DUPLICATE: a resent frame never double-delivers to the app', () => {
  it('drops seq <= recvCursor and delivers each payload once', () => {
    const w = makeWorld();
    w.connect();
    w.duplicateNext('AtoB', 3); // next 3 frames arrive twice
    w.sendA(marker(1));
    w.sendA(marker(2));
    w.sendA(marker(3));
    expect(payloadsOf(w.deliveredB)).toEqual([1, 2, 3]);
    expect(seqsOf(w.deliveredB)).toEqual([1n, 2n, 3n]);
  });
});

describe('REORDER: out-of-order arrival never delivers out of order', () => {
  it('holds a gap and only delivers contiguously', () => {
    const w = makeWorld();
    w.connect();
    w.beginReorder();
    w.sendA(marker(1));
    w.sendA(marker(2));
    w.sendA(marker(3));
    w.flushReordered(); // released in reverse: 3,2,1
    // Whatever the arrival order, the app sees a contiguous in-order prefix.
    const seqs = seqsOf(w.deliveredB);
    for (let i = 0; i < seqs.length; i++) expect(seqs[i]).toBe(BigInt(i + 1));
    // and it self-heals to all three
    w.advance(DEFAULT_PARAMS.heartbeatIntervalMs + 1);
    expect(payloadsOf(w.deliveredB)).toEqual([1, 2, 3]);
  });
});

describe('HALF-OPEN: a black-holed link is detected and reconnected', () => {
  it('trips the receive-timeout and asks to close within deadAfterMs', () => {
    const w = makeWorld();
    w.connect();
    w.sendA(marker(1));
    expect(payloadsOf(w.deliveredB)).toEqual([1]);

    w.blackhole(); // silent: no disconnect event, bytes vanish both ways
    // Before the dead threshold: still believes connected.
    w.advance(DEFAULT_PARAMS.deadAfterMs - 1);
    expect(w.a.link).toBe('connected');
    // Cross the threshold: liveness fires close ⇒ harness disconnects.
    w.advance(2);
    expect(w.a.link).toBe('disconnected');
  });

  it('fully recovers once the path comes back', () => {
    const w = makeWorld();
    w.connect();
    w.blackhole();
    w.advance(DEFAULT_PARAMS.deadAfterMs + 1); // detect + tear down
    w.sendA(marker(1)); // produced during the outage
    w.reopen();
    expect(payloadsOf(w.deliveredB)).toEqual([1]);
  });
});

describe('RECONNECT policy: backoff with full jitter, no cap, reconnects forever', () => {
  it('does not give up after many consecutive failures', () => {
    const w = makeWorld();
    w.connect();
    w.disconnect();
    // Simulate many failed dials by advancing a long time without reopening.
    w.advance(10 * 60_000);
    // The endpoint must still be trying (a deadline is scheduled), not wedged.
    expect(w.a.nextDeadline()).not.toBeNull();
    // When the link finally returns, it recovers.
    w.sendA(marker(1));
    w.reopen();
    expect(payloadsOf(w.deliveredB)).toEqual([1]);
  });

  it('schedules the first retry within the base ceiling (jitter in [0, base])', () => {
    const w = makeWorld();
    w.connect();
    const t0 = w.now;
    w.disconnect();
    const deadline = w.a.nextDeadline();
    expect(deadline).not.toBeNull();
    expect(deadline! - t0).toBeGreaterThanOrEqual(0);
    expect(deadline! - t0).toBeLessThanOrEqual(DEFAULT_PARAMS.reconnectBaseMs);
  });
});

describe('TOO-OLD: resuming past the producer’s pruned base is surfaced, not hidden', () => {
  it('emits reset-inbound with the oldest available seq', () => {
    // A produces 5, B receives all 5 and acks; A prunes. Then B is wiped
    // (fresh epoch, cursor 0) and reconnects trying to resume from scratch —
    // but from A's side everything <= 5 is pruned, so 1..5 are gone for a
    // consumer that thinks it has nothing. We model "B lost its history".
    const random = () => 0.5;
    const w = new World({ epoch: A_EPOCH, random }, { epoch: B_EPOCH, random });
    w.connect();
    for (let i = 1; i <= 5; i++) w.sendA(marker(i));
    w.advance(DEFAULT_PARAMS.heartbeatIntervalMs + 1); // B acks, A prunes
    expect(w.a.outboxSize).toBe(0);

    w.disconnect();
    // B restarts with amnesia: brand-new endpoint, cursor 0, new epoch.
    const wiped = new World(
      { epoch: A_EPOCH, random, restore: w.a.snapshot() },
      { epoch: freshEpoch('B-reborn'), random },
    );
    wiped.connect();
    // A can't serve 1..5 (pruned) to a consumer claiming cursor 0 ⇒ RESET.
    expect(wiped.resetsB.length).toBe(1);
    expect(wiped.resetsB[0]!.fromSeq).toBe(6n); // oldest available = base+1
  });
});

describe('RESTART-DURABLE: reload outbox + epoch, resume across a restart', () => {
  it('resends unacked messages after the producer process restarts', () => {
    const random = () => 0.5;
    const w = new World({ epoch: A_EPOCH, random }, { epoch: B_EPOCH, random });
    w.connect();
    w.sendA(marker(1));
    w.disconnect();
    w.sendA(marker(2)); // unacked, sits in outbox
    const snap = w.a.snapshot();

    // A "restarts": new Endpoint restored from the snapshot, same epoch.
    const w2 = new World(
      { epoch: A_EPOCH, random, restore: snap },
      { epoch: B_EPOCH, random, restore: w.b.snapshot() },
    );
    w2.connect();
    expect(payloadsOf(w2.deliveredB)).toEqual([2]); // 2 survived the restart
  });
});

describe('WEDGE-FREE: repeated churn always converges to drained + connected', () => {
  it('survives interleaved disconnects, sends, and blackholes', () => {
    const w = makeWorld();
    w.connect();
    let expected = 0;
    for (let round = 0; round < 8; round++) {
      w.sendA(marker(++expected));
      if (round % 2 === 0) {
        w.disconnect();
        w.sendA(marker(++expected));
        w.reopen();
      } else {
        w.blackhole();
        w.advance(DEFAULT_PARAMS.deadAfterMs + 1);
        w.sendA(marker(++expected));
        w.reopen();
      }
      w.advance(DEFAULT_PARAMS.heartbeatIntervalMs + 1);
    }
    // Every produced marker eventually delivered, in order, exactly once.
    expect(payloadsOf(w.deliveredB)).toEqual(
      Array.from({ length: expected }, (_, i) => i + 1),
    );
    expect(w.a.outboxSize).toBe(0);
  });
});

describe('BIDIRECTIONAL: both directions are independent and symmetric', () => {
  it('A→B and B→A each keep their own seq space and cursor', () => {
    const w = makeWorld();
    w.connect();
    w.sendA(marker(10));
    w.sendB(marker(20));
    w.sendB(marker(21));
    expect(payloadsOf(w.deliveredB)).toEqual([10]);
    expect(payloadsOf(w.deliveredA)).toEqual([20, 21]);
    // independent seq spaces both start at 1
    expect(seqsOf(w.deliveredB)).toEqual([1n]);
    expect(seqsOf(w.deliveredA)).toEqual([1n, 2n]);
  });

  it('recovers both directions across a shared disconnect', () => {
    const w = makeWorld();
    w.connect();
    w.disconnect();
    w.sendA(marker(1));
    w.sendB(marker(2));
    w.reopen();
    expect(payloadsOf(w.deliveredB)).toEqual([1]);
    expect(payloadsOf(w.deliveredA)).toEqual([2]);
  });
});

describe('ACKED: the sender observes confirmed delivery of what it sent', () => {
  it('fires acked once the peer confirms receipt', () => {
    const w = makeWorld();
    w.connect();
    // Before any round trip, nothing is confirmed.
    expect(w.ackedA).toEqual([]);
    w.sendA(marker(1));
    w.sendA(marker(2));
    // B delivered them; its piggybacked cursor must come back to A to confirm.
    // A heartbeat carries B's cursor back within one interval.
    w.advance(DEFAULT_PARAMS.heartbeatIntervalMs + 1);
    // A now knows the peer received through seq 2.
    expect(w.ackedA.at(-1)).toBe(2n);
    // And its outbox is drained (acked == pruned).
    expect(w.a.outboxSize).toBe(0);
  });

  it('does NOT fire acked while the message is undelivered (socket down)', () => {
    const w = makeWorld();
    w.connect();
    w.disconnect();
    w.sendA(marker(1)); // produced offline, sits in outbox
    w.advance(DEFAULT_PARAMS.heartbeatIntervalMs + 1);
    // Nothing confirmed — the app must keep showing "sending"/optimistic and be
    // ready to roll back on its own timeout.
    expect(w.ackedA).toEqual([]);
    expect(w.a.outboxSize).toBe(1);
    // On reconnect the confirmation finally arrives.
    w.reopen();
    w.advance(DEFAULT_PARAMS.heartbeatIntervalMs + 1);
    expect(w.ackedA.at(-1)).toBe(1n);
  });

  it('advances the acked floor monotonically, once per new confirmation', () => {
    const w = makeWorld();
    w.connect();
    w.sendA(marker(1));
    w.advance(DEFAULT_PARAMS.heartbeatIntervalMs + 1);
    const afterFirst = w.ackedA.at(-1);
    expect(afterFirst).toBe(1n);
    w.sendA(marker(2));
    w.sendA(marker(3));
    w.advance(DEFAULT_PARAMS.heartbeatIntervalMs + 1);
    expect(w.ackedA.at(-1)).toBe(3n);
    // Every reported floor is strictly increasing (no duplicate/backward acks).
    for (let i = 1; i < w.ackedA.length; i++) {
      expect(w.ackedA[i]! > w.ackedA[i - 1]!).toBe(true);
    }
  });

  it('a resent message (lost ack) confirms exactly once, no double-ack', () => {
    // A duplicate arriving at the receiver (because our earlier ack was lost)
    // must trigger a re-ACK so the sender learns delivery and stops resending —
    // and the sender must observe the confirmation exactly once. Driven at the
    // Endpoint level to isolate the property from harness clock mechanics.
    const A = new Endpoint({ epoch: 'A', random: () => 0.5 });
    const B = new Endpoint({ epoch: 'B', random: () => 0.5 });
    let t = 0;
    const ackedA: bigint[] = [];
    const deliveredB: number[] = [];
    function pump(effects: Effect[], from: 'A' | 'B', dropBHeartbeat = false): void {
      for (const e of effects) {
        if (e.t === 'acked' && from === 'A') ackedA.push(e.seqUpTo);
        if (e.t === 'deliver' && from === 'B') deliveredB.push(e.payload[0] ?? -1);
        if (e.t === 'transmit') {
          const fr = decodeFrame(e.bytes);
          if (dropBHeartbeat && from === 'B' && fr?.t === 'heartbeat') continue;
          if (from === 'A') pump(B.onBytes(e.bytes, t), 'B');
          else pump(A.onBytes(e.bytes, t), 'A');
        }
      }
    }
    pump(A.onConnected(t), 'A');
    pump(B.onConnected(t), 'B');
    pump(A.send(marker(1)).effects, 'A');
    expect(deliveredB).toEqual([1]); // delivered once, live

    // B's first cursor-carrying heartbeat is lost.
    t = 15_000;
    pump(A.onTick(t), 'A');
    pump(B.onTick(t), 'B', /* dropBHeartbeat */ true);
    expect(ackedA).toEqual([]); // not yet confirmed — app keeps optimistic state

    // Next heartbeat gets through: confirmation arrives, exactly once.
    t = 30_000;
    pump(A.onTick(t), 'A');
    pump(B.onTick(t), 'B');
    expect(deliveredB).toEqual([1]); // still delivered exactly once
    expect(ackedA.at(-1)).toBe(1n);
    expect(ackedA.filter((s) => s === 1n).length).toBe(1);
  });
});

