import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HtmlArtifactCards, ImageAttachments, refImageSize } from './Attachments';
import { ImagePreviewProvider } from './ImageViewer';

const state = vi.hoisted(() => ({ status: 'loading', url: null as string | null, error: null as string | null, retry: vi.fn() }));
vi.mock('../../hooks/useAttachment', () => ({ useAttachment: () => state }));
const ref = { type: 'content_ref' as const, id: 'image', mimeType: 'image/png', size: 2048, width: 800, height: 400, name: 'Image' };
const image = { type: 'image' as const, mimeType: 'image/png', data: 'AAAA' };
beforeEach(() => { state.status = 'loading'; state.url = null; state.error = null; state.retry.mockClear(); });

describe('ImageAttachments', () => {
  it('uses proportional metadata sizes and a square fallback, never exceeds 192px', () => {
    expect(refImageSize(ref)).toMatchObject({ width: 360, height: 180 });
    expect(refImageSize({ ...ref, width: 400, height: 800 })).toMatchObject({ width: 96, height: 192 });
    expect(refImageSize({ ...ref, width: undefined, height: undefined })).toMatchObject({ width: 192, height: 192 });
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
    const open = vi.fn();
    render(<HtmlArtifactCards artifacts={[{ ...ref, mimeType: 'text/html', caption: 'Report title', size: 167_000 }]} onOpen={open} />);
    expect(screen.getByText('Report · 167 KB')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open report Report title' }));
    expect(open).toHaveBeenCalledOnce();
  });
});
