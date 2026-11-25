import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ImagePreviewProvider, ImageViewer, useOpenImagePreview } from './ImageViewer';

function RefPreview() {
  const open = useOpenImagePreview();
  return <button onClick={() => open?.({ initialIndex: 0, items: [{ url: 'blob:tile', blob: new Blob(['image']), title: 'Ref' }] })}>Open ref</button>;
}

describe('ImagePreviewProvider', () => {
  it('owns ref-image object URLs independently of virtualized source tiles and releases them on close', () => {
    URL.createObjectURL = vi.fn(() => 'blob:viewer-owned');
    URL.revokeObjectURL = vi.fn();
    render(<ImagePreviewProvider><RefPreview /></ImagePreviewProvider>);
    fireEvent.click(screen.getByText('Open ref'));
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:viewer-owned');
    fireEvent.click(screen.getByRole('button', { name: 'Close image preview' }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:viewer-owned');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:tile');
  });
});

describe('ImageViewer — Download', () => {
  it('saves the original blob of the image shown, under its file name', () => {
    const gif = new Blob(['GIF89a'], { type: 'image/gif' });
    const made: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => { made.push(blob); return 'blob:download'; });
    URL.revokeObjectURL = vi.fn();
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    try {
      render(<ImageViewer selection={{ initialIndex: 0, items: [
        { url: 'blob:a', title: 'Spinner', blob: gif },
        { url: 'blob:b', title: 'Chart', blob: new Blob(['png'], { type: 'image/png' }), fileName: 'chart.png' },
        { url: 'data:image/png;base64,AAAA', title: 'No bytes' },
      ] }} onClose={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'Download image' }));
      expect(made).toEqual([gif]);
      expect(names).toEqual(['Spinner.gif']);
      fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
      fireEvent.click(screen.getByRole('button', { name: 'Download image' }));
      expect(names).toEqual(['Spinner.gif', 'chart.png']);
      fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
      expect(screen.queryByRole('button', { name: 'Download image' })).not.toBeInTheDocument();
    } finally {
      click.mockRestore();
    }
  });
});

describe('ImageViewer — pinch zoom on touch (K-110)', () => {
  // jsdom has no PointerEvent.
  class TestPointerEvent extends MouseEvent {
    pointerId: number; pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? 'mouse';
    }
  }

  it('two fingers spreading zoom in, pinching zoom back out', () => {
    (window as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;
    const capture = Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture');
    Element.prototype.setPointerCapture = () => {};
    try {
      render(<ImageViewer selection={{ initialIndex: 0, items: [{ url: 'blob:a', title: 'A' }] }} onClose={() => {}} />);
      const canvas = document.querySelector<HTMLElement>('.kimage-canvas')!;
      const image = screen.getByRole('img');
      const finger = (pointerId: number, clientX: number) => ({ pointerId, pointerType: 'touch', clientX, clientY: 100 });
      fireEvent.pointerDown(image, finger(1, 100));
      fireEvent.pointerDown(canvas, finger(2, 200));
      fireEvent.pointerMove(canvas, finger(2, 300));
      expect(screen.getByText('2.0×')).toBeInTheDocument();
      fireEvent.pointerMove(image, finger(1, 150));
      expect(screen.getByText('1.5×')).toBeInTheDocument();
      fireEvent.pointerUp(canvas, finger(2, 300));
      // One finger left: no more zooming.
      fireEvent.pointerMove(image, finger(1, 50));
      expect(screen.getByText('1.5×')).toBeInTheDocument();
    } finally {
      delete (window as unknown as { PointerEvent?: unknown }).PointerEvent;
      if (capture) Object.defineProperty(Element.prototype, 'setPointerCapture', capture);
      else delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture;
    }
  });
});
