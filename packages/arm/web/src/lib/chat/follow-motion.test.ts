import { describe, expect, it } from 'vitest';
import { followProgress, newTailKeys } from '../../components/chat/ChatScroller';

describe('following the bottom', () => {
  it('closes a new line over several frames, never in one', () => {
    let remaining = 36;
    const steps: number[] = [];
    while (remaining > 0.5) {
      const step = remaining * followProgress(16.7);
      steps.push(step);
      remaining -= step;
    }
    expect(Math.max(...steps)).toBeLessThan(36 * 0.2);
    expect(steps.length * 16.7).toBeLessThan(400);
  });

  it('a long stall does not turn into a jump', () => {
    expect(followProgress(500)).toBeLessThan(0.6);
    expect(followProgress(-3)).toBe(0);
  });
});

describe('entrances', () => {
  it('only rows added at the end enter', () => {
    expect(newTailKeys(['a', 'b'], ['a', 'b', 'c'])).toEqual(['c']);
    expect(newTailKeys(['a', 'pending'], ['a', 'sent'])).toEqual([]);
    expect(newTailKeys(['a', 'live'], ['a', 'landed'])).toEqual([]);
    expect(newTailKeys(['b', 'c'], ['a', 'b', 'c'])).toEqual([]);
  });

  it('enters arrivals after the old tail survives front-window eviction', () => {
    expect(newTailKeys(['a', 'b', 'c'], ['b', 'c', 'user'])).toEqual(['user']);
    expect(newTailKeys(['a', 'b', 'c'], ['c', 'user', 'live'])).toEqual(['user', 'live']);
    expect(newTailKeys(['a', 'b', 'pending'], ['b', 'pending', 'live'])).toEqual(['live']);
  });

  it('suppresses catch-up bursts larger than two even when the capped window evicts its front', () => {
    expect(newTailKeys(['a', 'b', 'c', 'd'], ['d', 'user', 'reply', 'next-user'])).toEqual([]);
    expect(newTailKeys(['a'], ['a', 'user', 'reply', 'next-user'])).toEqual([]);
    expect(newTailKeys(['a', 'b', 'c'], ['c', 'user', 'reply'])).toEqual(['user', 'reply']);
  });

  it('does not animate a capped replacement, prepend or reorder', () => {
    expect(newTailKeys(['a', 'b', 'live'], ['b', 'user', 'landed'])).toEqual([]);
    expect(newTailKeys(['b', 'c'], ['older', 'b', 'c'])).toEqual([]);
    expect(newTailKeys(['a', 'live', 'user'], ['a', 'user', 'live'])).toEqual([]);
  });
});
