/**
 * Send-time coalescing (`coalesceKey`) — spec §12.
 *
 * A message sent with `{ coalesceKey: k }` supersedes any earlier un-drained
 * outbox entry with the same key: the earlier ones are dropped before the new
 * one is appended. This turns "state-covering" streams (deltas, card state)
 * into last-one-wins, so a peer that was offline gets ONE current snapshot on
 * reconnect instead of a replayed burst of stale frames.
 *
 * Dropped seqs become gaps; the peer skips them via the same RESET-on-resend
 * path that `purge*` already uses — no new consumer logic.
 */

import { describe, expect, it } from 'vitest';
import { Endpoint } from '../endpoint.js';
import type { Effect } from '../types.js';
import { decodeFrame } from '../wire.js';
import { marker, payloadsOf, seqsOf, World } from './harness.js';

const A_EPOCH = 'node-A';
const B_EPOCH = 'phone-B';

function makeWorld(): World {
  const random = () => 0.5;
  return new World({ epoch: A_EPOCH, random }, { epoch: B_EPOCH, random });
}

describe('COALESCE-BASIC: an offline producer collapses same-key sends to one', () => {
  it('keeps only the latest same-key entry in the outbox', () => {
    const w = makeWorld(); // starts disconnected
    for (let i = 1; i <= 100; i++) w.sendA(marker(i), { coalesceKey: 'k1' });
    // 100 sends, 99 coalesced away ⇒ a single surviving entry (the last).
    expect(w.a.outboxSize).toBe(1);
    // Each send after the first emits a `purged` effect for the one it dropped.
    expect(w.purgedA.length).toBe(99);
    expect(w.purgedA.at(-1)).toEqual({ droppedSeqs: [99n], reason: 'coalesced:k1' });
  });

  it('delivers exactly one payload (the latest) on reconnect, with its key', () => {
    const w = makeWorld();
    for (let i = 1; i <= 100; i++) w.sendA(marker(i), { coalesceKey: 'k1' });
    w.connect();
    expect(w.deliveredB.length).toBe(1);
    expect(payloadsOf(w.deliveredB)).toEqual([100]); // last one wins
    expect(seqsOf(w.deliveredB)).toEqual([100n]); // fresh seq, dropped seqs skipped
    // The coalesce hint rides the wire and surfaces on the deliver effect so a
    // bridging hub can re-apply it on the next hop.
    expect(w.deliveredB[0]!.coalesceKey).toBe('k1');
    // Peer was told to skip the 1..99 gap (reset-inbound at the coalesced seq).
    expect(w.resetsB.at(-1)).toEqual({ fromSeq: 100n, peerEpoch: A_EPOCH });
  });
});

describe('COALESCE-MIXED: distinct keys and unkeyed events coexist', () => {
  it('keeps one-per-key plus every unkeyed message, ordered by seq', () => {
    const w = makeWorld();
    for (let i = 0; i < 10; i++) w.sendA(marker(10 + i), { coalesceKey: 'k1' });
    for (let i = 0; i < 10; i++) w.sendA(marker(30 + i), { coalesceKey: 'k2' });
    for (let i = 0; i < 5; i++) w.sendA(marker(50 + i)); // unkeyed events

    // 1 latest k1 + 1 latest k2 + 5 unkeyed = 7.
    expect(w.a.outboxSize).toBe(7);

    w.connect();
    // Delivered in seq order: k1-latest(seq10), k2-latest(seq20), then 5 events.
    expect(payloadsOf(w.deliveredB)).toEqual([19, 39, 50, 51, 52, 53, 54]);
    expect(seqsOf(w.deliveredB)).toEqual([10n, 20n, 21n, 22n, 23n, 24n, 25n]);
  });
});

