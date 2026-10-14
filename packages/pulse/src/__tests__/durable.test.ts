/**
 * Durable outbox — the persist-across-restart capability (spec §8.1).
 *
 * These tests are the brutal contract for durability: capability negotiation,
 * the wire durable bit gated on peer support, store/unstore emission, resume
 * from a persisted store after a simulated restart, mixed durable/non-durable
 * behavior, exactly-once + ordering under durability, and retention expiry.
 *
 * Everything is anonymous A/B endpoints — ZERO application concepts. `store`/`unstore`
 * carry only seq + bytes; the core never sees a destination.
 */

import { describe, expect, it } from 'vitest';
import { Endpoint } from '../endpoint.js';
import { DEFAULT_PARAMS, type Effect, type Snapshot } from '../types.js';
import { decodeFrame, encodeFrame } from '../wire.js';
import { marker, payloadsOf, seqsOf, World } from './harness.js';

/** Drive two endpoints by hand, capturing effects. Lets tests inspect store,
 *  simulate a restart, and drop specific frames — without harness clock quirks. */
class Pair {
  a: Endpoint;
  b: Endpoint;
  t = 0;
  ackedA: bigint[] = [];
  deliveredB: number[] = [];
  deliveredA: number[] = [];
  resetB: bigint[] = [];
  /** Simulated durable disk at each side: seq → payload marker. */
  diskA = new Map<bigint, number>();
  diskB = new Map<bigint, number>();
  private linkUp = false;

  constructor(
    aDurable?: { supported: boolean; maxRetentionMs?: number },
    bDurable?: { supported: boolean; maxRetentionMs?: number },
    aRestore?: ReturnType<Endpoint['snapshot']>,
    bRestore?: ReturnType<Endpoint['snapshot']>,
  ) {
    this.a = new Endpoint({ epoch: 'A', random: () => 0.5, durable: aDurable, restore: aRestore });
    this.b = new Endpoint({ epoch: 'B', random: () => 0.5, durable: bDurable, restore: bRestore });
  }

  private applyDisk(disk: Map<bigint, number>, e: Effect): void {
    if (e.t === 'store') disk.set(e.seq, e.payload[0] ?? -1);
    if (e.t === 'unstore') for (const s of [...disk.keys()]) if (s <= e.seqUpTo) disk.delete(s);
  }

  pump(
    effects: Effect[],
    from: 'A' | 'B',
    dropB?: (fr: ReturnType<typeof decodeFrame>) => boolean,
  ): void {
    for (const e of effects) {
      if (from === 'A') this.applyDisk(this.diskA, e);
      else this.applyDisk(this.diskB, e);
      if (e.t === 'acked' && from === 'A') this.ackedA.push(e.seqUpTo);
      if (e.t === 'deliver' && from === 'B') this.deliveredB.push(e.payload[0] ?? -1);
      if (e.t === 'deliver' && from === 'A') this.deliveredA.push(e.payload[0] ?? -1);
      if (e.t === 'reset-inbound' && from === 'B') this.resetB.push(e.fromSeq);
      if (e.t === 'transmit') {
        if (!this.linkUp) continue;
        const fr = decodeFrame(e.bytes);
        if (from === 'B' && dropB?.(fr)) continue;
        if (from === 'A') this.pump(this.b.onBytes(e.bytes, this.t), 'B', dropB);
        else this.pump(this.a.onBytes(e.bytes, this.t), 'A', dropB);
      }
    }
  }

  connect(): void {
    this.linkUp = true;
    this.pump(this.a.onConnected(this.t), 'A');
    this.pump(this.b.onConnected(this.t), 'B');
  }
  disconnect(): void {
    this.linkUp = false;
    this.pump(this.a.onDisconnected(this.t), 'A');
    this.pump(this.b.onDisconnected(this.t), 'B');
  }
  tick(to: number, dropB?: (fr: ReturnType<typeof decodeFrame>) => boolean): void {
    this.t = to;
    this.pump(this.a.onTick(to), 'A', dropB);
    this.pump(this.b.onTick(to), 'B', dropB);
  }
  sendA(m: number, durable?: boolean): void {
    this.pump(this.a.send(marker(m), { durable }).effects, 'A');
  }
  /** The bytes a durable-supported A would emit on the wire for the last DATA. */
}

