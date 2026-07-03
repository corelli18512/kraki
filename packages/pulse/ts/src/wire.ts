/**
 * Wire codec — binary frame encode/decode. See spec/PROTOCOL.md §5.0 and
 * spec/FIXTURES.md. Pure functions; byte-for-byte identical to the Swift port.
 *
 * Layout (big-endian):
 *   header : u8 magic=0xB1 · u8 version=0x01 · u8 type
 *   str    : u8 len · len UTF-8 bytes
 *   blob   : u32 len · len bytes
 *   u64    : 8 bytes big-endian
 */

import type { Seq } from './types.js';

export const MAGIC = 0xb1;
export const VERSION = 0x01;

export const FrameType = {
  HELLO: 1,
  DATA: 2,
  ACK: 3,
  RESET: 4,
  HEARTBEAT: 5,
} as const;

export type Frame =
  | { t: 'hello'; epoch: string; recvEpoch: string; recvCursor: Seq }
  | { t: 'data'; seq: Seq; ack: Seq; payload: Uint8Array }
  | { t: 'ack'; ack: Seq }
  | { t: 'reset'; epoch: string; oldest: Seq }
  | { t: 'heartbeat'; ack: Seq };

const U64_MAX = (1n << 64n) - 1n;

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
  header(type: number): void {
    this.u8(MAGIC);
    this.u8(VERSION);
    this.u8(type);
  }
  done(): Uint8Array {
    return new Uint8Array(this.parts);
  }
}

export function encodeFrame(f: Frame): Uint8Array {
  const w = new Writer();
  switch (f.t) {
    case 'hello':
      w.header(FrameType.HELLO);
      w.str(f.epoch);
      w.str(f.recvEpoch);
      w.u64(f.recvCursor);
      break;
    case 'data':
      w.header(FrameType.DATA);
      w.u64(f.seq);
      w.u64(f.ack);
      w.blob(f.payload);
      break;
    case 'ack':
      w.header(FrameType.ACK);
      w.u64(f.ack);
      break;
    case 'reset':
      w.header(FrameType.RESET);
      w.str(f.epoch);
      w.u64(f.oldest);
      break;
    case 'heartbeat':
      w.header(FrameType.HEARTBEAT);
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
      (this.b[this.off]! * 0x1000000) +
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
 * Decode wire bytes to a frame, or `null` if malformed / unknown / truncated.
 * MUST NOT throw on bad input.
 */
export function decodeFrame(bytes: Uint8Array): Frame | null {
  try {
    const r = new Reader(bytes);
    if (r.u8() !== MAGIC) return null;
    if (r.u8() !== VERSION) return null;
    const type = r.u8();
    switch (type) {
      case FrameType.HELLO: {
        const epoch = r.str();
        const recvEpoch = r.str();
        const recvCursor = r.u64();
        return { t: 'hello', epoch, recvEpoch, recvCursor };
      }
      case FrameType.DATA: {
        const seq = r.u64();
        const ack = r.u64();
        const payload = r.blob();
        return { t: 'data', seq, ack, payload };
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
        return null; // unknown type
    }
  } catch {
    return null; // truncated / malformed
  }
}
