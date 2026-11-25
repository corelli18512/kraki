import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayImageBlob, displayImageDataUrl, gifLoopInfo, inlineDisplayBlob, loopingGifBytes } from './gif-loop';

// Real GIFs from different encoders (ffmpeg, Pillow, a hand-written one for
// layouts encoders rarely produce): see __fixtures__/gifs.
const FIXTURES = join(__dirname, '__fixtures__', 'gifs');
const gif = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const NETSCAPE_FOREVER = [0x21, 0xff, 0x0b, ...Array.from('NETSCAPE2.0', (c) => c.charCodeAt(0)), 0x03, 0x01, 0x00, 0x00, 0x00];

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** The inserted block sits right after the global colour table; every
 *  other byte is the original's (the version becomes 89a). */
function expectLoopBlockInserted(original: Uint8Array, looping: Uint8Array) {
  const start = gifLoopInfo(original)!.blocksStart;
  expect(looping.length).toBe(original.length + NETSCAPE_FOREVER.length);
  expect([...looping.subarray(0, 6)]).toEqual([...'GIF89a'].map((c) => c.charCodeAt(0)));
  expect([...looping.subarray(6, start)]).toEqual([...original.subarray(6, start)]);
  expect([...looping.subarray(start, start + NETSCAPE_FOREVER.length)]).toEqual(NETSCAPE_FOREVER);
  expect([...looping.subarray(start + NETSCAPE_FOREVER.length)]).toEqual([...original.subarray(start)]);
  const info = gifLoopInfo(looping)!;
  expect(info.hasLoopCount).toBe(true);
  expect(info.frameCount).toBe(gifLoopInfo(original)!.frameCount);
}

describe('loopingGifBytes', () => {
  it.each([
    ['ffmpeg-no-loop.gif', 3],
    ['pillow-no-loop.gif', 3],
    ['gif87a-no-loop.gif', 3],
    ['local-tables-interlaced-no-loop.gif', 3],
    ['netscape-buffering-only.gif', 3],
    ['truncated-no-loop.gif', 3],
  ])('makes %s (no loop count) loop forever', (name, frames) => {
    const original = gif(name);
    expect(gifLoopInfo(original)).toMatchObject({ hasLoopCount: false, frameCount: frames });
    expectLoopBlockInserted(original, loopingGifBytes(original));
  });

  it.each([
    'ffmpeg-loop-forever.gif',
    'pillow-loop-forever.gif',
    'pillow-loop-3.gif',
    'animexts-loop-1.gif',
    'loop-block-after-first-frame.gif',
  ])('keeps %s, which sets its own loop count, as it is', (name) => {
    const original = gif(name);
    expect(gifLoopInfo(original)?.hasLoopCount).toBe(true);
    expect(loopingGifBytes(original)).toBe(original);
  });

  it('keeps a single-frame GIF and anything that is not a GIF', () => {
    const single = gif('single-frame.gif');
    expect(gifLoopInfo(single)).toMatchObject({ hasLoopCount: false, frameCount: 1 });
    expect(loopingGifBytes(single)).toBe(single);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48]);
    expect(gifLoopInfo(png)).toBeNull();
    expect(loopingGifBytes(png)).toBe(png);
    const header = gif('pillow-no-loop.gif').subarray(0, 10);
    expect(loopingGifBytes(header)).toBe(header);
  });

  it('covers every fixture', () => {
    expect(readdirSync(FIXTURES).filter((name) => name.endsWith('.gif')).sort()).toEqual([
      'animexts-loop-1.gif', 'ffmpeg-loop-forever.gif', 'ffmpeg-no-loop.gif', 'gif87a-no-loop.gif',
      'local-tables-interlaced-no-loop.gif', 'loop-block-after-first-frame.gif', 'netscape-buffering-only.gif',
      'pillow-loop-3.gif', 'pillow-loop-forever.gif', 'pillow-no-loop.gif', 'single-frame.gif', 'truncated-no-loop.gif',
    ]);
  });
});

describe('display copies', () => {
  it('shows an inline GIF without a loop count looping, and anything else unchanged', () => {
    const original = gif('ffmpeg-no-loop.gif');
    const url = displayImageDataUrl('image/gif', toBase64(original));
    expect(url.startsWith('data:image/gif;base64,')).toBe(true);
    const shown = Uint8Array.from(atob(url.slice('data:image/gif;base64,'.length)), (c) => c.charCodeAt(0));
    expectLoopBlockInserted(original, shown);

    const looping = toBase64(gif('pillow-loop-3.gif'));
    expect(displayImageDataUrl('image/gif', looping)).toBe(`data:image/gif;base64,${looping}`);
    expect(displayImageDataUrl('image/png', 'iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(displayImageDataUrl('image/gif', 'R0lGODlh%%%')).toBe('data:image/gif;base64,R0lGODlh%%%');
  });

  it('gives a looping blob to display and keeps the original for saving', async () => {
    const original = gif('pillow-no-loop.gif');
    const blob = new Blob([original], { type: 'image/gif' });
    const display = displayImageBlob(original, blob);
    expect(display).not.toBe(blob);
    expect(display.type).toBe('image/gif');
    expectLoopBlockInserted(original, await blobBytes(display));
    expect([...await blobBytes(blob)]).toEqual([...original]);

    const inline = inlineDisplayBlob(toBase64(original), blob);
    expectLoopBlockInserted(original, await blobBytes(inline!));
    expect(inlineDisplayBlob(toBase64(gif('ffmpeg-loop-forever.gif')), blob)).toBeUndefined();
    const loops = gif('ffmpeg-loop-forever.gif');
    const loopsBlob = new Blob([loops], { type: 'image/gif' });
    expect(displayImageBlob(loops, loopsBlob)).toBe(loopsBlob);
  });
});