// ── 1. Capability negotiation (four combinations) ──────────────────────────

describe('DURABLE-1: capability negotiation over HELLO', () => {
  function firstHello(ep: Endpoint): Extract<ReturnType<typeof decodeFrame>, { t: 'hello' }> {
    const effects = ep.onConnected(0);
    for (const e of effects) {
      if (e.t === 'transmit') {
        const fr = decodeFrame(e.bytes);
        if (fr?.t === 'hello') return fr;
      }
    }
    throw new Error('no hello');
  }

  it('advertises supported=false by default', () => {
    const h = firstHello(new Endpoint({ epoch: 'A', random: () => 0.5 }));
    expect(h.durableSupported).toBe(false);
    expect(h.maxRetentionMs).toBe(0n);
  });

  it('advertises supported=true + retention when configured', () => {
    const h = firstHello(
      new Endpoint({
        epoch: 'H',
        random: () => 0.5,
        durable: { supported: true, maxRetentionMs: 2_592_000_000 },
      }),
    );
    expect(h.durableSupported).toBe(true);
    expect(h.maxRetentionMs).toBe(2_592_000_000n);
  });
});

// ── 2. Wire durable bit only set when the PEER supports it ──────────────────

describe('DURABLE-2: the DATA durable bit is gated on peer support', () => {
  function dataBitFor(peerSupported: boolean): boolean {
    const a = new Endpoint({ epoch: 'A', random: () => 0.5, durable: { supported: true } });
    // Feed a HELLO from a peer with the given support.
    const peer = new Endpoint({
      epoch: 'B',
      random: () => 0.5,
      durable: { supported: peerSupported },
    });
    let peerHello: Uint8Array | null = null;
    for (const e of peer.onConnected(0)) if (e.t === 'transmit') peerHello = e.bytes;
    a.onConnected(0);
    if (peerHello) a.onBytes(peerHello, 0);
    const { effects } = a.send(marker(1), { durable: true });
    for (const e of effects) {
      if (e.t === 'transmit') {
        const fr = decodeFrame(e.bytes);
        if (fr?.t === 'data') return fr.durable;
      }
    }
    throw new Error('no data frame');
  }

  it('sets the durable bit when peer supports durable', () => {
    expect(dataBitFor(true)).toBe(true);
  });
  it('clears the durable bit when peer does NOT support durable', () => {
    expect(dataBitFor(false)).toBe(false);
  });
});

// ── 3. Supported endpoint persists its durable outbox (store effect) ────────

describe('DURABLE-3: a durable-supported endpoint stores its durable sends', () => {
  it('emits store for a durable send, even before connect (offline)', () => {
    const a = new Endpoint({ epoch: 'A', random: () => 0.5, durable: { supported: true } });
    const disk = new Map<bigint, number>();
    // Not connected yet.
    const { effects } = a.send(marker(7), { durable: true });
    for (const e of effects) if (e.t === 'store') disk.set(e.seq, e.payload[0] ?? 0);
    expect(disk.get(1n)).toBe(7);
  });

  it('does NOT store a non-durable send', () => {
    const a = new Endpoint({ epoch: 'A', random: () => 0.5, durable: { supported: true } });
    const { effects } = a.send(marker(7)); // no durable
    expect(effects.some((e) => e.t === 'store')).toBe(false);
  });

  it('does NOT store when the endpoint is not durable-supported', () => {
    const a = new Endpoint({ epoch: 'A', random: () => 0.5 }); // supported:false
    const { effects } = a.send(marker(7), { durable: true });
    expect(effects.some((e) => e.t === 'store')).toBe(false);
  });
});

// ── 4. Resume from a persisted store after a restart ────────────────────────

describe('DURABLE-4: resume delivers durable messages across a restart', () => {
  it('a durable message produced, then the sender RESTARTS, still arrives', () => {
    // A is durable-supported, B can persist too (so wire bit is set). A sends a
    // durable message while B is offline; A persists it; A "restarts" from its
    // snapshot (with the persisted entry) and delivers on reconnect.
    const p = new Pair({ supported: true }, { supported: true });
    p.connect();
    p.disconnect();
    p.sendA(9, /* durable */ true); // produced offline
    expect(p.diskA.get(1n)).toBe(9); // persisted to disk

    // Simulate a full restart of A: new Endpoint restored from snapshot.
    const snapA = p.a.snapshot();
    const p2 = new Pair({ supported: true }, { supported: true }, snapA, p.b.snapshot());
    // The restored outbox re-emits store on load? No — store is at send time.
    // Seed p2's disk from p1's (the adapter would have it on disk).
    p2.diskA = new Map(p.diskA);
    p2.connect();
    expect(p2.deliveredB).toEqual([9]); // survived the restart
  });
});

