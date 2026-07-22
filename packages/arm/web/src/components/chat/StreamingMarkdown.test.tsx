import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { StreamingMarkdown } from './StreamingMarkdown';

describe('StreamingMarkdown', () => {
  it('renders the raw text immediately while deltas are still arriving', () => {
    // No markdown AST during active streaming — a single cheap text node that
    // paints in the same frame the token arrives.
    render(<StreamingMarkdown content="hello **world" />);
    // Raw draft wraps the text; it should appear verbatim (un-parsed markdown
    // sigils present, since we deliberately skip the parse while streaming).
    expect(screen.getByText('hello **world')).toBeTruthy();
    // The full parse (which would render <strong>world</strong>) must NOT have
    // run yet.
    expect(screen.queryByText('world')).toBeNull();
  });

  it('parses to markdown once the stream settles (no new text for a while)', async () => {
    vi.useFakeTimers();
    render(<StreamingMarkdown content="hello **world**" />);
    // While streaming: raw text.
    expect(screen.getByText('hello **world**')).toBeTruthy();

    // After the settle window with no further changes, the parsed markdown
    // replaces the raw text.
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getByText('world')).toBeTruthy(); // <strong>world</strong>
    expect(screen.queryByText('hello **world**')).toBeNull();
    vi.useRealTimers();
  });

  it('keeps streaming raw text across rapid updates (parse stays deferred)', () => {
    vi.useFakeTimers();
    const { rerender } = render(<StreamingMarkdown content="ab" />);
    expect(screen.getByText('ab')).toBeTruthy();
    // Rapid growth — each update resets the settle timer, so the parse never
    // fires mid-stream.
    rerender(<StreamingMarkdown content="abc" />);
    act(() => { vi.advanceTimersByTime(200); });
    rerender(<StreamingMarkdown content="abcd" />);
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByText('abcd')).toBeTruthy();
    // Still raw (no parse yet — settle never completed under 350ms gaps).
    expect(screen.queryByText('bcd')).toBeNull();
    vi.useRealTimers();
  });

  it('renders nothing for empty content', () => {
    const { container } = render(<StreamingMarkdown content="" />);
    expect(container.textContent).toBe('');
  });
});
