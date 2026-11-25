/**
 * Kraki loops a GIF forever unless the GIF itself says how often to play.
 *
 * A GIF's loop count lives in an application extension block (NETSCAPE2.0,
 * or its ANIMEXTS1.0 twin): a count of 0 loops forever, a count n plays the
 * animation n more times after the first pass (n + 1 passes; Chromium,
 * WebKit and Firefox agree, and Apple's ImageIO reports n + 1). Browsers play
 * a GIF without that block once; Kraki loops it forever on every client
 * (the Apple clients' ChatGIFAnimation does the same).
 *
 * For display only, such a GIF gets a loop-forever block inserted after its
 * global colour table. Download and Copy keep the original bytes.
 */

import { base64ImageBytes } from './image-download';

const LOOP_FOREVER_EXTENSION = new Uint8Array([
  0x21, 0xff, 0x0b, // application extension, 11-byte identifier block
  ...Array.from('NETSCAPE2.0', (c) => c.charCodeAt(0)),
  0x03, 0x01, 0x00, 0x00, // loop sub-block: count 0 = forever
  0x00, // block terminator
]);

const LOOP_IDENTIFIERS = ['NETSCAPE2.0', 'ANIMEXTS1.0'];

/** The structure that matters here: whether the GIF names a loop count, and
 *  where its blocks start (after the header, logical screen descriptor and
 *  global colour table). Null when the bytes are not a GIF. */
export interface GifLoopInfo {
  hasLoopCount: boolean;
  frameCount: number;
  blocksStart: number;
}

function isGifSignature(bytes: Uint8Array): boolean {
  // "GIF87a" / "GIF89a"
  return bytes.length >= 13 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
    && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;
}

/** Index after the data sub-blocks starting at `at` (past their terminator),
 *  or the length when the file ends first. */
function skipSubBlocks(bytes: Uint8Array, at: number): number {
  let i = at;
  while (i < bytes.length && bytes[i] !== 0) i += bytes[i] + 1;
  return Math.min(bytes.length, i + 1);
}

function isLoopExtension(bytes: Uint8Array, at: number): boolean {
  // 21 FF 0B <11-byte identifier>, then data sub-blocks: the one with id 1
  // (03 01 <count u16>) is the loop count. Id 2 of NETSCAPE2.0 is a
  // buffering hint, not a loop count, and may come first.
  if (bytes[at + 2] !== 0x0b || at + 14 > bytes.length) return false;
  const identifier = String.fromCharCode(...bytes.subarray(at + 3, at + 14));
  if (!LOOP_IDENTIFIERS.includes(identifier)) return false;
  for (let i = at + 14; i + 1 < bytes.length && bytes[i] !== 0; i += bytes[i] + 1) {
    if (bytes[i] >= 3 && bytes[i + 1] === 0x01) return true;
  }
  return false;
}

/** Walks the GIF's blocks (never its compressed pixels): a truncated or
 *  damaged GIF is read up to where it breaks. */
export function gifLoopInfo(bytes: Uint8Array): GifLoopInfo | null {
  if (!isGifSignature(bytes)) return null;
  const screen = bytes[10];
  const blocksStart = 13 + (screen & 0x80 ? 3 * (1 << ((screen & 0x07) + 1)) : 0);
  let hasLoopCount = false;
  let frameCount = 0;
  let i = blocksStart;
  while (i < bytes.length) {
    const introducer = bytes[i];
    if (introducer === 0x21) {
      if (bytes[i + 1] === 0xff && isLoopExtension(bytes, i)) hasLoopCount = true;
      i = skipSubBlocks(bytes, i + 2);
    } else if (introducer === 0x2c) {
      if (i + 10 > bytes.length) break;
      frameCount++;
      const image = bytes[i + 9];
      const localTable = image & 0x80 ? 3 * (1 << ((image & 0x07) + 1)) : 0;
      // Image descriptor, local colour table, LZW minimum code size, pixels.
      i = skipSubBlocks(bytes, i + 10 + localTable + 1);
    } else {
      break; // trailer (0x3B) or bytes that are not GIF blocks
    }
  }
  return { hasLoopCount, frameCount, blocksStart: Math.min(blocksStart, bytes.length) };
}

/**
 * The bytes to display: an animated GIF without a loop count gets a
 * loop-forever block (and the GIF89a signature extension blocks belong to).
 * Anything else — not a GIF, a single frame, a GIF that sets its own loop
 * count — is returned as is (the same array).
 */
export function loopingGifBytes(bytes: Uint8Array): Uint8Array {
  const info = gifLoopInfo(bytes);
  if (!info || info.hasLoopCount || info.frameCount < 2) return bytes;
  const out = new Uint8Array(bytes.length + LOOP_FOREVER_EXTENSION.length);
  out.set(bytes.subarray(0, info.blocksStart), 0);
  out[4] = 0x39; // GIF87a -> GIF89a
  out.set(LOOP_FOREVER_EXTENSION, info.blocksStart);
  out.set(bytes.subarray(info.blocksStart), info.blocksStart + LOOP_FOREVER_EXTENSION.length);
  return out;
}

function bytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** "R0lGOD" is base64 for "GIF8": the only images that can need a loop block. */
function mayBeGif(base64: string): boolean {
  return base64.startsWith('R0lGOD');
}

/** `data:` URL to display an inline (base64) image: the same image, looping
 *  forever when it is an animated GIF without a loop count. */
export function displayImageDataUrl(mimeType: string, data: string): string {
  if (mayBeGif(data)) {
    const bytes = base64ImageBytes(data);
    const looping = bytes && loopingGifBytes(bytes);
    if (looping && looping !== bytes) return `data:image/gif;base64,${bytesBase64(looping)}`;
  }
  return `data:${mimeType};base64,${data}`;
}

/** The blob to display for an image's original `bytes` (`original` is
 *  their Blob): `original` unless it is a GIF that needs a loop block. */
export function displayImageBlob(bytes: Uint8Array, original: Blob): Blob {
  const looping = loopingGifBytes(bytes);
  return looping === bytes ? original : new Blob([looping as Uint8Array<ArrayBuffer>], { type: 'image/gif' });
}

/** The blob to display for an inline (base64) image when it differs from
 *  its `original` bytes (a GIF made to loop), else undefined. */
export function inlineDisplayBlob(data: string, original: Blob): Blob | undefined {
  if (!mayBeGif(data)) return undefined;
  const bytes = base64ImageBytes(data);
  const display = bytes && displayImageBlob(bytes, original);
  return display && display !== original ? display : undefined;
}