// ── 5. Mixed durable / non-durable: only durable persists ───────────────────

describe('DURABLE-5: only durable messages hit the store', () => {
  it('interleaved durable + plain sends → store holds only the durable ones', () => {
    const a = new Endpoint({ epoch: 'A', random: () => 0.5, durable: { supported: true } });
    const disk = new Map<bigint, number>();
    const apply = (effects: Effect[]) => {
      for (const e of effects) if (e.t === 'store') disk.set(e.seq, e.payload[0] ?? 0);
    };
    apply(a.send(marker(1)).effects); // plain  → seq 1
    apply(a.send(marker(2), { durable: true }).effects); // durable → seq 2
    apply(a.send(marker(3)).effects); // plain  → seq 3
    apply(a.send(marker(4), { durable: true }).effects); // durable → seq 4
    expect([...disk.keys()].sort()).toEqual([2n, 4n]);
    expect(disk.get(2n)).toBe(2);
    expect(disk.get(4n)).toBe(4);
  });
});

// ── 6. Unstore only after the peer acks ─────────────────────────────────────

describe('DURABLE-6: unstore fires only when the durable message is confirmed', () => {
  it('store persists until ack; then unstore clears it', () => {
    const p = new Pair({ supported: true }, { supported: true });
    p.connect();
    p.sendA(5, true);
    expect(p.diskA.get(1n)).toBe(5); // stored on send
    // B delivered it live; its cursor must return to A to confirm + unstore.
    p.tick(DEFAULT_PARAMS.heartbeatIntervalMs + 1);
    expect(p.deliveredB).toEqual([5]);
    expect(p.diskA.has(1n)).toBe(false); // unstored after ack
    expect(p.ackedA.at(-1)).toBe(1n);
  });

  it('store survives while the peer stays offline', () => {
    const p = new Pair({ supported: true }, { supported: true });
    p.connect();
    p.disconnect();
    p.sendA(5, true);
    p.tick(DEFAULT_PARAMS.heartbeatIntervalMs * 3);
    expect(p.diskA.get(1n)).toBe(5); // still on disk — never confirmed
  });
});

// ── 7. Durable messages are still exactly-once + in order ───────────────────

describe('DURABLE-7: durability does not break exactly-once / ordering', () => {
  it('durable resend after a dropped ack delivers once, in order', () => {
    const p = new Pair({ supported: true }, { supported: true });
    p.connect();
    p.sendA(1, true);
    p.sendA(2, true);
    // Drop B's next cursor frame → A resends; must not double-deliver.
    p.tick(DEFAULT_PARAMS.heartbeatIntervalMs + 1, (fr) => fr?.t === 'heartbeat');
    p.tick(DEFAULT_PARAMS.heartbeatIntervalMs * 2 + 2);
    expect(p.deliveredB).toEqual([1, 2]); // exactly once, ordered
    expect(p.diskA.size).toBe(0); // both confirmed + unstored
  });
});

// ── 8. Retention expiry ─────────────────────────────────────────────────────

describe('DURABLE-8: durable entries expire after maxRetentionMs', () => {
  it('an unconfirmed durable entry is dropped + unstored past retention', () => {
    const p = new Pair({ supported: true, maxRetentionMs: 60_000 }, { supported: true });
    p.connect();
    p.disconnect(); // peer never confirms
    p.sendA(5, true);
    expect(p.diskA.get(1n)).toBe(5);
    // Before retention: still there.
    p.tick(59_000);
    expect(p.diskA.has(1n)).toBe(true);
    // After retention: dropped + unstored, will never be resent.
    p.tick(61_000);
    expect(p.diskA.has(1n)).toBe(false);
    expect(p.a.outboxSize).toBe(0);
  });

  it('a confirmed durable entry is not affected by retention (already gone)', () => {
    const p = new Pair({ supported: true, maxRetentionMs: 60_000 }, { supported: true });
    p.connect();
    p.sendA(5, true);
    p.tick(DEFAULT_PARAMS.heartbeatIntervalMs + 1); // confirmed + unstored
    expect(p.diskA.size).toBe(0);
    p.tick(200_000); // way past retention — nothing to expire
    expect(p.diskA.size).toBe(0);
  });
});

