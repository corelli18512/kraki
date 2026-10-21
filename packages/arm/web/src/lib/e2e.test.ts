import { afterEach, describe, expect, it } from 'vitest';
import { i18next } from '../i18n';
import { BrowserAppKeyStore } from './e2e';

afterEach(async () => { await i18next.changeLanguage('en'); });

describe('BrowserAppKeyStore diagnostics', () => {
  it('keeps internal errors in English when the UI is Chinese', async () => {
    await i18next.changeLanguage('zh-Hans');
    const keys = new BrowserAppKeyStore();
    await expect(keys.getPublicKey()).rejects.toThrow('Keys not initialized');
    await expect(keys.getSigningPublicKey()).rejects.toThrow('Keys not initialized');
    await expect(keys.signChallenge('nonce')).rejects.toThrow('Keys not initialized');
    await expect(keys.decrypt({ iv: '', ciphertext: '', tag: '', keys: {} }, 'device')).rejects.toThrow('Keys not initialized');
    await expect(keys.encrypt('message', [])).rejects.toThrow('At least one recipient required');
  });
});
