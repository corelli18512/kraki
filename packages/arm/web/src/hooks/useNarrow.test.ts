import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
const environment = vi.hoisted(() => ({ isDesktop: false }));
vi.mock('../lib/desktop', () => environment);
import { useNarrow } from './useNarrow';

describe('useNarrow desktop minimum layout', () => {
  it('preserves browser mobile but never makes the desktop shell mobile', () => {
    const matchMedia = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList);
    environment.isDesktop = false;
    const browser = renderHook(() => useNarrow());
    expect(browser.result.current).toBe(true);
    browser.unmount();
    environment.isDesktop = true;
    const desktop = renderHook(() => useNarrow());
    expect(desktop.result.current).toBe(false);
    desktop.unmount();
    environment.isDesktop = false;
    matchMedia.mockRestore();
  });
});
