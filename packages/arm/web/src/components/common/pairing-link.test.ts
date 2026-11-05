import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18next } from '../../i18n';
import { CONFIRMED_RELAY_KEY, renderPairingInterstitial } from '../../lib/pairing-link';

afterEach(async () => { await i18next.changeLanguage('en'); vi.unstubAllEnvs(); });

describe('pairing-link localized interstitial', () => {
  it('translates self-hosted relay copy while inserting the untrusted host as text', async () => {
    await i18next.changeLanguage('zh-Hans');
    const root = document.createElement('div');
    const host = '<img src=x onerror=alert(1)>';
    expect(renderPairingInterstitial({ kind: 'confirm-relay', host }, root)).toBe(true);
    expect(root.querySelector('h2')).toHaveTextContent('连接到自托管服务器？');
    expect(root.querySelector('b')).toHaveTextContent(host);
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('#kraki-confirm')).toHaveTextContent('连接');
    expect(root.querySelector('#kraki-cancel')).toHaveTextContent('取消');
  });

  it('K-001: Connect records the confirmed relay in this tab and reloads the same link', () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, search: '?relay=wss%3A%2F%2Fmy.server%3A4000&token=pt_1', pathname: '/', reload } });
    try {
      sessionStorage.removeItem(CONFIRMED_RELAY_KEY);
      const root = document.createElement('div');
      renderPairingInterstitial({ kind: 'confirm-relay', host: 'my.server:4000' }, root);
      root.querySelector<HTMLButtonElement>('#kraki-confirm')!.click();
      expect(sessionStorage.getItem(CONFIRMED_RELAY_KEY)).toBe('wss://my.server:4000');
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
      sessionStorage.removeItem(CONFIRMED_RELAY_KEY);
    }
  });

  it('computes app-store and browser copy in the current language at call time', async () => {
    vi.stubEnv('VITE_IOS_APP_STORE_URL', 'https://apps.apple.com/example');
    const root = document.createElement('div');
    renderPairingInterstitial({ kind: 'offer-app' }, root);
    expect(root.querySelector('h2')).toHaveTextContent('Open in the Kraki app');
    await i18next.changeLanguage('zh-Hans');
    renderPairingInterstitial({ kind: 'offer-app' }, root);
    expect(root.querySelector('h2')).toHaveTextContent('在 Kraki 应用中打开');
    expect(root.querySelector('#kraki-store')).toHaveAttribute('href', 'https://apps.apple.com/example');
    expect(root.querySelector('#kraki-web')).toHaveTextContent('在浏览器中继续');
  });
});
