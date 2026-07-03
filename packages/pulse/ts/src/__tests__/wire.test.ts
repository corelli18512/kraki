/**
 * Wire codec conformance — driven by the SHARED fixtures (fixtures/wire.json).
 * The Swift suite loads the same file and must produce identical bytes, which
 * is what guarantees a TS producer and a Swift consumer interoperate on the
 * wire. See spec/FIXTURES.md.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, type Frame } from '../wire.js';

const fixturesUrl = new URL('../../../fixtures/wire.json', import.meta.url);
const fixtures = JSON.parse(readFileSync(fileURLToPath(fixturesUrl), 'utf8')) as {
  frames: Array<{ name: string; type: string; fields: Record<string, string>; hex: string }>;
  malformed: Array<{ name: string; hex: string }>;
};

function hex(u: Uint8Array): string {
  return Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
}
function unhex(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function fixtureToFrame(f: { type: string; fields: Record<string, string> }): Frame {
  const x = f.fields;
  switch (f.type) {
    case 'hello':
      return { t: 'hello', epoch: x.epoch!, recvEpoch: x.recvEpoch!, recvCursor: BigInt(x.recvCursor!) };
    case 'data':
      return { t: 'data', seq: BigInt(x.seq!), ack: BigInt(x.ack!), payload: unhex(x.payloadHex!) };
    case 'ack':
      return { t: 'ack', ack: BigInt(x.ack!) };
    case 'reset':
      return { t: 'reset', epoch: x.epoch!, oldest: BigInt(x.oldest!) };
    case 'heartbeat':
      return { t: 'heartbeat', ack: BigInt(x.ack!) };
    default:
      throw new Error(`unknown fixture type ${f.type}`);
  }
}

describe('wire codec — shared fixtures', () => {
  for (const f of fixtures.frames) {
    it(`encodes ${f.name} to exact bytes`, () => {
      expect(hex(encodeFrame(fixtureToFrame(f)))).toBe(f.hex);
    });

    it(`decodes ${f.name} back to the frame`, () => {
      const decoded = decodeFrame(unhex(f.hex));
      expect(decoded).toEqual(fixtureToFrame(f));
    });

    it(`round-trips ${f.name}`, () => {
      const frame = fixtureToFrame(f);
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    });
  }
});

describe('wire codec — malformed input is ignored, never throws', () => {
  for (const m of fixtures.malformed) {
    it(`returns null for ${m.name}`, () => {
      expect(decodeFrame(unhex(m.hex))).toBeNull();
    });
  }
});

describe('wire codec — 64-bit and UTF-8 edge cases', () => {
  it('preserves a seq beyond Number.MAX_SAFE_INTEGER', () => {
    const big = (1n << 63n) + 12345n;
    const f: Frame = { t: 'data', seq: big, ack: 0n, payload: new Uint8Array() };
    const rt = decodeFrame(encodeFrame(f));
    expect(rt).toEqual(f);
    expect((rt as { seq: bigint }).seq).toBe(big);
  });

  it('measures str length in UTF-8 bytes, not code points', () => {
    const f: Frame = { t: 'hello', epoch: '🐙', recvEpoch: '', recvCursor: 0n };
    // 🐙 is 4 UTF-8 bytes; encode must not corrupt it
    const rt = decodeFrame(encodeFrame(f));
    expect(rt).toEqual(f);
  });

  it('rejects an epoch longer than 255 UTF-8 bytes at encode time', () => {
    const f: Frame = { t: 'hello', epoch: 'x'.repeat(256), recvEpoch: '', recvCursor: 0n };
    expect(() => encodeFrame(f)).toThrow();
  });
});
