/**
 * Pure unit tests for the Doubao frame codec.
 *
 * These cover the binary wire format end-to-end (build → parse round-trip)
 * and the candidate-picking helper. They require no network and no creds —
 * they're the safety net for any future changes to the codec.
 */

import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  Compression,
  DoubaoServerError,
  Flags,
  MessageType,
  PROTOCOL_VERSION,
  HEADER_SIZE,
  Serialization,
  buildAudioFrame,
  buildClientConfigFrame,
  buildFrame,
  buildHeader,
  buildServerErrorFrame,
  buildServerResponseFrame,
  defaultClientConfig,
  parseServerFrame,
  pickBestCandidate,
} from '../doubao.js';

describe('buildHeader', () => {
  it('packs version, header-size, message type, flags, serialization, compression', () => {
    const h = buildHeader(MessageType.FULL_CLIENT_REQUEST, Flags.NO_SEQUENCE, Serialization.JSON, Compression.GZIP);
    expect(h.length).toBe(4);
    expect(h[0]).toBe((PROTOCOL_VERSION << 4) | HEADER_SIZE);
    expect(h[1]).toBe((MessageType.FULL_CLIENT_REQUEST << 4) | Flags.NO_SEQUENCE);
    expect(h[2]).toBe((Serialization.JSON << 4) | Compression.GZIP);
    expect(h[3]).toBe(0);
  });
});

describe('buildFrame', () => {
  it('prepends a big-endian 4-byte payload length', () => {
    const frame = buildFrame(
      MessageType.AUDIO_ONLY_REQUEST,
      Flags.NO_SEQUENCE,
      Serialization.NONE,
      Compression.NONE,
      Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    );
    expect(frame.length).toBe(4 + 4 + 4);
    expect(frame.readUInt32BE(4)).toBe(4);
    expect(frame.subarray(8)).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  });
});

describe('buildClientConfigFrame', () => {
  it('produces a gzipped JSON FULL_CLIENT_REQUEST frame', () => {
    const cfg = defaultClientConfig('unit-test');
    const frame = buildClientConfigFrame(cfg);
    // Header byte 1: messageType=1, flags=0
    expect((frame[1] >> 4) & 0x0f).toBe(MessageType.FULL_CLIENT_REQUEST);
    expect(frame[1] & 0x0f).toBe(Flags.NO_SEQUENCE);
    // Header byte 2: serialization=JSON, compression=GZIP
    expect((frame[2] >> 4) & 0x0f).toBe(Serialization.JSON);
    expect(frame[2] & 0x0f).toBe(Compression.GZIP);
  });
});

describe('buildAudioFrame', () => {
  it('marks the last frame with LAST_NO_SEQUENCE', () => {
    const mid = buildAudioFrame(Buffer.alloc(64), false);
    const last = buildAudioFrame(Buffer.alloc(0), true);
    expect(mid[1] & 0x0f).toBe(Flags.NO_SEQUENCE);
    expect(last[1] & 0x0f).toBe(Flags.LAST_NO_SEQUENCE);
  });
});

describe('parseServerFrame', () => {
  it('round-trips a JSON server response via buildServerResponseFrame', () => {
    const payload = {
      code: 20_000_000,
      result: { text: '你好', confidence: 0.9, utterances: [{ text: '你好', definite: true }] },
    };
    const frame = buildServerResponseFrame(payload, { isLast: true, sequence: 42 });
    const parsed = parseServerFrame(frame);
    expect(parsed.messageType).toBe(MessageType.FULL_SERVER_RESPONSE);
    expect(parsed.isLast).toBe(true);
    expect(parsed.sequence).toBe(42);
    expect(parsed.json?.result).toEqual(payload.result);
  });

  it('throws DoubaoServerError on SERVER_ERROR frames', () => {
    const frame = buildServerErrorFrame(45_000_001, 'bad param');
    expect(() => parseServerFrame(frame)).toThrowError(DoubaoServerError);
    try {
      parseServerFrame(frame);
    } catch (err) {
      expect((err as DoubaoServerError).code).toBe(45_000_001);
      expect((err as DoubaoServerError).message).toContain('bad param');
    }
  });

  it('handles non-last sequenced server frames', () => {
    const frame = buildServerResponseFrame({ result: { text: 'partial' } }, { isLast: false, sequence: 1 });
    const parsed = parseServerFrame(frame);
    expect(parsed.isLast).toBe(false);
    expect(parsed.sequence).toBe(1);
  });

  it('throws on truncated frames', () => {
    expect(() => parseServerFrame(Buffer.from([0x11, 0x00, 0x00]))).toThrowError(/too short/);
  });

  it('decodes gzipped payloads correctly', () => {
    // Hand-build a frame with gzip to confirm decompression happens.
    const json = { result: { text: 'manual gzip' } };
    const payload = gzipSync(Buffer.from(JSON.stringify(json), 'utf-8'));
    const header = buildHeader(
      MessageType.FULL_SERVER_RESPONSE,
      Flags.SERVER_SEQUENCE,
      Serialization.JSON,
      Compression.GZIP,
    );
    const seq = Buffer.alloc(4);
    seq.writeUInt32BE(7, 0);
    const sz = Buffer.alloc(4);
    sz.writeUInt32BE(payload.length, 0);
    const frame = Buffer.concat([header, seq, sz, payload]);
    const parsed = parseServerFrame(frame);
    expect(parsed.json?.result).toEqual(json.result);
    expect(parsed.sequence).toBe(7);
  });
});

describe('pickBestCandidate', () => {
  it('returns null for empty input', () => {
    expect(pickBestCandidate(undefined)).toBeNull();
    expect(pickBestCandidate([])).toBeNull();
  });

  it('returns the single object when result is not an array', () => {
    expect(pickBestCandidate({ text: 'solo', confidence: 0.5 })).toEqual({ text: 'solo', confidence: 0.5 });
  });

  it('picks the candidate with the highest confidence (never concatenates)', () => {
    const best = pickBestCandidate([
      { text: 'A', confidence: 0.3 },
      { text: 'B', confidence: 0.9 },
      { text: 'C', confidence: 0.7 },
    ]);
    expect(best?.text).toBe('B');
  });

  it('falls back gracefully when confidence is missing', () => {
    const best = pickBestCandidate([{ text: 'A' }, { text: 'B', confidence: 0.1 }]);
    // First entry wins ties (confidence treated as 0).
    expect(best?.text).toBe('B');
  });
});
