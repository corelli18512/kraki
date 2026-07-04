/**
 * Durable outbox — the persist-across-restart capability (spec §8.1).
 *
 * These tests are the brutal contract for durability: capability negotiation,
 * the wire durable bit gated on peer support, store/unstore emission, resume
 * from a persisted store after a simulated restart, mixed durable/non-durable
 * behavior, exactly-once + ordering under durability, and retention expiry.
 *
 * Everything is anonymous A/B endpoints — ZERO kraki concepts. `store`/`unstore`
 * carry only seq + bytes; the core never sees a destination.
 */

import { describe, expect, it } from 'vitest';
import { Endpoint } from '../endpoint.js';
import { decodeFrame } from '../wire.js';
import { DEFAULT_PARAMS, type Effect } from '../types.js';
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

  pump(effects: Effect[], from: 'A' | 'B', dropB?: (fr: ReturnType<typeof decodeFrame>) => boolean): void {
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
      new Endpoint({ epoch: 'H', random: () => 0.5, durable: { supported: true, maxRetentionMs: 2_592_000_000 } }),
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
    const peer = new Endpoint({ epoch: 'B', random: () => 0.5, durable: { supported: peerSupported } });
    let peerHello: Uint8Array | null = null;
    for (const e of peer.onConnected(0)) if (e.t === 'transmit') peerHello = e.bytes;
    a.onConnected(0);
    a.onBytes(peerHello!, 0);
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
    for (const e of effects) if (e.t === 'store') disk.set(e.seq, e.payload[0]!);
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
      for (const e of effects) if (e.t === 'store') disk.set(e.seq, e.payload[0]!);
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
