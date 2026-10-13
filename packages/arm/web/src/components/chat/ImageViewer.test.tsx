import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ImagePreviewProvider, useOpenImagePreview } from './ImageViewer';

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