describe('COALESCE-GAP: a superseded message is skipped, consumer sees no error', () => {
  it('drops an already-delivered same-key entry and delivers only the survivor', () => {
    const w = makeWorld();
    w.connect();
    w.sendA(marker(1), { coalesceKey: 'k1' }); // delivered live
    expect(payloadsOf(w.deliveredB)).toEqual([1]);

    w.disconnect();
    w.sendA(marker(2), { coalesceKey: 'k1' }); // supersedes seq1 (already gone to B)
    w.sendA(marker(3), { coalesceKey: 'k1' }); // supersedes seq2 (never sent)
    expect(w.a.outboxSize).toBe(1);

    w.reopen();
    // seq2 was coalesced away and never delivered; consumer jumps 1 → 3 cleanly.
    expect(payloadsOf(w.deliveredB)).toEqual([1, 3]);
    expect(seqsOf(w.deliveredB)).toEqual([1n, 3n]);
  });
});

describe('COALESCE-DURABLE: coalesceKey and durable are mutually exclusive', () => {
  it('throws when both are requested (fail-loud API)', () => {
    const w = makeWorld();
    expect(() => w.a.send(marker(1), { durable: true, coalesceKey: 'k' })).toThrow(
      /coalesceKey requires durable=false/,
    );
  });

  it('allows coalesceKey with an explicit durable:false', () => {
    const w = makeWorld();
    expect(() => w.a.send(marker(1), { durable: false, coalesceKey: 'k' })).not.toThrow();
  });
});

describe('COALESCE-SNAPSHOT: coalesceKey survives snapshot round-trip', () => {
  it('a restored keyed entry still coalesces against a fresh same-key send', () => {
    const w = makeWorld();
    w.sendA(marker(1), { coalesceKey: 'k1' });
    w.sendA(marker(2), { coalesceKey: 'k1' }); // outbox: [seq2 k1]

    const snap = w.a.snapshot();
    expect(snap.outbox.length).toBe(1);
    expect(snap.outbox[0]!.coalesceKey).toBe('k1');

    // Full restart of A from the snapshot.
    const restored = new Endpoint({ epoch: A_EPOCH, random: () => 0.5, restore: snap });
    expect(restored.outboxSize).toBe(1);

    // A fresh k1 send must coalesce the RESTORED entry away — only possible if
    // coalesceKey deserialized correctly.
    const { effects } = restored.send(marker(3), { coalesceKey: 'k1' });
    expect(restored.outboxSize).toBe(1);
    expect(effects).toContainEqual({
      t: 'purged',
      droppedSeqs: [2n],
      reason: 'coalesced:k1',
      streamId: 0,
    });
  });
});

describe('COALESCE-IN-FLIGHT: an already-transmitted entry is coalesced before ack', () => {
  it('replaces a transmitted-but-unacked entry, peer gets only the latest', () => {
    const w = makeWorld();
    w.connect();
    // transmit seq=1 (keyed) over the live link — peer receives and delivers it
    w.sendA(marker(1), { coalesceKey: 'k1' });
    expect(payloadsOf(w.deliveredB)).toEqual([1]);

    // Now send a second k1 message — this supersedes seq=1 in our outbox even
    // though seq=1 was already transmitted (but we don't know if the peer
    // acked it yet because ACKs piggyback on DATA/HEARTBEAT). The new entry
    // gets seq=2.
    const { effects } = w.a.send(marker(2), { coalesceKey: 'k1' });
    expect(w.a.outboxSize).toBe(1);
    // seq=1 was already delivered, so the purged effect still fires for
    // observability even though the entry was never durable.
    expect(effects).toContainEqual({
      t: 'purged',
      droppedSeqs: [1n],
      reason: 'coalesced:k1',
      streamId: 0,
    });

    // Pump the new transmit through to the peer.
    w.pump(effects, 'AtoB');
    // peer sees seq=2 delivered (seq=1 was already delivered, cursor=1; the
    // RESET-on-resend from our sparse outbox advances cursor from 1 to skip the
    // dropped seq=1, then delivers seq=2).
    expect(payloadsOf(w.deliveredB)).toEqual([1, 2]);
    expect(seqsOf(w.deliveredB)).toEqual([1n, 2n]);
  });

  it('replaces an in-flight entry and the next resend carries only the survivor', () => {
    const w = makeWorld();
    w.connect();
    // transmit seq=1 (no coalesce) then seq=2 (keyed)
    w.sendA(marker(10)); // seq=1
    w.sendA(marker(20), { coalesceKey: 'k1' }); // seq=2
    expect(w.deliveredB.length).toBe(2);

    // Disconnect: peer ACKs to cursor 2 but our outbox may still hold
    // entries the peer hasn't acked. Simulate a lossy disconnect.
    w.disconnect();
    // Send a new k1 message — coalesces seq=2 out of the outbox
    w.sendA(marker(30), { coalesceKey: 'k1' }); // seq=3 (coalesces seq=2)
    expect(w.a.outboxSize).toBe(2); // seq=1 (unkeyed) + seq=3 (latest k1)

    // Reconnect: outbox resend. seq=2 was already delivered to the peer, but
    // it was coalesced away from our outbox. resendFrom walks entries in seq
    // order: seq=1 present, seq=2 GAP (RESET {oldest=3}), seq=3 sent.
    // The peer cursor advances: 2 → skip to (3-1)=2, delivers seq=3.
    w.reopen();
    // peer already delivered seq=1,2 before disconnect. The resend retransmits
    // seq=1 (duplicate, ignored via ack), then RESET+seq=3.
    expect(w.deliveredB.at(-1)!.payload).toEqual(marker(30));
  });
});

