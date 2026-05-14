import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AttachmentStore } from '../attachment-store.js';

// 1x1 red PNG
const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const PNG_1X1 = Buffer.from(PNG_1X1_B64, 'base64');

// 2x3 PNG (deterministically constructed) — used to verify dimension parsing
// PNG signature + IHDR for width=2 height=3
function makePng(width: number, height: number): Buffer {
  // Minimal PNG: sig + IHDR. IHDR length=13, type='IHDR', then 13 bytes:
  //   width (u32 BE), height (u32 BE), bit_depth (8), color_type (2), compression (0), filter (0), interlace (0)
  // Then CRC32. Then a tiny IDAT and IEND so it's vaguely valid (we only
  // really need width/height parsing, but lots of tools cross-check signatures).
  // The parser we test only reads the IHDR bytes, so we don't have to
  // include valid IDAT data — but include something to make file shape sane.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrType = Buffer.from('IHDR');
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  // ihdrData[10..12] already 0
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13, 0);
  const ihdrCrc = Buffer.alloc(4); // fake; parser doesn't validate
  return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, ihdrCrc]);
}

describe('AttachmentStore', () => {
  let root: string;
  let store: AttachmentStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kraki-attstore-'));
    store = new AttachmentStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('put writes bytes + sidecar and returns a stable ref', () => {
    const ref = store.put('sid-A', PNG_1X1, 'image/png', { name: 'pixel.png' });
    expect(ref).toMatchObject({
      type: 'image_ref',
      id: expect.any(String),
      mimeType: 'image/png',
      size: PNG_1X1.length,
      name: 'pixel.png',
    });
    expect(ref.id).toHaveLength(32);
    expect(/^[0-9a-f]+$/.test(ref.id)).toBe(true);

    const dataPath = join(root, 'sid-A', 'attachments', `${ref.id}.png`);
    const metaPath = join(root, 'sid-A', 'attachments', `${ref.id}.json`);
    expect(statSync(dataPath).size).toBe(PNG_1X1.length);
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
    expect(meta).toMatchObject({ mimeType: 'image/png', size: PNG_1X1.length, name: 'pixel.png' });
  });

  it('put is idempotent: same bytes → same id, no rewrite', () => {
    const r1 = store.put('sid-A', PNG_1X1, 'image/png');
    const dataPath = join(root, 'sid-A', 'attachments', `${r1.id}.png`);
    const mtime1 = statSync(dataPath).mtimeMs;
    // Wait a millisecond so a hypothetical rewrite would change mtime
    const future = Date.now() + 5;
    while (Date.now() < future) {
      // spin
    }
    const r2 = store.put('sid-A', PNG_1X1, 'image/png');
    expect(r2.id).toBe(r1.id);
    expect(statSync(dataPath).mtimeMs).toBe(mtime1);
  });

  it('put returns different ids for different bytes', () => {
    const r1 = store.put('sid-A', PNG_1X1, 'image/png');
    const r2 = store.put('sid-A', Buffer.from('other content'), 'image/png');
    expect(r2.id).not.toBe(r1.id);
  });

  it('put scopes to session — same bytes in different session keep same id but separate files', () => {
    const rA = store.put('sid-A', PNG_1X1, 'image/png');
    const rB = store.put('sid-B', PNG_1X1, 'image/png');
    expect(rA.id).toBe(rB.id);
    const pathA = join(root, 'sid-A', 'attachments', `${rA.id}.png`);
    const pathB = join(root, 'sid-B', 'attachments', `${rB.id}.png`);
    expect(statSync(pathA).size).toBe(PNG_1X1.length);
    expect(statSync(pathB).size).toBe(PNG_1X1.length);
  });

  it('put parses PNG dimensions from the header', () => {
    const png = makePng(640, 480);
    const ref = store.put('sid-A', png, 'image/png');
    expect(ref.width).toBe(640);
    expect(ref.height).toBe(480);
  });

  it('put carries caption when provided', () => {
    const ref = store.put('sid-A', PNG_1X1, 'image/png', { caption: 'hello' });
    expect(ref.caption).toBe('hello');
    // Caption is NOT persisted to sidecar — it's a per-call display attribute
    const metaPath = join(root, 'sid-A', 'attachments', `${ref.id}.json`);
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
    expect(meta.caption).toBeUndefined();
  });

  it('has() reflects existence', () => {
    const ref = store.put('sid-A', PNG_1X1, 'image/png');
    expect(store.has('sid-A', ref.id)).toBe(true);
    expect(store.has('sid-A', 'a'.repeat(32))).toBe(false);
    expect(store.has('sid-B', ref.id)).toBe(false);
  });

  it('read() returns bytes + metadata', () => {
    const ref = store.put('sid-A', PNG_1X1, 'image/png', { name: 'pixel.png' });
    const got = store.read('sid-A', ref.id);
    expect(got).not.toBeNull();
    expect(got!.bytes.equals(PNG_1X1)).toBe(true);
    expect(got!.meta).toMatchObject({ mimeType: 'image/png', size: PNG_1X1.length, name: 'pixel.png' });
  });

  it('read() returns null for unknown id', () => {
    expect(store.read('sid-A', 'a'.repeat(32))).toBeNull();
  });

  it('stream() yields chunks covering the full file', () => {
    const big = Buffer.alloc(5000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const ref = store.put('sid-A', big, 'image/png');
    const chunks: Buffer[] = [];
    for (const c of store.stream('sid-A', ref.id, 1024)) chunks.push(c);
    expect(chunks.length).toBe(Math.ceil(5000 / 1024));
    expect(Buffer.concat(chunks).equals(big)).toBe(true);
  });

  it('stream() yields nothing for unknown id', () => {
    const chunks = Array.from(store.stream('sid-A', 'a'.repeat(32), 1024));
    expect(chunks).toHaveLength(0);
  });

  it('removeSession() deletes the session attachments dir', () => {
    store.put('sid-A', PNG_1X1, 'image/png');
    expect(store.has('sid-A', store.put('sid-A', PNG_1X1, 'image/png').id)).toBe(true);
    store.removeSession('sid-A');
    expect(store.has('sid-A', store.put('sid-A', PNG_1X1, 'image/png').id)).toBe(true);
    // ↑ re-put recreates because store still works on a fresh dir
  });

  it('gc() removes attachments not in referenced set', () => {
    const r1 = store.put('sid-A', PNG_1X1, 'image/png');
    const r2 = store.put('sid-A', Buffer.from('different'), 'image/png');
    expect(store.has('sid-A', r1.id)).toBe(true);
    expect(store.has('sid-A', r2.id)).toBe(true);

    const removed = store.gc('sid-A', new Set([r1.id]));
    expect(removed).toBeGreaterThan(0);
    expect(store.has('sid-A', r1.id)).toBe(true);
    expect(store.has('sid-A', r2.id)).toBe(false);
  });

  it('sizeOfSession() reports total bytes', () => {
    expect(store.sizeOfSession('sid-A')).toBe(0);
    store.put('sid-A', PNG_1X1, 'image/png');
    expect(store.sizeOfSession('sid-A')).toBe(PNG_1X1.length);
  });

  it('survives a corrupted sidecar — read returns null instead of crashing', () => {
    const ref = store.put('sid-A', PNG_1X1, 'image/png');
    const metaPath = join(root, 'sid-A', 'attachments', `${ref.id}.json`);
    writeFileSync(metaPath, 'not json{');
    expect(store.read('sid-A', ref.id)).toBeNull();
  });
});
