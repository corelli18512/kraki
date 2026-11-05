import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { STREAMING_RENDER_MS, StreamingMarkdown, useThrottledValue, withoutPartialFence } from './Markdown';

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

  it('drops a pending commit when the value returns to what is shown', () => {
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, 80), { initialProps: { v: 'a' } });
    rerender({ v: 'b' });      // within the interval: pending
    expect(result.current).toBe('a');
    rerender({ v: 'a' });      // back to the shown value
    expect(vi.getTimerCount()).toBe(0);
    act(() => { vi.advanceTimersByTime(200); });
    expect(result.current).toBe('a');
  });

  it('reschedules a pending commit when the interval changes', () => {
    const { result, rerender } = renderHook(({ v, ms }) => useThrottledValue(v, ms), { initialProps: { v: 'a', ms: 1000 } });
    rerender({ v: 'b', ms: 1000 });
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current).toBe('a');
    rerender({ v: 'b', ms: 30 });
    act(() => { vi.advanceTimersByTime(15); });
    expect(result.current).toBe('b');
  });
});

describe('StreamingMarkdown — a fence still arriving (K-223)', () => {
  it('never shows the first backticks of a fence as text', () => {
    for (const partial of ['Run this:\n`', 'Run this:\n``', 'Run this:\n~~']) {
      const { container, unmount } = render(<StreamingMarkdown text={partial} />);
      expect(container.textContent).toBe('Run this:');
      unmount();
    }
    // Nor the closing one inside the block.
    const { container } = render(<StreamingMarkdown text={'```sh\npnpm test\n``'} />);
    expect(container.querySelector('pre')?.textContent?.trim()).toBe('pnpm test');
  });

  it('keeps inline code and complete fences', () => {
    expect(withoutPartialFence('use `pnpm`')).toBe('use `pnpm`');
    expect(withoutPartialFence('a\n```')).toBe('a\n```');
    expect(withoutPartialFence('``')).toBe('');
    expect(withoutPartialFence('x ``')).toBe('x ``');
  });
});
