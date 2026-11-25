import { describe, expect, it } from 'vitest';
import { fitToMaxDimension, fitWithSips, MAX_DIMENSION } from '../image-resize.js';

// A real 2400×10 PNG would need an encoder; sips can make one from a tiny
// seed on macOS, so the end-to-end check runs only there.
describe('fitWithSips (macOS fallback when sharp is unavailable)', () => {
  it('does nothing off macOS or for other formats', async () => {
    expect(await fitWithSips(Buffer.from('x'), 'image/png', 'linux')).toBeNull();
    expect(await fitWithSips(Buffer.from('x'), 'image/gif', 'darwin')).toBeNull();
  });

  it('keeps the original bytes when sips cannot read them', async () => {
    const original = Buffer.from('not an image');
    const result = await fitWithSips(original, 'image/png', 'darwin');
    expect(result === null || result.bytes === original).toBe(true);
  });

  it.runIf(process.platform === 'darwin')('downscales an oversized PNG to the max dimension', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'kraki-sips-test-'));
    // 1×1 PNG seed, then let sips pad it to 2400×100.
    const seed = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    writeFileSync(join(dir, 'seed.png'), seed);
    execFileSync('/usr/bin/sips', ['-p', '100', '2400', join(dir, 'seed.png'), '--out', join(dir, 'big.png')], { stdio: 'ignore' });
    const big = readFileSync(join(dir, 'big.png'));
    const result = await fitWithSips(big, 'image/png', 'darwin');
    expect(result).not.toBeNull();
    writeFileSync(join(dir, 'out.png'), result!.bytes);
    const info = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', join(dir, 'out.png')]).toString();
    expect(Number(/pixelWidth:\s*(\d+)/.exec(info)?.[1])).toBe(MAX_DIMENSION);
  });
});

describe('fitToMaxDimension keeps animated GIFs as they are', () => {
  async function animatedGif(width: number, height: number, frames: number): Promise<Buffer> {
    const sharp = (await import('sharp')).default;
    const pages = await Promise.all(Array.from({ length: frames }, (_, i) =>
      sharp({ create: { width, height, channels: 3, background: { r: (i * 40) % 256, g: 90, b: 200 } } }).png().toBuffer()));
    return sharp(pages, { join: { animated: true } }).gif({ delay: pages.map(() => 80), loop: 0 }).toBuffer();
  }

  it('does not re-encode a small GIF whose frames stack taller than the limit', async () => {
    // 30 frames of 200×120: stacked 3600 px high, each frame far below 2000.
    const gif = await animatedGif(200, 120, 30);
    const result = await fitToMaxDimension(gif, 'image/gif');
    expect(result.mimeType).toBe('image/gif');
    // The very same buffer: never decoded and re-encoded.
    expect(result.bytes).toBe(gif);
  });

  it('still downsizes a GIF whose frames are over the limit, keeping every frame', async () => {
    const sharp = (await import('sharp')).default;
    const gif = await animatedGif(2400, 600, 3);
    const result = await fitToMaxDimension(gif, 'image/gif');
    const meta = await sharp(result.bytes, { animated: true }).metadata();
    expect(result.mimeType).toBe('image/gif');
    expect(meta.width).toBe(MAX_DIMENSION);
    expect(meta.pages).toBe(3);
    expect(meta.pageHeight).toBe(500);
  });
});
