/**
 * Slow-network and periodic-cut scenarios — the timing-sensitive failures that
 * only appear on a real long-distance mobile link: high latency, jitter,
 * heartbeat racing the dead-timer, and a link that is repeatedly severed on a
 * fixed interval.
 *
 * IMPORTANT SCOPE NOTE. These exercise pulse's behavior *once bytes flow on a
 * (slow, flaky) link*. They are NOT a test of censorship/DPI resistance. A
 * firewall that blocks by TLS fingerprint or SNI acts BEFORE the first byte —
 * below the layer pulse lives at. The "periodic cut" case here models a link
 * that keeps getting reset (which pulse must survive by reconnecting); it does
 * not model, and must not be read as, defeating a content-inspecting blocker.
 * That is a transport-obfuscation concern outside this package.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS } from '../types.js';
import { marker, payloadsOf, seqsOf, World } from './harness.js';

function makeWorld(): World {
  const random = () => 0.5;
  return new World({ epoch: 'node-A', random }, { epoch: 'phone-B', random });
}

describe('SLOW-LINK: high one-way latency still delivers in order, exactly once', () => {
  it('delivers across a 2s one-way delay after the propagation time', () => {
    const w = makeWorld();
    w.latency(2000); // 2s each way — a bad intercontinental mobile path
    w.connect();
    w.sendA(marker(1));
    w.sendA(marker(2));
    // Nothing has arrived yet: still in flight.
    expect(payloadsOf(w.deliveredB)).toEqual([]);
    w.advance(1999);
    expect(payloadsOf(w.deliveredB)).toEqual([]);
    // Cross the propagation time ⇒ both arrive, in order.
    w.advance(2);
    expect(payloadsOf(w.deliveredB)).toEqual([1, 2]);
    expect(seqsOf(w.deliveredB)).toEqual([1n, 2n]);
  });

  it('drains the outbox once a delayed ack makes the round trip', () => {
    const w = makeWorld();
    w.latency(1000);
    w.connect();
    w.sendA(marker(1));
    w.sendA(marker(2));
    expect(w.a.outboxSize).toBe(2);
    // Acks are piggybacked, not immediate: B advertises its cursor on its next
    // idle HEARTBEAT (at t=15s), which then takes 1s to travel back to A. So
    // the outbox cannot drain until ~heartbeat + one-way latency.
    w.advance(DEFAULT_PARAMS.heartbeatIntervalMs + 1000 + 1);
    expect(w.a.outboxSize).toBe(0);
  });
});

describe('JITTER: per-frame delay variation never reorders app delivery', () => {
  it('holds and reassembles under jitter that spreads frames apart', () => {
    const w = makeWorld();
    w.latency(500);
    w.jitter(300); // frames spread by 0..300ms on top of 500ms base
    w.connect();
    for (let i = 1; i <= 6; i++) w.sendA(marker(i));
    w.advance(2000); // well past the worst-case arrival
    // The app must see a strictly in-order, exactly-once prefix.
    expect(payloadsOf(w.deliveredB)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seqsOf(w.deliveredB)).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
  });
});

describe('DEAD-TIMER RACE: RTT approaching deadAfterMs must not false-kill', () => {
  it('keeps a healthy-but-slow link alive when heartbeats still arrive', () => {
    // One-way latency 12s ⇒ round trip 24s, under the 30s dead threshold.
    // Heartbeats (every 15s idle) still cross in time, so liveness must hold.
    const w = makeWorld();
    w.latency(12_000);
    w.connect();
    // Run for a couple of minutes of pure idle: only heartbeats keep it alive.
    w.advance(120_000);
    expect(w.a.link).toBe('connected');
    expect(w.b.link).toBe('connected');
    // And it still delivers.
    w.sendA(marker(1));
    w.advance(12_001);
    expect(payloadsOf(w.deliveredB)).toEqual([1]);
  });

  it('DOES declare dead when one-way latency exceeds the dead threshold', () => {
    // Latency 31s > deadAfterMs 30s: no frame (not even a heartbeat) can arrive
    // in time, so the receive-timer MUST trip — this is correct, not a bug.
    const w = makeWorld();
    w.latency(31_000);
    w.connect();
    w.advance(DEFAULT_PARAMS.deadAfterMs + 1);
    expect(w.a.link).toBe('disconnected');
  });
});

describe('SLOW + LOSS: tail-loss recovery still works when the wire is slow', () => {
  it('heals a lost tail via heartbeat across a 1s delay', () => {
    const w = makeWorld();
    w.latency(1000);
    w.connect();
    w.sendA(marker(1));
    w.advance(2001); // 1 delivered + its ack returned
    w.dropNext('AtoB', 2);
    w.sendA(marker(2));
    w.sendA(marker(3));
    w.advance(1001); // the dropped frames never arrive
    expect(payloadsOf(w.deliveredB)).toEqual([1]);
    // Idle: only heartbeat cursor exchange (each way 1s) can heal it.
    w.advance(DEFAULT_PARAMS.heartbeatIntervalMs + 4000);
    expect(payloadsOf(w.deliveredB)).toEqual([1, 2, 3]);
  });
});

describe('PERIODIC-CUT: a link severed on a fixed interval always recovers', () => {
  // Models a path that keeps getting reset (e.g. an aggressive middlebox that
  // tears the connection every N seconds). This tests RECONNECT RESILIENCE —
  // NOT censorship circumvention (see the file header). The endpoint must keep
  // reconnecting and eventually deliver everything, exactly once, in order.
  it('delivers all messages despite being cut every ~20s for minutes', () => {
    const w = makeWorld();
    w.connect();
    let n = 0;
    for (let cycle = 0; cycle < 10; cycle++) {
      w.sendA(marker(++n));
      w.advance(5_000); // a little uptime
      w.disconnect(); // the middlebox resets the connection
      w.sendA(marker(++n)); // app keeps producing during the outage
      w.advance(15_000); // downtime before the path is usable again
      w.reopen(); // reconnect succeeds
      // Let resume + delivery settle, AND let a heartbeat cycle carry the final
      // ack back so the outbox can fully drain (piggybacked acks only).
      w.advance(DEFAULT_PARAMS.heartbeatIntervalMs + 2_000);
    }
    expect(payloadsOf(w.deliveredB)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    expect(seqsOf(w.deliveredB)).toEqual(Array.from({ length: n }, (_, i) => BigInt(i + 1)));
    expect(w.a.outboxSize).toBe(0);
  });

  it('survives a cut that lands WHILE a slow frame is still in flight', () => {
    const w = makeWorld();
    w.latency(3000);
    w.connect();
    w.sendA(marker(1)); // in flight, 3s from arriving
    w.advance(1000); // 1s in — frame still on the wire
    w.disconnect(); // cut mid-flight ⇒ the in-flight frame is lost (fail-stop)
    w.advance(1000);
    expect(payloadsOf(w.deliveredB)).toEqual([]); // it never arrived
    w.reopen();
    // Recovery is resume-handshake driven: B's HELLO must reach A (3s), then
    // A's resend must reach B (3s) — a full round trip on the slow link.
    w.advance(6001);
    expect(payloadsOf(w.deliveredB)).toEqual([1]); // recovered
  });
});
