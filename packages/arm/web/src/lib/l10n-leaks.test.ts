/**
 * K-199: texts that stayed English in the zh-Hans web UI.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import '../i18n';
import zhDesktop from '../i18n/locales/zh-Hans/desktop.json';
import enDesktop from '../i18n/locales/en/desktop.json';
import { KrakiTransport, replacedElsewhereMessage, storeOAuthState } from './transport';
import { useStore } from '../hooks/useStore';

afterEach(async () => {
  await i18next.changeLanguage('en');
  window.history.replaceState({}, '', '/');
});

describe('K-199: transport messages follow the UI language', () => {
  it('the failed GitHub sign-in check is localized', async () => {
    await i18next.changeLanguage('zh-Hans');
    useStore.getState().reset();
    storeOAuthState('expected');
    window.history.replaceState({}, '', '/?code=gh&state=wrong');
    new KrakiTransport({ onOpen: async () => {}, onParsedMessage: () => {} });
    expect(useStore.getState().lastError).toBe('无法验证 GitHub 登录。请重试。');
  });

  it('the "open in another tab" banner is localized', async () => {
    await i18next.changeLanguage('zh-Hans');
    expect(replacedElsewhereMessage()).toBe('Kraki 已在另一个标签页或窗口中打开。回到此标签页即可在这里使用。');
  });

  it('the "open in another tab" banner is cleared on reclaim even after a language change', async () => {
    useStore.getState().reset();
    const transport = new KrakiTransport({ onOpen: async () => {}, onParsedMessage: () => {} });
    const internals = transport as unknown as { handleReplaced(): void; reclaim(reason: string): void; connect(): void };
    internals.connect = () => {};
    internals.handleReplaced();
    expect(useStore.getState().lastError).toBe(replacedElsewhereMessage());
    await i18next.changeLanguage('zh-Hans');
    internals.reclaim('focus');
    expect(useStore.getState().lastError).toBeNull();
  });
});

describe('K-199: service worker notification texts', () => {
  const source = readFileSync('public/sw.js', 'utf8');
  function worker(href: string, languages: string[] = []) {
    const self = { location: { href }, navigator: { languages }, addEventListener: () => {}, registration: {} };
    return new Function('self', `${source}\nreturn { formatBody };`)(self) as { formatBody: (p: unknown) => string };
  }

  it('uses the app language the page registered it with', () => {
    const zh = worker('https://kraki.chat/sw.js?lang=zh-Hans', ['en-US']);
    expect(zh.formatBody(null)).toBe(zhDesktop.agents.attention);
    expect(zh.formatBody({ type: 'permission', summary: 'rm -rf' })).toBe(zhDesktop.notifications.permission.replace('{{summary}}', 'rm -rf'));
  });

  it('falls back to the browser languages, then English', () => {
    expect(worker('https://kraki.chat/sw.js', ['zh-CN']).formatBody(null)).toBe(zhDesktop.agents.attention);
    expect(worker('https://kraki.chat/sw.js', ['zh-TW', 'fr']).formatBody(null)).toBe(enDesktop.agents.attention);
    expect(worker('https://kraki.chat/sw.js', []).formatBody({ type: 'permission', summary: 'x' }))
      .toBe(enDesktop.notifications.permission.replace('{{summary}}', 'x'));
  });
});
