import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18next } from '../i18n';
import { renderDesktopAuthCallback } from './desktop-auth-callback';

describe('desktop sign-in callback page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    void i18next.changeLanguage('en');
  });
  function at(path: string) {
    const replace = vi.fn();
    vi.stubGlobal('location', { pathname: path, search: '?code=c&state=s', replace });
    return replace;
  }
  it('ignores other paths', () => {
    at('/session/x');
    expect(renderDesktopAuthCallback(document.createElement('div'))).toBe(false);
  });
  it('hands code+state to the app and keeps the English copy', () => {
    const replace = at('/auth/callback/desktop');
    const root = document.createElement('div');
    expect(renderDesktopAuthCallback(root)).toBe(true);
    expect(replace).toHaveBeenCalledWith('kraki://auth/callback?code=c&state=s');
    expect(root.textContent).toBe('You’re signed inReturn to Kraki to finish setting up.Open Kraki');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('kraki://auth/callback?code=c&state=s');
  });
  it('is localized', async () => {
    await i18next.changeLanguage('zh-Hans');
    at('/auth/callback/desktop');
    const root = document.createElement('div');
    renderDesktopAuthCallback(root);
    expect(root.textContent).not.toMatch(/signed in/);
  });
});