// ── 9. World-level: durable end-to-end through the fault harness ────────────

describe('DURABLE-9: durable message survives disconnect via the World harness', () => {
  it('durable produced while down, recovered on resume, store cleared', () => {
    const random = () => 0.5;
    const w = new World(
      { epoch: 'A', random, durable: { supported: true } },
      { epoch: 'B', random, durable: { supported: true } },
    );
    w.connect();
    w.disconnect();
    w.sendA(marker(1), { durable: true });
    expect(w.storeA.get(1n)).toBe(1); // persisted while offline
    w.reopen();
    w.advance(DEFAULT_PARAMS.heartbeatIntervalMs + 1);
    expect(payloadsOf(w.deliveredB)).toEqual([1]);
    expect(w.storeA.size).toBe(0); // confirmed + cleared
    expect(seqsOf(w.deliveredB)).toEqual([1n]);
  });
});

// ── 10. outboxBase > sendSeq regression (2026-07-10 prod outage) ───────────

describe('DURABLE-10: outboxBase never exceeds sendSeq (restart wedge fix)', () => {
  // Reproduces the exact prod failure: the head (durable hub) sends a mix of
  // durable + non-durable messages. Its peer acks a high recvCursor. The head
  // restarts from a durable-only snapshot — its sendSeq rewinds (non-durable
  // sends after the last saveSnapshot are lost) but the peer didn't restart
  // and still acks the old high recvCursor. Without the clamp, outboxBase
  // races past sendSeq, and the NEXT time the peer reconnects fresh
  // (recvCursor=0), its seq=1..N frames are treated as duplicates
  // (≤ outboxBase) and silently dropped — permanently wedging the link.
  // With the fix, outboxBase is clamped to sendSeq.

  it('pruneOutbox clamps outboxBase to sendSeq when peer acks ahead', () => {
    // Head sends durable(1) + non-durable(2,3) → sendSeq=3, then crashes.
    // On restart it loads a snapshot with sendSeq=3, outboxBase=0 (the last
    // saveSnapshot was at send time of the durable msg). The peer (still
    // alive) reconnects with recvCursor=5 (it received 2 MORE non-durable
    // msgs seq=4,5 that were on the wire but lost in the crash — head's
    // sendSeq was 5 before crash but only 3 is in the snapshot).
    //
    // We simulate this directly: restore sendSeq=3, then feed a HELLO with
    // recvCursor=5 (ahead of sendSeq=3). pruneOutbox must clamp to 3.
    const snap = {
      epoch: 'A',
      sendSeq: '3',
      outboxBase: '0',
      outbox: [
        { seq: '1', payloadB64: Buffer.from([1]).toString('base64'), durable: true, sentAt: 0 },
      ],
      recvCursor: '0',
      peerEpoch: 'B',
      disconnectedAtMs: null,
    } as unknown as Snapshot;
    const a = new Endpoint({
      epoch: 'A',
      random: () => 0.5,
      durable: { supported: true },
      restore: snap,
    });
    expect(a.sendSeqValue).toBe(3n);
    expect(a.outboxSize).toBe(1); // the durable entry survives

    a.onConnected(0);
    // Peer B reconnects, resuming A's epoch, with recvCursor=5 (ahead of sendSeq=3).
    a.onBytes(encodeHelloB('B', 'A', 5n), 0);

    const snap2 = a.snapshot();
    expect(BigInt(snap2.outboxBase)).toBe(3n); // clamped to sendSeq, NOT 5
    expect(BigInt(snap2.sendSeq)).toBe(3n);
  });

  it('loadSnapshot self-heals a corrupted outboxBase > sendSeq', () => {
    // Simulate a pre-0.3.1 snapshot that was persisted with outboxBase ahead
    // of sendSeq (the exact prod state: sendSeq=1733, outboxBase=1751).
    const corrupted = {
      epoch: 'head:dev_x:1700000000',
      sendSeq: '1733',
      outboxBase: '1751', // ← corrupted: ahead of sendSeq
      outbox: [],
      recvCursor: '0',
      peerEpoch: 'tentacle:dev_x:1700000001',
      disconnectedAtMs: null,
    };
    const a = new Endpoint({
      epoch: 'fresh',
      random: () => 0.5,
      durable: { supported: true },
      restore: corrupted as unknown as Snapshot,
    });
    // The clamp on load prevents the wedge.
    const snap = a.snapshot();
    expect(BigInt(snap.outboxBase)).toBe(1733n); // clamped to sendSeq
    expect(BigInt(snap.sendSeq)).toBe(1733n);
  });

  it('a fresh peer reconnecting after the clamp is NOT wedged', () => {
    // End-to-end: after the clamp, a fresh peer (recvCursor=0) receives new
    // messages (seq=4,5,...) — they are NOT treated as duplicates.
    // Head loads sendSeq=3, outboxBase=0 (durable entry seq=1 in outbox).
    const snap = {
      epoch: 'A',
      sendSeq: '3',
      outboxBase: '0',
      outbox: [
        { seq: '1', payloadB64: Buffer.from([1]).toString('base64'), durable: true, sentAt: 0 },
      ],
      recvCursor: '0',
      peerEpoch: '',
      disconnectedAtMs: null,
    } as unknown as Snapshot;
    const a = new Endpoint({
      epoch: 'A',
      random: () => 0.5,
      durable: { supported: true },
      restore: snap,
    });

    // A fresh peer B connects (new epoch, recvCursor=0). A's onHello path
    // (f.recvCursor=0 < outboxBase=0 is false, 0 >= 0 is true) → pruneOutbox(0)
    // is a no-op, then resendWithGapAnnounce(1) resends the durable entry.
    const b = new Endpoint({ epoch: 'B', random: () => 0.5 });
    const pair = new ManualPair(a, b);
    pair.connect();
    // A sends new messages seq=4,5.
    const sendEffs = [...a.send(marker(10)).effects, ...a.send(marker(11)).effects];
    pair.flush(sendEffs, 'A');
    // B received: durable(1) + new(10,11). All delivered, none dropped.
    expect(payloadsOfDelivered(pair.deliveredB)).toEqual([1, 10, 11]);
    expect(seqsOfDelivered(pair.deliveredB)).toEqual([1n, 4n, 5n]);
  });
});

