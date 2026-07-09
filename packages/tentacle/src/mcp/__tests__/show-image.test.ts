import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SHOW_IMAGE_MAX_BYTES,
  showImageHandler,
  showImageTool,
  SHOW_IMAGE_TOOL_NAME,
} from '../tools/show-image.js';
import { MAX_DIMENSION as SHOW_IMAGE_MAX_DIMENSION, fitToMaxDimension } from '../../image-resize.js';
import sharp from 'sharp';

// 1x1 PNG (red pixel), captured as base64 so tests stay tiny.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const PNG_1X1_BYTES = Buffer.from(PNG_1X1, 'base64');

const ctx = { sessionId: 'sess-1' };

describe('show_image tool definition', () => {
  it('declares its name + required argument', () => {
    expect(showImageTool.definition.name).toBe(SHOW_IMAGE_TOOL_NAME);
    expect(showImageTool.definition.inputSchema).toMatchObject({
      type: 'object',
      required: ['path'],
      additionalProperties: false,
    });
  });
});

describe('show_image handler — argument validation', () => {
  it('returns isError when path is missing', async () => {
    const r = await showImageHandler({}, ctx);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('"path"');
  });

  it('returns isError when path is empty string', async () => {
    const r = await showImageHandler({ path: '' }, ctx);
    expect(r.isError).toBe(true);
  });

  it('returns isError when path is not a string', async () => {
    const r = await showImageHandler({ path: 42 as unknown as string }, ctx);
    expect(r.isError).toBe(true);
  });

  it('returns isError when path is relative', async () => {
    const r = await showImageHandler({ path: 'foo.png' }, ctx);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('absolute');
  });
});

describe('show_image handler — filesystem checks', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kraki-mcp-test-'));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('returns isError when file does not exist', async () => {
    const r = await showImageHandler({ path: join(dir, 'missing.png') }, ctx);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('File not found');
  });

  it('returns isError when path is a directory', async () => {
    const r = await showImageHandler({ path: dir }, ctx);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Not a regular file');
  });

  it('returns isError for unsupported extension', async () => {
    const p = join(dir, 'data.bin');
    writeFileSync(p, PNG_1X1_BYTES);
    const r = await showImageHandler({ path: p }, ctx);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Unsupported image type/i);
  });

  it('returns isError when file exceeds size cap', async () => {
    const p = join(dir, 'huge.png');
    // Write SHOW_IMAGE_MAX_BYTES + 1 bytes of zeros — content doesn't matter
    writeFileSync(p, Buffer.alloc(SHOW_IMAGE_MAX_BYTES + 1));
    const r = await showImageHandler({ path: p }, ctx);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/too large/i);
  });

  it('returns isError when file is unreadable', async () => {
    const p = join(dir, 'no-perm.png');
    writeFileSync(p, PNG_1X1_BYTES);
    chmodSync(p, 0o000);
    try {
      const r = await showImageHandler({ path: p }, ctx);
      expect(r.isError).toBe(true);
    } finally {
      chmodSync(p, 0o644);
    }
  });
});

describe('show_image handler — happy paths', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kraki-mcp-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns image content block with correct mime and base64 for PNG', async () => {
    const p = join(dir, 'pixel.png');
    writeFileSync(p, PNG_1X1_BYTES);
    const r = await showImageHandler({ path: p }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toHaveLength(2);
    expect(r.content[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      data: PNG_1X1,
    });
    expect(r.content[1]).toMatchObject({ type: 'text', text: 'Image displayed to user.' });
  });

  it('appends caption to text content when provided', async () => {
    const p = join(dir, 'pixel.png');
    writeFileSync(p, PNG_1X1_BYTES);
    const r = await showImageHandler({ path: p, caption: 'red dot' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe('Image displayed to user. Caption: red dot');
  });

  it('ignores blank/whitespace captions', async () => {
    const p = join(dir, 'pixel.png');
    writeFileSync(p, PNG_1X1_BYTES);
    const r = await showImageHandler({ path: p, caption: '   ' }, ctx);
    expect(textOf(r)).toBe('Image displayed to user.');
  });

  it.each([
    ['image.jpg', 'image/jpeg'],
    ['image.jpeg', 'image/jpeg'],
    ['image.webp', 'image/webp'],
    ['image.gif', 'image/gif'],
  ])('detects mime for %s as %s', async (name, expected) => {
    const p = join(dir, name);
    writeFileSync(p, PNG_1X1_BYTES); // bytes content doesn't matter for mime detection
    const r = await showImageHandler({ path: p }, ctx);
    expect(r.isError).toBeFalsy();
    expect((r.content[0] as { mimeType: string }).mimeType).toBe(expected);
  });

  it('honors PNG extension case-insensitively', async () => {
    const p = join(dir, 'pixel.PNG');
    writeFileSync(p, PNG_1X1_BYTES);
    const r = await showImageHandler({ path: p }, ctx);
    expect(r.isError).toBeFalsy();
    expect((r.content[0] as { mimeType: string }).mimeType).toBe('image/png');
  });
});

