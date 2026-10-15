/**
 * Wire codec — binary frame encode/decode. See spec/PROTOCOL.md §5.0 and
 * spec/FIXTURES.md. Pure functions; byte-for-byte identical to the Swift port.
 *
 * Layout (big-endian):
 *   header v1: u8 magic=0xB1 · u8 version=0x01 · u8 type
 *   header v2: u8 magic=0xB1 · u8 version=0x02 · u8 type · u8 streamId
 *   str    : u8 len · len UTF-8 bytes
 *   blob   : u32 len · len bytes
 *   u64    : 8 bytes big-endian
 *
 * v2 adds a 1-byte `streamId` to the header (spec §13, multi-stream). v2 is
 * used whenever `streamId > 0`; `streamId === 0` is encoded as v1 so a
 * single-stream peer is byte-identical to the pre-§13 wire format. Decoders
 * accept BOTH versions (a v1 frame is a v2 frame with streamId=0), so a new
 * peer can read an old peer; an old peer cannot read a v2 frame, so endpoints
 * that actually use multiple streams must upgrade together (negotiated by the
 * application above Pulse).
 */

import type { Seq } from './types.js';

export const MAGIC = 0xb1;
/** Current wire version (encodes the streamId header). */
export const VERSION = 0x02;
/** Legacy wire version accepted on decode (streamId implicit 0). */
export const V1_VERSION = 0x01;

export const FrameType = {
  HELLO: 1,
  DATA: 2,
  ACK: 3,
  RESET: 4,
  HEARTBEAT: 5,
} as const;

export type Frame =
  | {
      t: 'hello';
      epoch: string;
      recvEpoch: string;
      recvCursor: Seq;
      /** This endpoint can persist its outbox across a process restart. */
      durableSupported: boolean;
      /** How long a persisted entry is kept (ms). Meaningful only when
       * durableSupported; 0 otherwise. */
      maxRetentionMs: Seq;
    }
  | { t: 'data'; seq: Seq; ack: Seq; payload: Uint8Array; durable: boolean; coalesceKey?: string }
  | { t: 'ack'; ack: Seq }
  | { t: 'reset'; epoch: string; oldest: Seq }
  | { t: 'heartbeat'; ack: Seq };

const U64_MAX = (1n << 64n) - 1n;

/** A decoded frame together with the stream it belongs to. `streamId` is a
 *  transport-routing concern (which logical stream on the shared link), not a
 *  property of the frame itself — so it is returned alongside, not inside. */
export interface DecodedFrame {
  frame: Frame;
  streamId: number;
}

// ── Encoder ──────────────────────────────────────────────────────────────────

class Writer {
  private parts: number[] = [];
  u8(n: number): void {
    this.parts.push(n & 0xff);
  }
  u32(n: number): void {
    this.parts.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
  u64(n: Seq): void {
    if (n < 0n || n > U64_MAX) throw new RangeError(`u64 out of range: ${n}`);
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      this.parts.push(Number((n >> shift) & 0xffn));
    }
  }
  str(s: string): void {
    const b = new TextEncoder().encode(s);
    if (b.length > 255) throw new RangeError(`str too long: ${b.length} bytes (max 255)`);
    this.u8(b.length);
    for (const x of b) this.parts.push(x);
  }
  blob(b: Uint8Array): void {
    if (b.length > 0xffff_ffff) throw new RangeError('blob too long');
    this.u32(b.length);
    for (const x of b) this.parts.push(x);
  }
  /** Write the header. v2 (with streamId) is used for any non-default stream;
   *  streamId=0 is encoded as v1 so single-stream peers stay byte-identical to
   *  the pre-§13 wire format. */
  header(type: number, streamId: number): void {
    this.u8(MAGIC);
    if (streamId > 0) {
      this.u8(VERSION);
      this.u8(type);
      this.u8(streamId);
    } else {
      this.u8(V1_VERSION);
      this.u8(type);
    }
  }
  done(): Uint8Array {
    return new Uint8Array(this.parts);
  }
}

export function encodeFrame(f: Frame, streamId = 0): Uint8Array {
  const w = new Writer();
  switch (f.t) {
    case 'hello':
      w.header(FrameType.HELLO, streamId);
      w.str(f.epoch);
      w.str(f.recvEpoch);
      w.u64(f.recvCursor);
      w.u8(f.durableSupported ? 1 : 0);
      w.u64(f.maxRetentionMs);
      break;
    case 'data':
      w.header(FrameType.DATA, streamId);
      // flags: bit0 = durable (existing), bit1 = has coalesceKey (spec §12).
      w.u8((f.durable ? 1 : 0) | (f.coalesceKey !== undefined ? 2 : 0));
      w.u64(f.seq);
      w.u64(f.ack);
      w.blob(f.payload);
      // Optional trailing coalesceKey str (1-byte len + ≤255 UTF-8 bytes). Old
      // decoders read the blob and return, ignoring these trailing bytes.
      if (f.coalesceKey !== undefined) w.str(f.coalesceKey);
      break;
    case 'ack':
      w.header(FrameType.ACK, streamId);
      w.u64(f.ack);
      break;
    case 'reset':
      w.header(FrameType.RESET, streamId);
      w.str(f.epoch);
      w.u64(f.oldest);
      break;
    case 'heartbeat':
      w.header(FrameType.HEARTBEAT, streamId);
      w.u64(f.ack);
      break;
  }
  return w.done();
}

