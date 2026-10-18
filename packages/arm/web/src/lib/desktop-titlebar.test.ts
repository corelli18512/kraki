import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KrakiDesktopBridge } from './desktop';

afterEach(() => { delete window.krakiDesktop; vi.resetModules(); });

describe('Windows titlebar capability gating', () => {
  it.each([
    [undefined, false, false],
    ['win32', false, false],
    ['win32', true, true],
    ['linux', true, false],
    ['darwin', true, false],
  ])('requires the Windows Electron preload flag (%s, capability %s)', async (platform, capability, enabled) => {
    if (platform) window.krakiDesktop = {
      platform,
      titleBarOverlay: capability ? { setTheme: vi.fn() } : undefined,
    } as unknown as KrakiDesktopBridge;
    const { hasWindowsTitleBar } = await import('./desktop');
    expect(hasWindowsTitleBar).toBe(enabled);
  });
});
