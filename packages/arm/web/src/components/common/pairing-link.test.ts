import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18next } from '../../i18n';
import { renderPairingInterstitial } from '../../lib/pairing-link';

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
