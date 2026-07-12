import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HtmlArtifactPanel } from './HtmlArtifactPanel';

vi.mock('../../hooks/useAttachment', () => ({
  useAttachmentText: () => ({ status: 'loading', text: null, error: null }),
}));

const artifact = {
  type: 'content_ref' as const,
  id: 'report-1',
  mimeType: 'text/html',
  size: 2048,
  name: 'architecture.html',
  caption: 'Architecture Report',
};

describe('HtmlArtifactPanel', () => {
  it('renders the selected artifact title, requests panel fullscreen, and closes', () => {
    const onClose = vi.fn();
    render(<HtmlArtifactPanel artifact={artifact} sessionId="s1" onClose={onClose} />);

    expect(screen.getByText('Architecture Report')).toBeInTheDocument();
    expect(screen.getByText('Loading report…')).toBeInTheDocument();
    const panel = screen.getByRole('complementary', { name: 'HTML report preview' });
    const requestFullscreen = vi.fn();
    Object.defineProperty(panel, 'requestFullscreen', { value: requestFullscreen });
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen report' }));
    expect(requestFullscreen).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Close report preview' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