// ── Decoder ──────────────────────────────────────────────────────────────────

/** Bounds-checked cursor reader. Throws {@link Short} on underrun; the public
 *  decode function converts any throw into `null` (spec §5.0 robustness). */
class Short extends Error {}

class Reader {
  private off = 0;
  constructor(private readonly b: Uint8Array) {}
  private need(n: number): void {
    if (this.off + n > this.b.length) throw new Short();
  }
  u8(): number {
    this.need(1);
    return this.b[this.off++]!;
  }
  u32(): number {
    this.need(4);
    const v =
      this.b[this.off]! * 0x1000000 +
      ((this.b[this.off + 1]! << 16) | (this.b[this.off + 2]! << 8) | this.b[this.off + 3]!);
    this.off += 4;
    return v >>> 0;
  }
  u64(): bigint {
    this.need(8);
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(this.b[this.off + i]!);
    this.off += 8;
    return v;
  }
  str(): string {
    const len = this.u8();
    this.need(len);
    const slice = this.b.subarray(this.off, this.off + len);
    this.off += len;
    return new TextDecoder('utf-8', { fatal: false }).decode(slice);
  }
  blob(): Uint8Array {
    const len = this.u32();
    this.need(len);
    const slice = this.b.slice(this.off, this.off + len);
    this.off += len;
    return slice;
  }
  atEnd(): boolean {
    return this.off === this.b.length;
  }
}

/**
 * Decode wire bytes to a frame + its stream id, or `null` if malformed /
 * unknown / truncated. MUST NOT throw on bad input. Accepts both v1 (streamId
 * implicit 0) and v2 (streamId in header) frames.
 */
export function decodeFrameWithStream(bytes: Uint8Array): DecodedFrame | null {
  try {
    const r = new Reader(bytes);
    if (r.u8() !== MAGIC) return null;
    const version = r.u8();
    let streamId = 0;
    if (version === VERSION) {
      // v2: type is followed by a 1-byte streamId.
      const type = r.u8();
      streamId = r.u8();
      return { frame: readBody(r, type), streamId };
    }
    if (version === V1_VERSION) {
      // v1: no streamId; frame belongs to the default stream 0.
      const type = r.u8();
      return { frame: readBody(r, type), streamId: 0 };
    }
    return null; // unknown version
  } catch {
    return null; // truncated / malformed
  }
}

/** Decode wire bytes to a frame, dropping the stream id. Convenience for
 *  single-stream endpoints that only own stream 0. Equivalent to
 *  `decodeFrameWithStream(bytes)?.frame ?? null`. */
export function decodeFrame(bytes: Uint8Array): Frame | null {
  return decodeFrameWithStream(bytes)?.frame ?? null;
}

function readBody(r: Reader, type: number): Frame {
  switch (type) {
    case FrameType.HELLO: {
      const epoch = r.str();
      const recvEpoch = r.str();
      const recvCursor = r.u64();
      const durFlags = r.u8();
      const maxRetentionMs = r.u64();
      return {
        t: 'hello',
        epoch,
        recvEpoch,
        recvCursor,
        durableSupported: (durFlags & 1) === 1,
        maxRetentionMs,
      };
    }
    case FrameType.DATA: {
      const msgFlags = r.u8();
      const seq = r.u64();
      const ack = r.u64();
      const payload = r.blob();
      const durable = (msgFlags & 1) === 1;
      // bit1 ⇒ a trailing coalesceKey str follows the payload (spec §12).
      if ((msgFlags & 2) === 2) {
        const coalesceKey = r.str();
        return { t: 'data', seq, ack, payload, durable, coalesceKey };
      }
      return { t: 'data', seq, ack, payload, durable };
    }
    case FrameType.ACK:
      return { t: 'ack', ack: r.u64() };
    case FrameType.RESET: {
      const epoch = r.str();
      const oldest = r.u64();
      return { t: 'reset', epoch, oldest };
    }
    case FrameType.HEARTBEAT:
      return { t: 'heartbeat', ack: r.u64() };
    default:
      throw new Short(); // unknown type → caller maps to null
  }
}
