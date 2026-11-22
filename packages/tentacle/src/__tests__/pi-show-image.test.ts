/**
 * Pi show_image (K-292): the image type comes from the file's bytes, a
 * non-image is refused, and an oversized file is refused before it is read.
 * Runs the materialized Kraki pi extension's tool directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PI_KRAKI_TOOLS_SOURCE } from '../adapters/pi-kraki-tools.js';

type Tool = { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<Record<string, unknown>>; details: Record<string, unknown> }> };

let dir: string;
let showImage: Tool;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kraki-pi-show-image-'));
  const extensionPath = join(dir, 'kraki-tools.mjs');
  writeFileSync(extensionPath, PI_KRAKI_TOOLS_SOURCE);
  const tools = new Map<string, Tool>();
  const extension = await import(`${pathToFileURL(extensionPath).href}?test=${randomUUID()}`);
  extension.default({ registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool), on: vi.fn() });
  showImage = tools.get('show_image')!;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0]);
const GIF = Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

function file(name: string, bytes: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe('pi show_image (K-292)', () => {
  it.each([
    ['shot.png', 'image/png', PNG],
    ['photo.jpg', 'image/jpeg', JPEG],
    ['anim.gif', 'image/gif', GIF],
    ['pic.webp', 'image/webp', WEBP],
    // The bytes decide, not the extension.
    ['actually-png.jpg', 'image/png', PNG],
  ])('shows %s as %s', async (name, mimeType, bytes) => {
    const result = await showImage.execute('t1', { path: file(name, bytes) });
    expect(result.content.find((c) => c.type === 'image')).toMatchObject({ mimeType });
    expect(result.details.mimeType).toBe(mimeType);
  });

  it.each([
    ['a text file named .png', 'notimage.png', Buffer.from('hello, not an image')],
    ['a BMP', 'old.bmp', Buffer.from([0x42, 0x4d, 0x3a, 0, 0, 0, 0, 0, 0, 0, 0x36, 0])],
  ])('refuses %s', async (_label, name, bytes) => {
    await expect(showImage.execute('t1', { path: file(name, bytes) })).rejects.toThrow(/not a PNG, JPEG, GIF or WebP image/);
  });

  it('refuses a file over the size cap before reading it', async () => {
    const path = file('huge.png', PNG);
    truncateSync(path, 64 * 1024 * 1024 + 1);
    await expect(showImage.execute('t1', { path })).rejects.toThrow(/too large/);
  });
});