function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

describe('show_image handler — downscale', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kraki-mcp-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function makePng(w: number, h: number): Promise<Buffer> {
    return await sharp({
      create: { width: w, height: h, channels: 3, background: { r: 128, g: 64, b: 200 } },
    })
      .png()
      .toBuffer();
  }

  async function pngDim(bytes: Buffer): Promise<{ width: number; height: number }> {
    const m = await sharp(bytes).metadata();
    return { width: m.width ?? 0, height: m.height ?? 0 };
  }

  it('does NOT resize when max dim ≤ SHOW_IMAGE_MAX_DIMENSION (bytes untouched)', async () => {
    const src = await makePng(1024, 1024);
    const out = await fitToMaxDimension(src, 'image/png');
    expect(out.bytes.equals(src)).toBe(true);
    expect(out.mimeType).toBe('image/png');
  });

  it('resizes portrait PNG (1600×2800) to fit inside 2000, preserving aspect', async () => {
    const src = await makePng(1600, 2800);
    const out = await fitToMaxDimension(src, 'image/png');
    const d = await pngDim(out.bytes);
    // Portrait: height caps at 2000, width scales proportionally
    expect(d.height).toBe(SHOW_IMAGE_MAX_DIMENSION);
    expect(d.width).toBe(Math.round((1600 * 2000) / 2800));
    expect(out.mimeType).toBe('image/png');
  });

  it('resizes landscape PNG (2800×1600) to fit inside 2000, preserving aspect', async () => {
    const src = await makePng(2800, 1600);
    const out = await fitToMaxDimension(src, 'image/png');
    const d = await pngDim(out.bytes);
    expect(d.width).toBe(SHOW_IMAGE_MAX_DIMENSION);
    expect(d.height).toBe(Math.round((1600 * 2000) / 2800));
  });

  it('resizes exact boundary (2001×1000) to 2000×1000', async () => {
    const src = await makePng(2001, 1000);
    const out = await fitToMaxDimension(src, 'image/png');
    const d = await pngDim(out.bytes);
    expect(d.width).toBe(2000);
    expect(d.height).toBe(Math.round((1000 * 2000) / 2001));
  });

  it('leaves at-boundary (2000×2000) untouched', async () => {
    const src = await makePng(2000, 2000);
    const out = await fitToMaxDimension(src, 'image/png');
    expect(out.bytes.equals(src)).toBe(true);
  });

  it('re-encodes JPEG as JPEG when oversized', async () => {
    const src = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 200, g: 100, b: 50 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    const out = await fitToMaxDimension(src, 'image/jpeg');
    expect(out.mimeType).toBe('image/jpeg');
    const d = await pngDim(out.bytes);
    expect(d.width).toBe(2000);
    expect(d.height).toBeLessThanOrEqual(2000);
    // JPEG SOI magic
    expect(out.bytes[0]).toBe(0xff);
    expect(out.bytes[1]).toBe(0xd8);
  });

  it('re-encodes WebP as WebP when oversized', async () => {
    const src = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: { r: 0, g: 200, b: 100 } },
    })
      .webp()
      .toBuffer();
    const out = await fitToMaxDimension(src, 'image/webp');
    expect(out.mimeType).toBe('image/webp');
    // RIFF magic + WEBP fourcc
    expect(out.bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(out.bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
  });

  it('returns original bytes when input is malformed (falls back gracefully)', async () => {
    const junk = Buffer.from('this is not an image at all');
    const out = await fitToMaxDimension(junk, 'image/png');
    expect(out.bytes.equals(junk)).toBe(true);
    expect(out.mimeType).toBe('image/png');
  });

  it('handler emits downscaled base64 for oversized PNG on disk', async () => {
    const p = join(dir, 'big.png');
    writeFileSync(p, await makePng(2400, 1200));
    const r = await showImageHandler({ path: p }, ctx);
    expect(r.isError).toBeFalsy();
    const item = r.content[0] as { type: string; mimeType: string; data: string };
    expect(item.mimeType).toBe('image/png');
    const decoded = Buffer.from(item.data, 'base64');
    const d = await pngDim(decoded);
    expect(d.width).toBe(2000);
    expect(d.height).toBe(1000);
  });
});
