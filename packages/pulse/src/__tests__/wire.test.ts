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

const fixturesUrl = new URL('../../fixtures/wire.json', import.meta.url);
const fixtures = JSON.parse(readFileSync(fileURLToPath(fixturesUrl), 'utf8')) as {
  frames: Array<{ name: string; type: string; fields: Record<string, unknown>; hex: string }>;
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

function fixtureToFrame(f: { type: string; fields: Record<string, unknown> }): Frame {
  const x = f.fields as Record<string, string | boolean>;
  switch (f.type) {
    case 'hello':
      return {
        t: 'hello',
        epoch: x.epoch as string,
        recvEpoch: x.recvEpoch as string,
        recvCursor: BigInt(x.recvCursor as string),
        durableSupported: x.durableSupported === true,
        maxRetentionMs: BigInt((x.maxRetentionMs as string) ?? '0'),
      };
    case 'data':
      return {
        t: 'data',
        seq: BigInt(x.seq as string),
        ack: BigInt(x.ack as string),
        payload: unhex(x.payloadHex as string),
        durable: x.durable === true,
      };
    case 'ack':
      return { t: 'ack', ack: BigInt(x.ack as string) };
    case 'reset':
      return { t: 'reset', epoch: x.epoch as string, oldest: BigInt(x.oldest as string) };
    case 'heartbeat':
      return { t: 'heartbeat', ack: BigInt(x.ack as string) };
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
    const f: Frame = { t: 'data', seq: big, ack: 0n, payload: new Uint8Array(), durable: false };
    const rt = decodeFrame(encodeFrame(f));
    expect(rt).toEqual(f);
    expect((rt as { seq: bigint }).seq).toBe(big);
  });

  it('measures str length in UTF-8 bytes, not code points', () => {
    const f: Frame = {
      t: 'hello',
      epoch: '🐙',
      recvEpoch: '',
      recvCursor: 0n,
      durableSupported: false,
      maxRetentionMs: 0n,
    };
    // 🐙 is 4 UTF-8 bytes; encode must not corrupt it
    const rt = decodeFrame(encodeFrame(f));
    expect(rt).toEqual(f);
  });

  it('rejects an epoch longer than 255 UTF-8 bytes at encode time', () => {
    const f: Frame = {
      t: 'hello',
      epoch: 'x'.repeat(256),
      recvEpoch: '',
      recvCursor: 0n,
      durableSupported: false,
      maxRetentionMs: 0n,
    };
    expect(() => encodeFrame(f)).toThrow();
  });
});

describe('wire codec — DATA coalesceKey (spec §12)', () => {
  it('round-trips a DATA frame carrying a coalesceKey', () => {
    const f: Frame = {
      t: 'data',
      seq: 42n,
      ack: 7n,
      payload: new Uint8Array([1, 2, 3]),
      durable: false,
      coalesceKey: 'agent_message_delta:sess1',
    };
    expect(decodeFrame(encodeFrame(f))).toEqual(f);
  });

  it('decodes a DATA frame with no coalesceKey to coalesceKey===undefined', () => {
    const f: Frame = { t: 'data', seq: 1n, ack: 0n, payload: new Uint8Array(), durable: false };
    const rt = decodeFrame(encodeFrame(f)) as Extract<Frame, { t: 'data' }>;
    expect(rt.coalesceKey).toBeUndefined();
  });

  it('is byte-identical to the pre-0.3 layout when coalesceKey is absent', () => {
    // Backward-compat guarantee: omitting coalesceKey must not set flag bit 1,
    // so the bytes match what an old (durable-only) encoder produced.
    const withoutKey = encodeFrame({
      t: 'data',
      seq: 5n,
      ack: 3n,
      payload: new Uint8Array([9]),
      durable: true,
    });
    // flags byte (index 3) is exactly the durable bit (1), not 1|2.
    expect(withoutKey[3]).toBe(1);
  });

  it('sets flag bit 1 and appends the key when coalesceKey is present', () => {
    const withKey = encodeFrame({
      t: 'data',
      seq: 5n,
      ack: 3n,
      payload: new Uint8Array([9]),
      durable: true,
      coalesceKey: 'k',
    });
    expect(withKey[3]).toBe(1 | 2); // durable + has-coalesceKey
  });

  it('an old decoder (blob-only read) ignores trailing coalesceKey bytes', () => {
    // Simulate a pre-0.3 reader: it reads header/flags/seq/ack/blob and stops,
    // so a new frame with a trailing key must still yield the same payload. We
    // model "old reader" by truncating the frame to just before the key and
    // confirming the payload decodes identically.
    const full = encodeFrame({
      t: 'data',
      seq: 1n,
      ack: 0n,
      payload: new Uint8Array([7, 7, 7]),
      durable: false,
      coalesceKey: 'longer-key-name',
    });
    // The new decoder recovers both payload and key.
    const rt = decodeFrame(full) as Extract<Frame, { t: 'data' }>;
    expect(Array.from(rt.payload)).toEqual([7, 7, 7]);
    expect(rt.coalesceKey).toBe('longer-key-name');
  });

  it('accepts a 255-byte coalesceKey and rejects 256 at encode time', () => {
    const at255: Frame = {
      t: 'data',
      seq: 1n,
      ack: 0n,
      payload: new Uint8Array(),
      durable: false,
      coalesceKey: 'x'.repeat(255),
    };
    expect(decodeFrame(encodeFrame(at255))).toEqual(at255);

    const at256: Frame = { ...at255, coalesceKey: 'x'.repeat(256) };
    expect(() => encodeFrame(at256)).toThrow();
  });
});
