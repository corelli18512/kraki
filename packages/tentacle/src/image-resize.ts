/**
 * Shared image resize utility — used by the MCP show_image handler AND the pi
 * adapter to downscale oversized images before they reach the model.
 *
 * Models enforce per-side pixel caps (Anthropic ≤2000 px in multi-image
 * requests, Google Gemini similar, OpenAI Vision auto-downscales but bills by
 * tiles). We proactively fit-inside MAX_DIMENSION×MAX_DIMENSION so we never
 * trip an API-side rejection. Aspect ratio is preserved.
 */

import sharp from 'sharp';

/** Max per-side pixel dimension we'll ship to the model. */
export const MAX_DIMENSION = 2000;

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
    meta = await sharp(bytes, { animated: isGif }).metadata();
  } catch {
    return { bytes, mimeType };
  }
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w === 0 || h === 0 || Math.max(w, h) <= MAX_DIMENSION) {
    return { bytes, mimeType };
  }

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
