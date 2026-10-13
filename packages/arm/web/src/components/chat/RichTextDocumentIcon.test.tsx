import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HtmlArtifactCards } from './Attachments';
import { HtmlArtifactPanel } from './HtmlArtifactPanel';
import { RichTextDocumentIcon } from './RichTextDocumentIcon';

vi.mock('../../hooks/useAttachment', () => ({
  useAttachmentText: () => ({ status: 'loading', text: null, error: null }),
}));
const artifact = { type: 'content_ref' as const, id: 'report', mimeType: 'text/html', size: 42, name: 'Report' };

describe('RichTextDocumentIcon', () => {
  it('has a rounded document plus letter/text and image motifs, with inherited color', () => {
    const { container } = render(<RichTextDocumentIcon className="test-icon" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg?.querySelectorAll('rect')).toHaveLength(2);
    expect(svg?.querySelectorAll('path')).toHaveLength(2);
    expect(svg).toHaveClass('test-icon');
  });
  it('uses the same rich-text glyph in the report card and split-pane header', () => {
    const { container } = render(<><HtmlArtifactCards artifacts={[artifact]} onOpen={() => {}} /><HtmlArtifactPanel artifact={artifact} sessionId="s" onClose={() => {}} /></>);
    const card = container.querySelector('.kreport-card-icon svg');
    const header = container.querySelector('.kreport-header-icon');
    expect(card).not.toBeNull();
    expect(header).not.toBeNull();
    expect(card?.innerHTML).toBe(header?.innerHTML);
  });
});
