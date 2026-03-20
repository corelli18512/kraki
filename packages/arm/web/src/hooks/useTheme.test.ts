import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTheme } from './useTheme';
import { renderHook } from '@testing-library/react';

beforeEach(() => {
  document.documentElement.classList.remove('dark');
});

describe('useTheme', () => {
  it('adds dark class when system prefers dark', () => {
    // Our mock matchMedia returns matches: true for dark
    renderHook(() => useTheme());
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('removes dark class when system prefers light', () => {
    // Override matchMedia to return light preference
    const listeners: Array<(e: { matches: boolean }) => void> = [];
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_: string, cb: (e: { matches: boolean }) => void) => listeners.push(cb)),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList);

    document.documentElement.classList.add('dark');
    renderHook(() => useTheme());
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('cleans up event listener on unmount', () => {
    const removeEventListener = vi.fn();
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener,
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList);

    const { unmount } = renderHook(() => useTheme());
    unmount();
    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
