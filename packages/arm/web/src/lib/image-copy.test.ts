import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyImage } from './image-copy';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalClipboardItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;

/** What the browser's ClipboardItem keeps: each type's blob (or promise). */
class FakeClipboardItem {
  constructor(readonly items: Record<string, Blob | Promise<Blob>>) {}
}

function setClipboard(value: unknown, item: unknown = FakeClipboardItem) {
  // `item` null: a browser without ClipboardItem (Firefox before 127).
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
  (globalThis as { ClipboardItem?: unknown }).ClipboardItem = item ?? undefined;
}

describe('copyImage', () => {
  let drawn: unknown[];
  beforeEach(() => {
    drawn = [];
    URL.createObjectURL = vi.fn(() => 'blob:copy');
    URL.revokeObjectURL = vi.fn();
    // jsdom decodes and draws nothing: stand in for the browser's image and canvas.
    Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, writable: true, value: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(40);
    vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(20);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      return { drawImage: (image: unknown) => drawn.push([image, this.width, this.height]) } as unknown as RenderingContext;
    } as typeof HTMLCanvasElement.prototype.getContext);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) => callback(new Blob(['png'], { type: type ?? '' })));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = originalClipboardItem;
  });

  it('copies a PNG as it is', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    setClipboard({ write });
    const png = new Blob(['original'], { type: 'image/png' });
    await expect(copyImage(png)).resolves.toBeUndefined();
    const [items] = write.mock.calls[0] as [FakeClipboardItem[]];
    expect(Object.keys(items[0].items)).toEqual(['image/png']);
    expect(await items[0].items['image/png']).toBe(png);
    expect(drawn).toEqual([]);
  });

  it('copies a GIF (or any other type) as a PNG of its first frame, starting the write in the click', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    setClipboard({ write });
    const copied = copyImage(new Blob(['gif'], { type: 'image/gif' }));
    // The write starts synchronously (Safari's user-gesture rule), with the PNG still to come.
    expect(write).toHaveBeenCalledOnce();
    await expect(copied).resolves.toBeUndefined();
    const [items] = write.mock.calls[0] as [FakeClipboardItem[]];
    const png = await items[0].items['image/png'];
    expect(png.type).toBe('image/png');
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toEqual([expect.any(HTMLImageElement), 40, 20]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:copy');
  });

  it('rejects, never throws, without an image clipboard or when the browser refuses', async () => {
    setClipboard(undefined);
    await expect(copyImage(new Blob(['x'], { type: 'image/png' }))).rejects.toThrow('Image clipboard unavailable');
    setClipboard({ writeText: vi.fn() });
    await expect(copyImage(new Blob(['x'], { type: 'image/png' }))).rejects.toThrow('Image clipboard unavailable');
    setClipboard({ write: vi.fn() }, null);
    await expect(copyImage(new Blob(['x'], { type: 'image/png' }))).rejects.toThrow('Image clipboard unavailable');
    setClipboard({ write: vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError')) });
    await expect(copyImage(new Blob(['x'], { type: 'image/png' }))).rejects.toThrow('Denied');
    setClipboard({ write: vi.fn(() => { throw new TypeError('Illegal invocation'); }) });
    await expect(copyImage(new Blob(['x'], { type: 'image/png' }))).rejects.toThrow('Illegal invocation');
  });

  it('rejects when the image cannot be decoded', async () => {
    vi.mocked(HTMLImageElement.prototype.decode).mockRejectedValue(new DOMException('Broken', 'EncodingError'));
    // The browser's write fails with the PNG it was promised.
    const write = vi.fn(async (items: FakeClipboardItem[]) => { await items[0].items['image/png']; });
    setClipboard({ write });
    await expect(copyImage(new Blob(['gif'], { type: 'image/gif' }))).rejects.toThrow('Broken');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:copy');
  });
});
