/**
 * StreamSet — multi-stream multiplexer for one shared link. See spec §13.
 *
 * A single WebSocket carries N independent Pulse streams, each a full
 * {@link Endpoint} with its own epoch / seq / outbox / cursor / handshake. The
 * wire header's `streamId` (v2) routes each frame to the endpoint that owns it.
 *
 * Why this exists: a single ordered stream head-of-line blocks any low-latency
 * message behind a bulk transfer sharing it. Splitting bulk (e.g. history
 * replay, turn-trace batches, attachment chunks) onto its own stream means a
 * live message (echo, abort, status card) gets its own seq space and is never
 * queued behind bulk seqs — it can transmit as soon as it is produced.
 *
 * Scheduling: {@link onTick} visits streams in ascending `streamId` order so a
 * lower-numbered (live) stream's transmit effects are emitted before a
 * higher-numbered (bulk) stream's. An adapter that flushes transmit effects in
 * the order Pulse returns them therefore sends live traffic first within each
 * tick window. Per-stream independence is what closes the HOL gap: a live
 * stream's seq 5 is not behind a bulk stream's seq 1..200, because they are
 * different seq spaces on different streams.
 *
 * Liveness is per-stream: each endpoint tracks its own `lastRecvAt` and emits
 * its own heartbeats, so a quiet bulk stream still keeps itself alive. The
 * physical link is shared, so connect/disconnect events are broadcast to every
 * stream.
 */

import type { Endpoint } from './endpoint.js';
import type { Effect } from './types.js';
import { decodeFrameWithStream } from './wire.js';

export interface SendOptions {
  durable?: boolean;
  coalesceKey?: string;
}

export class StreamSet {
  private readonly streams = new Map<number, Endpoint>();
  /** Ascending streamIds cached so onTick doesn't re-sort each call. Mutated on
   *  register only. */
  private order: number[] = [];

  constructor(streams: Endpoint[] = []) {
    for (const ep of streams) this.register(ep);
  }

  /** Add a stream. The endpoint's `stream` id must be unique within the set. */
  register(ep: Endpoint): void {
    const id = ep.stream;
    if (this.streams.has(id)) {
      throw new Error(`stream ${id} already registered`);
    }
    this.streams.set(id, ep);
    this.order = [...this.streams.keys()].sort((a, b) => a - b);
  }

  /** The endpoint owning `streamId`, or undefined if no such stream is
   *  registered. */
  get(streamId: number): Endpoint | undefined {
    return this.streams.get(streamId);
  }

  /** Send on a specific stream. Throws if the stream isn't registered. */
  send(
    streamId: number,
    payload: Uint8Array,
    opts?: SendOptions,
  ): { seq: bigint; effects: Effect[] } {
    const ep = this.streams.get(streamId);
    if (!ep) throw new Error(`unknown stream ${streamId}`);
    return ep.send(payload, opts);
  }

  /** The link came up: every stream resumes (sends its HELLO). Effects are
   *  returned in ascending stream order. */
  onConnected(now: number): Effect[] {
    const out: Effect[] = [];
    for (const id of this.order) {
      const ep = this.streams.get(id);
      if (ep) out.push(...ep.onConnected(now));
    }
    return out;
  }

  /** The link went down: every stream marks itself disconnected (retains its
   *  outbox for resume). */
  onDisconnected(now: number): Effect[] {
    const out: Effect[] = [];
    for (const id of this.order) {
      const ep = this.streams.get(id);
      if (ep) out.push(...ep.onDisconnected(now));
    }
    return out;
  }

  /** A frame arrived on the shared link. Decode once, route to the owning
   *  stream. Frames for an unknown / unregistered streamId are dropped (the peer
   *  may have a stream we haven't opened — harmless, like an unknown frame
   *  type). Malformed frames are dropped per spec §5.0. */
  onBytes(bytes: Uint8Array, now: number): Effect[] {
    const d = decodeFrameWithStream(bytes);
    if (d === null) return [];
    const ep = this.streams.get(d.streamId);
    if (!ep) return [];
    return ep.onFrame(d.frame, now);
  }

  /** Periodic tick for every stream, in ascending stream order so a live
   *  (low-id) stream's transmit effects precede a bulk (high-id) stream's in
   *  the returned batch. */
  onTick(now: number): Effect[] {
    const out: Effect[] = [];
    for (const id of this.order) {
      const ep = this.streams.get(id);
      if (ep) out.push(...ep.onTick(now));
    }
    return out;
  }
}
