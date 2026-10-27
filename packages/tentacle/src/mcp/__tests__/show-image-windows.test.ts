import { describe, expect, it, vi } from 'vitest';

import { showImageHandler } from '../tools/show-image.js';

// Exercise Windows path semantics on every CI host, without a Windows disk.
vi.mock('node:path', async (importOriginal) => {
  const path = await importOriginal<typeof import('node:path')>();
  return { ...path, isAbsolute: path.win32.isAbsolute, extname: path.win32.extname };
});

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ isFile: () => true, size: 5 })),
  readFileSync: vi.fn(() => Buffer.from('image')),
}));

vi.mock('../../image-resize.js', () => ({
  fitToMaxDimension: vi.fn(async (bytes: Buffer, mimeType: string) => ({ bytes, mimeType })),
}));

const ctx = { sessionId: 'windows-path-regression' };

describe('show_image — Windows absolute paths (#114)', () => {
  it.each([
    String.raw`C:\Users\alice\Pictures\image.png`,
    'C:/Users/alice/Pictures/image.png',
    String.raw`\\server\share\image.png`,
  ])('displays %s', async (path) => {
    const result = await showImageHandler({ path }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('image').toString('base64'),
    });
  });

  it.each([
    String.raw`C:Pictures\image.png`,
    String.raw`Pictures\image.png`,
  ])('rejects relative path %s', async (path) => {
    const result = await showImageHandler({ path }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'Argument "path" must be an absolute path.' },
    ]);
  });
});