// ── helpers for DURABLE-10 ─────────────────────────────────────────────────

function encodeHelloB(bEpoch: string, aEpoch: string, recvCursor: bigint): Uint8Array {
  // Build a HELLO frame from B resuming against A's epoch with a given recvCursor.
  return encodeFrame({
    t: 'hello',
    epoch: bEpoch,
    recvEpoch: aEpoch,
    recvCursor,
    durableSupported: true,
    maxRetentionMs: 0n,
  });
}

class ManualPair {
  linkUp = false;
  deliveredB: Array<{ seq: bigint; payload: Uint8Array }> = [];
  constructor(
    readonly a: Endpoint,
    readonly b: Endpoint,
  ) {}

  connect(): void {
    this.linkUp = true;
    this.flush(this.a.onConnected(0), 'A');
    this.flush(this.b.onConnected(0), 'B');
  }
  flushA(): void {
    this.flush(this.a.onTick(1), 'A');
  }
  flush(effects: Effect[], from: 'A' | 'B'): void {
    for (const e of effects) {
      if (e.t === 'deliver' && from === 'B')
        this.deliveredB.push({ seq: e.seq, payload: e.payload });
      if (e.t !== 'transmit' || !this.linkUp) continue;
      if (from === 'A') this.flush(this.b.onBytes(e.bytes, 1), 'B');
      else this.flush(this.a.onBytes(e.bytes, 1), 'A');
    }
  }
}

function payloadsOfDelivered(d: Array<{ payload: Uint8Array }>): number[] {
  return d.map((e) => e.payload[0] ?? -1);
}
function seqsOfDelivered(d: Array<{ seq: bigint }>): bigint[] {
  return d.map((e) => e.seq);
}
