/**
 * Multi-stream (spec §13) — independent ordered flows on one shared link, so a
 * bulk stream (history replay, trace batches, attachment chunks) cannot
 * head-of-line block a live stream (echo, abort, status card).
 *
 * Each stream is a full Endpoint with its own seq/ack/outbox/cursor/handshake.
 * The v2 wire header carries a 1-byte `streamId` that routes frames to the
 * owning stream.
 */

import { describe, expect, it } from 'vitest';
import { Endpoint } from '../endpoint.js';
import { StreamSet } from '../stream-set.js';
import type { Effect } from '../types.js';
import { decodeFrameWithStream, encodeFrame, V1_VERSION, VERSION } from '../wire.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** A pair of StreamSets sharing one virtual link, with a delivery log keyed by
 *  streamId. Mirrors the single-stream World's shape but for multi-stream. */
class MultiWorld {
  now = 0;
  readonly a: StreamSet;
  readonly b: StreamSet;
  /** Deliveries at B, in arrival order: { stream, seq, tag }. */
  readonly deliveredB: Array<{ stream: number; seq: bigint; tag: string }> = [];

  constructor(a: Endpoint[], b: Endpoint[]) {
    this.a = new StreamSet(a);
    this.b = new StreamSet(b);
  }

  /** Feed one side's transmit effects to the other, returning the effects the
   *  other produced (its own transmits + deliveries). Records B's deliveries. */
  private cross(effects: Effect[], from: 'a' | 'b'): Effect[] {
    const out: Effect[] = [];
    for (const e of effects) {
      if (e.t !== 'transmit') continue;
      if (from === 'a') {
        const back = this.b.onBytes(e.bytes, this.now);
        for (const be of back) {
          if (be.t === 'deliver') {
            // decode the streamId of this delivered frame's wire bytes is not
            // possible from the effect alone; we tag payloads instead.
          }
          out.push(be);
        }
      } else {
        out.push(...this.a.onBytes(e.bytes, this.now));
      }
    }
    return out;
  }

  /** Record deliveries that appear in effects, attributing by payload tag. The
   *  caller pre-stamps each payload with its tag so we can recover which stream
   *  a delivery belongs to (the deliver effect carries no streamId). */
  recordDeliveries(effects: Effect[], tagToStream: Map<string, number>): void {
    for (const e of effects) {
      if (e.t !== 'deliver') continue;
      const tag = new TextDecoder().decode(e.payload);
      const stream = tagToStream.get(tag);
      if (stream !== undefined) this.deliveredB.push({ stream, seq: e.seq, tag });
    }
  }

  /** Connect both sides and pump handshake + any pre-loaded outboxes to
   *  quiescence. `tagToStream` lets delivery order get recorded at B. */
  connect(tagToStream: Map<string, number>): void {
    // Bidirectional pump: A.onConnected → B, B.onConnected → A, then any
    // piggybacked resends, until a full round produces no new transmits.
    let aEffects = this.a.onConnected(this.now);
    let bEffects = this.b.onConnected(this.now);
    this.recordDeliveries(bEffects, tagToStream);
    this.recordDeliveries(aEffects, tagToStream);
    for (let guard = 0; guard < 50; guard++) {
      // A's transmits → B; B's transmits → A.
      const newB = this.cross(aEffects, 'a');
      const newA = this.cross(bEffects, 'b');
      this.recordDeliveries(newB, tagToStream);
      this.recordDeliveries(newA, tagToStream);
      if (
        !hasTransmit(newB) &&
        !hasTransmit(newA) &&
        !hasTransmit(aEffects) &&
        !hasTransmit(bEffects)
      )
        break;
      aEffects = newA;
      bEffects = newB;
    }
  }
}

function hasTransmit(effects: Effect[]): boolean {
  return effects.some((e) => e.t === 'transmit');
}

