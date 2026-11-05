import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureUsableStorage, memoryStorage } from './storage-guard';

afterEach(() => { vi.restoreAllMocks(); });

describe('K-201: storage the browser refuses or that is full', () => {
  it('replaces a Storage whose access throws with memory for this page', () => {
    const target = {} as Window;
    Object.defineProperty(target, 'localStorage', { configurable: true, get: () => { throw new DOMException('denied', 'SecurityError'); } });
    Object.defineProperty(target, 'sessionStorage', { configurable: true, value: memoryStorage() });
    const session = target.sessionStorage;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ensureUsableStorage(target);
    target.localStorage.setItem('k', 'v');
    expect(target.localStorage.getItem('k')).toBe('v');
    expect(target.sessionStorage).toBe(session); // a working one is left alone
  });

  it('a full localStorage does not make store updates throw', async () => {
    const { useStore } = await import('../hooks/useStore');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(() => useStore.getState().upsertSession({
      id: 's-full', deviceId: 'd', deviceName: 'Mac', agent: 'pi', state: 'idle', messageCount: 0,
    } as never)).not.toThrow();
    expect(useStore.getState().sessions.has('s-full')).toBe(true);
  });

  it('with full storage, updates that change nothing saved do not retry the failed write', async () => {
    const { useStore } = await import('../hooks/useStore');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    useStore.getState().upsertSession({
      id: 's-full-2', deviceId: 'd', deviceName: 'Mac', agent: 'pi', state: 'idle', messageCount: 0,
    } as never);
    const attempts = setItem.mock.calls.length;
    expect(attempts).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) useStore.getState().setStatus(i % 2 ? 'connected' : 'connecting');
    expect(setItem.mock.calls.length).toBe(attempts);
  });

  it('theme and usage shortcut settings work with full storage', async () => {
    const { setTheme } = await import('../hooks/useTheme');
    const { setUsageShortcut, useUsageShortcut } = await import('./usage-shortcut');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(() => setTheme('light')).not.toThrow();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(() => setUsageShortcut('F7', true)).not.toThrow();
    expect(useUsageShortcut.getState()).toMatchObject({ shortcut: 'F7', enabled: true });
  });
});
