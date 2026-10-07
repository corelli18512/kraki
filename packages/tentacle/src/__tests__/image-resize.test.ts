import { describe, expect, it } from 'vitest';
import { fitWithSips, MAX_DIMENSION } from '../image-resize.js';

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
