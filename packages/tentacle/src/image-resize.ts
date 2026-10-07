/**
 * Shared image resize utility — used by the MCP show_image handler AND the pi
 * adapter to downscale oversized images before they reach the model.
 *
 * Models enforce per-side pixel caps (Anthropic ≤2000 px in multi-image
 * requests, Google Gemini similar, OpenAI Vision auto-downscales but bills by
 * tiles). We proactively fit-inside MAX_DIMENSION×MAX_DIMENSION so we never
 * trip an API-side rejection. Aspect ratio is preserved.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Max per-side pixel dimension we'll ship to the model. */
export const MAX_DIMENSION = 2000;

/** Lazily load sharp at first use, not at module import time.
 *  sharp is a native addon (.node) that cannot be bundled into a Node SEA
 *  (single-executable application). Static `import sharp from 'sharp'` would
 *  crash the SEA binary on startup because esbuild bundles the JS wrapper but
 *  not the native binary. Dynamic import defers loading until fitToMaxDimension
 *  is actually called (which only happens when an oversized image is processed). */
let _sharp: typeof import('sharp').default | null = null;
async function getSharp() {
  if (!_sharp) _sharp = (await import('sharp')).default;
  return _sharp;
}

/**
 * If either dimension exceeds {@link MAX_DIMENSION}, resize (fit inside,
 * preserving aspect ratio) using the source's native format. Returns the input
 * unchanged when already within bounds so we don't re-encode unnecessarily.
 * Animated GIFs are preserved (first frame only for resize; `animated:true`
 * keeps all frames when we do resize). Best-effort: returns original on failure.
 */
export async function fitToMaxDimension(
  bytes: Buffer,
  mimeType: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const isGif = mimeType === 'image/gif';
  let meta;
  try {
    const sharp = await getSharp();
    meta = await sharp(bytes, { animated: isGif }).metadata();
  } catch {
    // No sharp: the shipped single-executable build can't load it. macOS
    // has `sips`; elsewhere the image goes unchanged.
    return (await fitWithSips(bytes, mimeType)) ?? { bytes, mimeType };
  }
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w === 0 || h === 0 || Math.max(w, h) <= MAX_DIMENSION) {
    return { bytes, mimeType };
  }

  const sharp = await getSharp();
  const pipeline = sharp(bytes, { animated: isGif }).resize({
    width: MAX_DIMENSION,
    height: MAX_DIMENSION,
    fit: 'inside',
    withoutEnlargement: true,
  });

  try {
    switch (mimeType) {
      case 'image/png':
        return { bytes: await pipeline.png().toBuffer(), mimeType };
      case 'image/jpeg':
        return { bytes: await pipeline.jpeg({ quality: 90 }).toBuffer(), mimeType };
      case 'image/webp':
        return { bytes: await pipeline.webp().toBuffer(), mimeType };
      case 'image/gif':
        return { bytes: await pipeline.gif().toBuffer(), mimeType };
      default:
        return { bytes, mimeType };
    }
  } catch {
    return { bytes, mimeType };
  }
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/**
 * macOS fallback with the built-in `sips` (PNG and JPEG only). Returns null
 * when it doesn't apply or fails, so callers keep the original bytes.
 */
export async function fitWithSips(
  bytes: Buffer,
  mimeType: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (platform !== 'darwin') return null;
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : null;
  if (!ext) return null;
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'kraki-resize-'));
    const input = join(dir, `in.${ext}`);
    const output = join(dir, `out.${ext}`);
    await writeFile(input, bytes);
    const info = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', input]);
    const w = Number(/pixelWidth:\s*(\d+)/.exec(info)?.[1] ?? 0);
    const h = Number(/pixelHeight:\s*(\d+)/.exec(info)?.[1] ?? 0);
    if (w === 0 || h === 0 || Math.max(w, h) <= MAX_DIMENSION) return { bytes, mimeType };
    await run('/usr/bin/sips', ['-Z', String(MAX_DIMENSION), input, '--out', output]);
    return { bytes: await readFile(output), mimeType };
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
