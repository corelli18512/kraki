import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64ImageBlob, downloadImage, imageExtension, imageFileName } from './image-download';

const GIF_BYTES = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00];
const GIF_BASE64 = btoa(String.fromCharCode(...GIF_BYTES));

function bytes(blob: Blob): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve([...new Uint8Array(reader.result as ArrayBuffer)]);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe('imageFileName', () => {
  it('uses the extension of the real type, so a GIF stays a GIF', () => {
    expect(imageExtension('image/gif')).toBe('gif');
    expect(imageExtension('image/jpeg')).toBe('jpg');
    expect(imageExtension('IMAGE/PNG')).toBe('png');
    expect(imageExtension('image/x-icon')).toBe('bin');
    expect(imageExtension('image/avif')).toBe('avif');
    expect(imageFileName('cat.png', 'image/gif')).toBe('cat.gif');
    expect(imageFileName('screenshot.final.JPEG', 'image/png')).toBe('screenshot.final.png');
  });

  it('falls back to kraki-image and keeps captions readable but safe', () => {
    expect(imageFileName(undefined, 'image/gif')).toBe('kraki-image.gif');
    expect(imageFileName('  ', 'image/png')).toBe('kraki-image.png');
    expect(imageFileName('../etc/passwd', 'image/png')).toBe('_etc_passwd.png');
    expect(imageFileName('Login page: before/after?', 'image/png')).toBe('Login page_ before_after_.png');
    expect(imageFileName('Version 1.2 chart', 'image/webp')).toBe('Version 1.2 chart.webp');
    expect(imageFileName('...', 'image/png')).toBe('kraki-image.png');
    // macOS hands out decomposed names; the download name is composed.
    expect(imageFileName('cafe\u0301.png', 'image/png')).toBe('caf\u00e9.png');
    expect(imageFileName('x'.repeat(200), 'image/png')).toBe(`${'x'.repeat(80)}.png`);
  });
});

describe('base64ImageBlob', () => {
  it('is the original bytes with the original type', async () => {
    const blob = base64ImageBlob(GIF_BASE64, 'image/gif');
    expect(blob.type).toBe('image/gif');
    expect(await bytes(blob)).toEqual(GIF_BYTES);
  });
});

describe('downloadImage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('saves exactly the given blob under the given name', () => {
    const blob = base64ImageBlob(GIF_BASE64, 'image/gif');
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => { created.push(b); return 'blob:kraki/1'; });
    URL.revokeObjectURL = vi.fn();
    const clicks: Array<{ href: string; download: string; connected: boolean }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download, connected: this.isConnected });
    });
    vi.useFakeTimers();
    try {
      downloadImage(blob, 'kraki-image.gif');
      expect(created).toEqual([blob]);
      expect(clicks).toEqual([{ href: 'blob:kraki/1', download: 'kraki-image.gif', connected: true }]);
      expect(document.querySelector('a[download]')).toBeNull();
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:kraki/1');
    } finally {
      vi.useRealTimers();
    }
  });
});
