import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { HtmlArtifactCards, ImageAttachments, refImageSize, htmlArtifactTitle } from './Attachments';
import { ImagePreviewProvider } from './ImageViewer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useStore } from '../../hooks/useStore';

const state = vi.hoisted(() => ({ status: 'loading', url: null as string | null, error: null as string | null, retry: vi.fn() }));
vi.mock('../../hooks/useAttachment', () => ({ useAttachment: () => state }));
const stored = vi.hoisted(() => new Map<string, { kind: 'ready'; mimeType: string; blob: Blob; display?: Blob }>());
vi.mock('../../lib/attachments', async (original) => ({ ...await original<object>(), getState: (id: string) => stored.get(id) }));
const ref = { type: 'content_ref' as const, id: 'image', mimeType: 'image/png', size: 2048, width: 800, height: 400, name: 'Image' };
const image = { type: 'image' as const, mimeType: 'image/png', data: 'AAAA' };
beforeEach(() => {
  state.status = 'loading'; state.url = null; state.error = null; state.retry.mockClear();
  // The viewer shows each image from its own object URL (jsdom has none).
  URL.createObjectURL = vi.fn(() => 'blob:viewer');
  URL.revokeObjectURL = vi.fn();
});

describe('ImageAttachments', () => {
  it('uses proportional metadata sizes and a square fallback, never exceeds 192px', () => {
    expect(refImageSize(ref)).toMatchObject({ width: 360, height: 180 });
    expect(refImageSize({ ...ref, width: 400, height: 800 })).toMatchObject({ width: 96, height: 192 });
    expect(refImageSize({ ...ref, width: undefined, height: undefined })).toMatchObject({ width: 192, height: 192 });
    expect(refImageSize({ ...ref, width: undefined })).toMatchObject({ width: 192, height: 192 });
  });
  it('shows spinner-only loading and a retryable error with the reason', () => {
    const { rerender } = render(<ImageAttachments attachments={[ref]} sessionId="s1" />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
    expect(screen.queryByText('Image')).not.toBeInTheDocument();
    state.status = 'error'; state.error = 'Offline';
    rerender(<ImageAttachments attachments={[ref]} sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: /Offline Click to retry/ }));
    expect(state.retry).toHaveBeenCalledOnce();
  });
  it('stacks multi-image cards and shows the total for counts below and above four', () => {
    const { container, rerender } = render(<ImageAttachments attachments={[image, image]} />);
    expect(screen.getByText('2')).toHaveClass('kimage-count');
    expect(container.querySelector('.kimage-stack')).toHaveStyle({ height: '192px' });
    rerender(<ImageAttachments attachments={[image, image, image, image, image]} />);
    expect(screen.getByText('5')).toHaveClass('kimage-count');
    expect(container.querySelector('.kimage-stack')).toHaveStyle({ height: '200px' });
    expect(container.querySelectorAll('.kimage-stack-card')).toHaveLength(5);
  });
  it('opens all gallery items in the pane-owned preview with bounded navigation and fit/zoom', () => {
    render(<div data-testid="pane"><ImagePreviewProvider><ImageAttachments attachments={[image, image]} /></ImagePreviewProvider></div>);
    fireEvent.click(screen.getAllByRole('button', { name: 'Open image gallery' })[0]);
    expect(screen.getByRole('dialog')).toHaveClass('kimage-viewer');
    expect(screen.getByRole('button', { name: 'Previous image' })).toBeDisabled();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(screen.getByText('Image 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next image' })).toBeDisabled();
    for (let i = 0; i < 20; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('8.0×')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fit to window' }));
    expect(screen.getByText('1.0×')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('HtmlArtifactCards', () => {
  it('uses decimal file sizes and Report wording', () => {
    expect(htmlArtifactTitle({ ...ref, caption: '  ', name: '  ' })).toBe('Report');
    const open = vi.fn();
    render(<HtmlArtifactCards artifacts={[{ ...ref, mimeType: 'text/html', caption: 'Report title', size: 167_000 }]} onOpen={open} />);
    expect(screen.getByText('Report · 167 KB')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open report Report title' }));
    expect(open).toHaveBeenCalledOnce();
  });
});

describe('Saving images', () => {
  const GIF = 'R0lGODlhAQABAAAAACw=';
  const gif = { type: 'image' as const, mimeType: 'image/gif', data: GIF };
  let saved: Array<{ blob: Blob; name: string }>;
  beforeEach(() => {
    saved = [];
    stored.clear();
    let made: Blob | undefined;
    URL.createObjectURL = vi.fn((blob: Blob) => { made = blob; return `blob:test/${saved.length}`; });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      if (this.download && made) saved.push({ blob: made, name: this.download });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  function read(blob: Blob): Promise<string> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(blob);
    });
  }

  it('shows a GIF from its original bytes, so it animates', () => {
    render(<ImageAttachments attachments={[gif]} />);
    expect(screen.getByRole('img')).toHaveAttribute('src', `data:image/gif;base64,${GIF}`);
  });

  it('downloads the original GIF from the viewer', async () => {
    render(<ImagePreviewProvider><ImageAttachments attachments={[gif]} /></ImagePreviewProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open image preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download image' }));
    expect(saved.map((s) => s.name)).toEqual(['kraki-image.gif']);
    expect(saved[0].blob.type).toBe('image/gif');
    expect(await read(saved[0].blob)).toBe(GIF);
  });

  it('right-click on an image offers Download Image, without opening the viewer', async () => {
    render(<ImagePreviewProvider><ImageAttachments attachments={[{ ...gif, name: 'party.png' }]} /></ImagePreviewProvider>);
    const tile = screen.getByRole('button', { name: 'Open image preview' });
    const event = createEvent.contextMenu(tile, { clientX: 20, clientY: 30 });
    fireEvent(tile, event);
    expect(event.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download Image' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(saved.map((s) => s.name)).toEqual(['party.gif']);
    expect(await read(saved[0].blob)).toBe(GIF);
    // Keyboard: the menu key on the focused image.
    fireEvent.keyDown(tile, { key: 'ContextMenu' });
    expect(screen.getByRole('menuitem', { name: 'Download Image' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(tile).toHaveFocus();
  });

  it('opens the viewer without Download, and keeps the browser menu, for malformed inline base64', () => {
    render(<ImagePreviewProvider><ImageAttachments attachments={[{ ...gif, data: 'not base64!*' }]} /></ImagePreviewProvider>);
    const tile = screen.getByRole('button', { name: 'Open image preview' });
    const event = createEvent.contextMenu(tile);
    fireEvent(tile, event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(tile);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download image' })).not.toBeInTheDocument();
  });

  it('saves a loaded agent image under its name with its real type', async () => {
    const blob = new Blob([Uint8Array.from(atob(GIF), (c) => c.charCodeAt(0))], { type: 'image/gif' });
    stored.set('anim', { kind: 'ready', mimeType: 'image/gif', blob });
    state.status = 'ready'; state.url = 'blob:tile';
    render(<ImageAttachments attachments={[{ ...ref, id: 'anim', mimeType: 'image/gif', name: undefined, caption: 'Build status' }]} sessionId="s1" />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open image preview' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download Image' }));
    expect(saved).toEqual([{ blob, name: 'Build status.gif' }]);
  });

  it('leaves the browser menu alone until an agent image has loaded', () => {
    state.status = 'ready'; state.url = 'blob:tile';
    render(<ImageAttachments attachments={[ref]} sessionId="s1" />);
    const tile = screen.getByRole('button', { name: 'Open image preview' });
    const event = createEvent.contextMenu(tile);
    fireEvent(tile, event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('Copy Image', () => {
  const PNG = 'iVBORw0KGgo=';
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const originalClipboardItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  class FakeClipboardItem { constructor(readonly items: Record<string, Blob | Promise<Blob>>) {} }
  function setClipboard(value: unknown) {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem;
  }
  function copyFromMenu() {
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open image preview' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Download Image', 'Copy Image']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Image' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  }
  beforeEach(() => {
    stored.clear();
    useStore.getState().setLastError(null);
  });
  afterEach(() => {
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = originalClipboardItem;
  });

  it('copies the image from its right-click menu, next to Download Image', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    setClipboard({ write });
    render(<ImagePreviewProvider><ImageAttachments attachments={[{ ...image, data: PNG }]} /></ImagePreviewProvider>);
    copyFromMenu();
    expect(write).toHaveBeenCalledOnce();
    const [[item]] = write.mock.calls[0] as [[FakeClipboardItem]];
    const png = await item.items['image/png'];
    expect(png.type).toBe('image/png');
    expect(png.size).toBe(8);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The menu's items take the arrow keys.
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open image preview' }));
    expect(screen.getByRole('menuitem', { name: 'Download Image' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Copy Image' })).toHaveFocus();
    await Promise.resolve();
    expect(useStore.getState().lastError).toBeNull();
  });

  it.each([
    ['the browser refuses', () => setClipboard({ write: vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError')) })],
    ['there is no image clipboard (plain-http relay)', () => setClipboard(undefined)],
  ])('says it could not copy when %s', async (_case, setUp) => {
    setUp();
    render(<ImagePreviewProvider><ImageAttachments attachments={[{ ...image, data: PNG }]} /></ImagePreviewProvider>);
    copyFromMenu();
    await vi.waitFor(() => expect(useStore.getState().lastError).toBe('Couldn’t copy the image.'));
  });
});

describe('GIFs without a loop count', () => {
  const fixture = (name: string) => readFileSync(join(__dirname, '../../lib/__fixtures__/gifs', name));
  const NO_LOOP = fixture('pillow-no-loop.gif');
  const noLoop = { type: 'image' as const, mimeType: 'image/gif', data: NO_LOOP.toString('base64') };
  const shown = (src: string | null) => Buffer.from(src!.slice('data:image/gif;base64,'.length), 'base64');
  const bytes = (blob: Blob) => new Promise<Buffer>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(Buffer.from(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });
  let made: Blob[];
  beforeEach(() => {
    made = [];
    stored.clear();
    URL.createObjectURL = vi.fn((blob: Blob) => { made.push(blob); return `blob:test/${made.length}`; });
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('loop forever in the chat and the viewer; Download keeps the original bytes', async () => {
    const saved: Array<{ name: string; blob: Blob }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      if (this.download) saved.push({ name: this.download, blob: made[made.length - 1] });
    });
    render(<ImagePreviewProvider><ImageAttachments attachments={[noLoop]} /></ImagePreviewProvider>);
    const tile = shown(screen.getByRole('img').getAttribute('src'));
    expect(tile.length).toBe(NO_LOOP.length + 19);
    expect(tile.toString('latin1')).toContain('NETSCAPE2.0');

    fireEvent.click(screen.getByRole('button', { name: 'Open image preview' }));
    expect(screen.getByRole('dialog').querySelector('img')).toHaveAttribute('src', 'blob:test/1');
    const viewer = await bytes(made[0]);
    expect(viewer.equals(tile)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Download image' }));
    expect(saved.map((s) => s.name)).toEqual(['kraki-image.gif']);
    expect((await bytes(saved[0].blob)).equals(NO_LOOP)).toBe(true);
  });

  it('show an agent GIF from its looping copy in the viewer', () => {
    const blob = new Blob([NO_LOOP], { type: 'image/gif' });
    const display = new Blob([NO_LOOP, 'looping'], { type: 'image/gif' });
    stored.set('anim', { kind: 'ready', mimeType: 'image/gif', blob, display });
    state.status = 'ready'; state.url = 'blob:tile';
    render(<ImagePreviewProvider><ImageAttachments attachments={[{ ...ref, id: 'anim', mimeType: 'image/gif' }]} sessionId="s1" /></ImagePreviewProvider>);
    fireEvent.load(screen.getByRole('img'));
    fireEvent.click(screen.getByRole('button', { name: 'Open image preview' }));
    expect(made).toHaveLength(1);
    expect(made[0]).toBe(display);
  });

  it('keep a GIF that sets its own loop count, and other images, as they are', () => {
    const looping = fixture('pillow-loop-3.gif').toString('base64');
    render(<ImageAttachments attachments={[{ ...noLoop, data: looping }, { ...image, data: 'iVBORw0KGgo=' }]} />);
    expect(screen.getAllByRole('img').map((img) => img.getAttribute('src'))).toEqual([`data:image/gif;base64,${looping}`, 'data:image/png;base64,iVBORw0KGgo=']);
  });
});