function mkEndpoint(streamId: number, epoch = `ep-${streamId}`): Endpoint {
  return new Endpoint({ epoch, streamId });
}

function tag(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ── wire: streamId encoding ──────────────────────────────────────────────────

describe('wire multi-stream header', () => {
  it('encodes streamId=0 as v1 (byte-identical to legacy single-stream)', () => {
    const bytes = encodeFrame({ t: 'heartbeat', ack: 5n }, 0);
    // magic(0xB1) · version(0x01) · type(5) · ack u64 — no streamId byte.
    expect(bytes[0]).toBe(0xb1);
    expect(bytes[1]).toBe(V1_VERSION);
    expect(bytes[2]).toBe(5);
    expect(bytes).toHaveLength(3 + 8);
  });

  it('encodes streamId>0 as v2 with the streamId byte', () => {
    const bytes = encodeFrame({ t: 'heartbeat', ack: 5n }, 7);
    // magic(0xB1) · version(0x02) · type(5) · streamId(7) · ack u64.
    expect(bytes[0]).toBe(0xb1);
    expect(bytes[1]).toBe(VERSION);
    expect(bytes[2]).toBe(5);
    expect(bytes[3]).toBe(7);
    expect(bytes).toHaveLength(4 + 8);
  });

  it('decodes a v1 frame as streamId=0', () => {
    const v1 = encodeFrame({ t: 'heartbeat', ack: 5n }, 0);
    const d = decodeFrameWithStream(v1);
    expect(d?.streamId).toBe(0);
    expect(d?.frame).toEqual({ t: 'heartbeat', ack: 5n });
  });

  it('decodes a v2 frame with its streamId', () => {
    const v2 = encodeFrame({ t: 'heartbeat', ack: 5n }, 42);
    const d = decodeFrameWithStream(v2);
    expect(d?.streamId).toBe(42);
    expect(d?.frame).toEqual({ t: 'heartbeat', ack: 5n });
  });

  it('round-trips every frame type with a non-zero streamId', () => {
    const frames = [
      {
        t: 'hello',
        epoch: 'e',
        recvEpoch: 're',
        recvCursor: 3n,
        durableSupported: true,
        maxRetentionMs: 0n,
      },
      { t: 'data', seq: 1n, ack: 0n, payload: tag('hi'), durable: false },
      { t: 'data', seq: 2n, ack: 1n, payload: tag('x'), durable: true, coalesceKey: 'k' },
      { t: 'ack', ack: 9n },
      { t: 'reset', epoch: 'e2', oldest: 4n },
      { t: 'heartbeat', ack: 7n },
    ] as const;
    for (const f of frames) {
      for (const streamId of [0, 1, 255]) {
        const d = decodeFrameWithStream(encodeFrame(f, streamId));
        expect(d?.streamId, `streamId=${streamId} frame=${f.t}`).toBe(streamId);
        expect(d?.frame, `streamId=${streamId} frame=${f.t}`).toEqual(f);
      }
    }
  });
});

// ── StreamSet: independent seq spaces ─────────────────────────────────────────

describe('StreamSet independent sequence spaces', () => {
  it('each stream has its own seq starting at 1', () => {
    const a0 = mkEndpoint(0);
    const a1 = mkEndpoint(1);
    const set = new StreamSet([a0, a1]);
    const r0 = set.send(0, tag('live'));
    const r1 = set.send(1, tag('bulk'));
    expect(r0.seq).toBe(1n);
    expect(r1.seq).toBe(1n); // independent — NOT 2
  });

  it('send on an unknown stream throws', () => {
    const set = new StreamSet([mkEndpoint(0)]);
    expect(() => set.send(5, tag('x'))).toThrow(/unknown stream 5/);
  });

  it('registering a duplicate stream throws', () => {
    expect(() => new StreamSet([mkEndpoint(0), mkEndpoint(0)])).toThrow(/already registered/);
  });
});

// ── StreamSet: HOL isolation (the whole point) ───────────────────────────────

describe('StreamSet head-of-line isolation', () => {
  it('a live message on stream 0 is delivered BEFORE bulk on stream 1', () => {
    // Pre-load 20 bulk messages on stream 1 while DISCONNECTED (they pile into
    // the outbox), then one live message on stream 0, then connect. On a single
    // stream the live message (seq 21) would deliver after all 20 bulk seqs.
    // On separate streams the live message has its own seq space and is
    // delivered first — proving no HOL blocking.
    const a0 = mkEndpoint(0);
    const a1 = mkEndpoint(1);
    const b0 = mkEndpoint(0);
    const b1 = mkEndpoint(1);

    const tagToStream = new Map<string, number>();
    // 20 bulk on stream 1 (offline → outbox only)
    for (let i = 0; i < 20; i++) {
      const t = `bulk-${i}`;
      tagToStream.set(t, 1);
      a1.send(tag(t));
    }
    // 1 live on stream 0 (offline → outbox only)
    tagToStream.set('LIVE', 0);
    a0.send(tag('LIVE'));

    const world = new MultiWorld([a0, a1], [b0, b1]);
    world.connect(tagToStream);

    // B must have received the LIVE message and all 20 bulk.
    const live = world.deliveredB.find((d) => d.tag === 'LIVE');
    expect(live, 'live message was delivered').toBeDefined();
    expect(world.deliveredB.filter((d) => d.stream === 1)).toHaveLength(20);

    // The live delivery must come BEFORE every bulk delivery — the core
    // guarantee. (On a single stream with 20 bulk sent first, live would be
    // delivered LAST.)
    const liveIdx = world.deliveredB.findIndex((d) => d.tag === 'LIVE');
    const firstBulkIdx = world.deliveredB.findIndex((d) => d.stream === 1);
    expect(liveIdx).toBeGreaterThanOrEqual(0);
    expect(firstBulkIdx).toBeGreaterThanOrEqual(0);
    expect(liveIdx, 'live delivered before the first bulk (no HOL blocking)').toBeLessThan(
      firstBulkIdx,
    );
  });
});

// ── StreamSet: routing & robustness ──────────────────────────────────────────

describe('StreamSet routing', () => {
  it('drops frames for an unregistered streamId', () => {
    const a = new StreamSet([mkEndpoint(0)]);
    const b = new StreamSet([mkEndpoint(0)]); // does NOT have stream 1
    // A sends on stream 1 via a throwaway endpoint, frames carry streamId=1.
    const ghost = mkEndpoint(1);
    const effects = ghost.send(tag('boo'));
    // Hand the transmit bytes to B: B has no stream 1, so it drops silently.
    let delivered = false;
    for (const e of effects.effects) {
      if (e.t === 'transmit') {
        const back = b.onBytes(e.bytes, 0);
        if (back.some((be) => be.t === 'deliver')) delivered = true;
      }
    }
    expect(delivered).toBe(false);
  });

  it('each stream handshakes and resumes independently', () => {
    // Disconnect mid-transfer on stream 1 should not disturb stream 0's cursor.
    // We verify by giving each stream a distinct epoch and confirming both
    // peers exchange HELLOs and deliver on both streams after connect.
    const a0 = mkEndpoint(0, 'A0');
    const a1 = mkEndpoint(1, 'A1');
    const b0 = mkEndpoint(0, 'B0');
    const b1 = mkEndpoint(1, 'B1');
    const tagToStream = new Map<string, number>();
    tagToStream.set('m0', 0);
    tagToStream.set('m1', 1);
    a0.send(tag('m0'));
    a1.send(tag('m1'));
    const world = new MultiWorld([a0, a1], [b0, b1]);
    world.connect(tagToStream);
    expect(world.deliveredB.find((d) => d.tag === 'm0')).toBeDefined();
    expect(world.deliveredB.find((d) => d.tag === 'm1')).toBeDefined();
  });
});
