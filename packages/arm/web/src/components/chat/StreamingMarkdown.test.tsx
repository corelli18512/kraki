import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { STREAMING_RENDER_MS, StreamingMarkdown } from './Markdown';

/**
 * A streaming draft must keep visibly updating while tokens arrive faster
 * than it can render. With `useDeferredValue` every new token abandoned the
 * pending render, so on a slow device the draft froze for the whole stream
 * (real-stack statuscard-stream-profile, reproduced at 6x CPU throttling).
 */
describe('StreamingMarkdown', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('commits regularly while tokens keep arriving, and lands the last one', () => {
    let text = '';
    const { container, rerender } = render(<StreamingMarkdown text={text} />);
    const seen = new Set<string>();
    // 100 tokens, one every 10 ms (a full second, never pausing).
    for (let i = 0; i < 100; i++) {
      text += `word${i} `;
      rerender(<StreamingMarkdown text={text} />);
      act(() => { vi.advanceTimersByTime(10); });
      seen.add(container.textContent ?? '');
    }
    // ~1000 ms / 80 ms: about a dozen distinct frames, not one at the end.
    expect(seen.size).toBeGreaterThanOrEqual(Math.floor(1000 / STREAMING_RENDER_MS) - 2);
    expect(seen.size).toBeLessThanOrEqual(Math.ceil(1000 / STREAMING_RENDER_MS) + 2);
    act(() => { vi.advanceTimersByTime(STREAMING_RENDER_MS); });
    expect(container.textContent).toBe(text.trim());
  });

  it('renders the first token at once', () => {
    const { container } = render(<StreamingMarkdown text="Hello" />);
    expect(container.textContent).toBe('Hello');
  });
});
