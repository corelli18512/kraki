import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { HtmlArtifactCards, ImageAttachments, refImageSize, htmlArtifactTitle } from './Attachments';
import { ImagePreviewProvider } from './ImageViewer';

const state = vi.hoisted(() => ({ status: 'loading', url: null as string | null, error: null as string | null, retry: vi.fn() }));
vi.mock('../../hooks/useAttachment', () => ({ useAttachment: () => state }));
const stored = vi.hoisted(() => new Map<string, { kind: 'ready'; mimeType: string; blob: Blob }>());
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
