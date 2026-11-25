import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_RELOAD_KEY, WORDMARK_FONT_URL, loadApp, loadWordmarkFont } from './boot-loader';
import { memoryStorage as pageMemoryStorage } from './storage-guard';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

describe('K-091: the app chunk fails to load (stale deploy)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  const missingChunk = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));

  it('reloads once to pick up the current deploy', async () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    await loadApp(missingChunk, root, { storage, reload });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(BOOT_RELOAD_KEY)).toBe('1');
    expect(root.innerHTML).toBe('');
  });

  it('after the reload failed too, shows a message with Reload instead of a blank page', async () => {
    const storage = memoryStorage();
    storage.setItem(BOOT_RELOAD_KEY, '1');
    const reload = vi.fn();
    await loadApp(missingChunk, root, { storage, reload });
    expect(reload).not.toHaveBeenCalled();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Kraki couldn't load");
    root.querySelector<HTMLButtonElement>('#kraki-reload')!.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('with site storage blocked (memory-only storage) shows the message at once instead of reloading forever', async () => {
    const reload = vi.fn();
    await loadApp(missingChunk, root, { storage: pageMemoryStorage(), reload });
    expect(reload).not.toHaveBeenCalled();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Kraki couldn't load");
  });

  it('a successful load boots the app and clears the reload marker', async () => {
    const storage = memoryStorage();
    storage.setItem(BOOT_RELOAD_KEY, '1');
    const boot = vi.fn();
    await loadApp(async () => ({ boot }), root, { storage, reload: vi.fn() });
    expect(boot).toHaveBeenCalledWith(root);
    expect(storage.getItem(BOOT_RELOAD_KEY)).toBeNull();
  });
});

describe('K-090: the Google Fonts stylesheet never blocks the first paint', () => {
  it('index.html has no render-blocking external stylesheet', () => {
    const html = readFileSync('index.html', 'utf8');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const blocking = [...doc.querySelectorAll('link[rel="stylesheet"]')]
      .filter((l) => /^https?:/.test(l.getAttribute('href') ?? '') && !l.getAttribute('media'));
    expect(blocking.map((l) => l.getAttribute('href'))).toEqual([]);
  });

  it('the wordmark font is added from script, once', () => {
    const doc = document.implementation.createHTMLDocument('t');
    loadWordmarkFont(doc);
    loadWordmarkFont(doc);
    const links = doc.head.querySelectorAll(`link[href="${WORDMARK_FONT_URL}"]`);
    expect(links).toHaveLength(1);
    const link = links[0] as HTMLLinkElement;
    expect(link.rel).toBe('stylesheet');
    // Not applied (so never render-blocking) until it has loaded.
    expect(link.media).toBe('print');
    link.dispatchEvent(new Event('load'));
    expect(link.media).toBe('all');
  });
});