describe('COALESCE-ONLINE-REPAIR: duplicate hole ACKs do not amplify recovery', () => {
  it('queues one bounded repair batch, not one full resend per stale ACK', () => {
    const random = () => 0.5;
    const a = new Endpoint({ epoch: A_EPOCH, random });
    const b = new Endpoint({ epoch: B_EPOCH, random });

    // Complete the HELLO exchange without introducing any transport fault.
    const aToB: Uint8Array[] = [];
    const bToA: Uint8Array[] = [];
    const collectTransmits = (effects: Effect[], wire: Uint8Array[]): void => {
      for (const effect of effects) {
        if (effect.t === 'transmit') wire.push(effect.bytes);
      }
    };
    collectTransmits(a.onConnected(0), aToB);
    collectTransmits(b.onConnected(0), bToA);
    while (aToB.length > 0 || bToA.length > 0) {
      while (aToB.length > 0) collectTransmits(b.onBytes(aToB.shift()!, 0), bToA);
      while (bToA.length > 0) collectTransmits(a.onBytes(bToA.shift()!, 0), aToB);
    }

    // Lose the first live coalesced DATA. Before its ACK can return, producer A
    // emits a burst of replacements plus one ordinary, unkeyed echo. This is a
    // deterministic model of a non-zero-RTT link: B sees every later seq as a
    // hole and sends the same ACK(0) for each one.
    const lost = a.send(marker(1), { coalesceKey: 'delta:session-1' });
    expect(lost.effects.some((effect) => effect.t === 'transmit')).toBe(true);
    // Intentionally do not put seq=1 on the wire.

    const initialBurst: Uint8Array[] = [];
    for (let i = 2; i <= 64; i++) {
      collectTransmits(a.send(marker(i), { coalesceKey: 'delta:session-1' }).effects, initialBurst);
    }
    const echo = a.send(marker(200));
    collectTransmits(echo.effects, initialBurst);
    expect(echo.seq).toBe(65n);
    expect(a.outboxSize).toBe(2); // latest delta + ordinary echo

    const staleAcks: Uint8Array[] = [];
    for (const bytes of initialBurst) collectTransmits(b.onBytes(bytes, 1), staleAcks);
    expect(staleAcks).toHaveLength(64);
    expect(
      staleAcks.every((bytes) => {
        const frame = decodeFrame(bytes);
        return frame?.t === 'ack' && frame.ack === 0n;
      }),
    ).toBe(true);

    // All duplicate ACK(0)s are already queued before A's first repair can make
    // the round trip. Processing them must not enqueue 64 copies of the same
    // RESET + retained suffix. One repair batch is exactly:
    //   RESET(oldest=64), DATA(64 latest delta), DATA(65 ordinary echo).
    const repairWire: Uint8Array[] = [];
    for (const bytes of staleAcks) collectTransmits(a.onBytes(bytes, 2), repairWire);
    const repairTypes = repairWire.map((bytes) => decodeFrame(bytes)?.t);
    expect(repairTypes).toHaveLength(3);
    expect(repairTypes).toEqual(['reset', 'data', 'data']);

    // That single bounded repair must deliver the ordinary echo immediately;
    // no heartbeat, reconnect, or pause in the coalesced stream is required.
    const delivered: Array<{ seq: bigint; marker: number }> = [];
    for (const bytes of repairWire) {
      for (const effect of b.onBytes(bytes, 3)) {
        if (effect.t === 'deliver') {
          delivered.push({ seq: effect.seq, marker: effect.payload[0] ?? -1 });
        }
      }
    }
    expect(delivered).toEqual([
      { seq: 64n, marker: 64 },
      { seq: 65n, marker: 200 },
    ]);
  });

  it('retries a lost bounded repair after the heartbeat interval', () => {
    const params = { heartbeatIntervalMs: 100, deadAfterMs: 1_000 };
    const a = new Endpoint({ epoch: A_EPOCH, params, random: () => 0.5 });
    const b = new Endpoint({ epoch: B_EPOCH, params, random: () => 0.5 });
    const transmits = (effects: Effect[]): Uint8Array[] =>
      effects.flatMap((effect) => (effect.t === 'transmit' ? [effect.bytes] : []));

    // Install peer capabilities/epochs. No application data is exchanged here.
    const helloA = transmits(a.onConnected(0))[0]!;
    const helloB = transmits(b.onConnected(0))[0]!;
    b.onBytes(helloA, 0);
    a.onBytes(helloB, 0);

    // seq=1 is lost; seq=2 replaces it and creates ACK(0).
    a.send(marker(1), { coalesceKey: 'delta' });
    const seq2 = transmits(a.send(marker(2), { coalesceKey: 'delta' }).effects)[0]!;
    const ack0 = transmits(b.onBytes(seq2, 1))[0]!;

    const firstRepair = transmits(a.onBytes(ack0, 2));
    expect(firstRepair.map((bytes) => decodeFrame(bytes)?.t)).toEqual(['reset', 'data']);
    // Drop the complete first repair batch. Duplicate ACK before the deadline
    // remains suppressed.
    expect(transmits(a.onBytes(ack0, 50))).toHaveLength(0);
    expect(transmits(a.onTick(101))).toHaveLength(0);

    // At repairSentAt(2) + heartbeat(100), retry exactly one bounded batch.
    const retry = transmits(a.onTick(102));
    expect(retry.map((bytes) => decodeFrame(bytes)?.t)).toEqual(['reset', 'data']);

    const delivered: number[] = [];
    for (const bytes of retry) {
      for (const effect of b.onBytes(bytes, 103)) {
        if (effect.t === 'deliver') delivered.push(effect.payload[0] ?? -1);
      }
    }
    expect(delivered).toEqual([2]);
  });
});

describe('COALESCE-VALIDATION: malformed keys rejected before state mutation', () => {
  it('throws on a coalesceKey that encodes to >255 UTF-8 bytes', () => {
    const w = makeWorld();
    const longKey = 'x'.repeat(256); // 256 bytes
    expect(() => w.a.send(marker(1), { coalesceKey: longKey })).toThrow(/exceeds 255 bytes/);
    // Outbox must be unmodified — no orphaned entry.
    expect(w.a.outboxSize).toBe(0);
  });

  it('accepts a coalesceKey of exactly 255 bytes', () => {
    const w = makeWorld();
    const maxKey = 'x'.repeat(255);
    expect(() => w.a.send(marker(1), { coalesceKey: maxKey })).not.toThrow();
    expect(w.a.outboxSize).toBe(1);
  });
});
