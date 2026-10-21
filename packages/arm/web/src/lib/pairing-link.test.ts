import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decidePairingLink, isOfficialRelay, shouldAutoOpenStore } from './pairing-link';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36';

describe('pairing link (release review A10 / D5)', () => {
  it('recognizes Kraki relays only', () => {
    expect(isOfficialRelay('wss://relay.kraki.chat')).toBe(true);
    expect(isOfficialRelay('wss://cn.relay.kraki.chat')).toBe(true);
    expect(isOfficialRelay('wss://kraki.chat.evil.example')).toBe(false);
    expect(isOfficialRelay('wss://evil.example')).toBe(false);
    expect(isOfficialRelay('not a url')).toBe(false);
  });

  it('offers the app on iPhone without spending the token', () => {
    expect(decidePairingLink('?relay=wss://relay.kraki.chat&token=pt_1', IPHONE)).toEqual({ kind: 'offer-app' });
    expect(decidePairingLink('?relay=wss://relay.kraki.chat&token=pt_1&web=1', IPHONE)).toEqual({ kind: 'proceed' });
  });

  it('opens the App Store once per code, so coming back does not loop', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
    expect(shouldAutoOpenStore(storage, '?relay=wss://relay.kraki.chat&token=pt_1')).toBe(true);
    expect(shouldAutoOpenStore(storage, '?relay=wss://relay.kraki.chat&token=pt_1')).toBe(false);
    expect(shouldAutoOpenStore(storage, '?relay=wss://relay.kraki.chat&token=pt_2')).toBe(true);
    expect(shouldAutoOpenStore(storage, '?relay=wss://relay.kraki.chat')).toBe(false);
    const blocked = { getItem: () => null, setItem: () => { throw new Error('blocked'); } };
    expect(shouldAutoOpenStore(blocked, '?token=pt_3')).toBe(false);
  });

  it('treats iPadOS (desktop user agent with touch) as iOS', () => {
    const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15';
    expect(decidePairingLink('?relay=wss://relay.kraki.chat&token=pt_1', IPAD, 5)).toEqual({ kind: 'offer-app' });
    expect(decidePairingLink('?relay=wss://relay.kraki.chat&token=pt_1', IPAD, 0)).toEqual({ kind: 'proceed' });
  });

  it('keeps pairing the web client on Android', () => {
    expect(decidePairingLink('?relay=wss://relay.kraki.chat&token=pt_1', ANDROID)).toEqual({ kind: 'proceed' });
  });

  it('asks before connecting to a non-Kraki relay', () => {
    expect(decidePairingLink('?relay=wss://my.server:4000&token=pt_1', ANDROID)).toEqual({ kind: 'confirm-relay', host: 'my.server:4000' });
    expect(decidePairingLink('?relay=wss://my.server:4000&token=pt_1&confirmRelay=1', ANDROID)).toEqual({ kind: 'proceed' });
  });

  it('does nothing without a token', () => {
    expect(decidePairingLink('?channel=beta', IPHONE)).toEqual({ kind: 'none' });
  });

  it('decides before the app can read the token (main.tsx loads the app lazily)', () => {
    // The relay client strips ?token= from the URL when it is constructed, so
    // any static import of the app from main.tsx would bypass this gate.
    const main = readFileSync(resolve(__dirname, '../main.tsx'), 'utf8');
    const staticImports = [...main.matchAll(/^import\s.*?from\s+'([^']+)'|^import\s+'([^']+)'/gm)].map(m => m[1] ?? m[2]);
    expect(staticImports.sort()).toEqual(['./i18n', './index.css', './lib/desktop-auth-callback', './lib/pairing-link']);
    expect(main).toContain("import('./boot')");
    const gate = readFileSync(resolve(__dirname, 'pairing-link.ts'), 'utf8');
    const gateImports = [...gate.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map(m => m[1]);
    expect(gateImports).toEqual(['../i18n']);
    const callback = readFileSync(resolve(__dirname, 'desktop-auth-callback.ts'), 'utf8');
    expect([...callback.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map(m => m[1])).toEqual(['../i18n']);
    // Localization loads before the gate, so it must stay app-free: only
    // i18next and bundled locale data, never the relay client or the store.
    const i18nDir = resolve(__dirname, '../i18n');
    for (const file of ['index.ts', 'resources.ts', 'languages.ts', 'locales/en/index.ts', 'locales/zh-Hans/index.ts']) {
      const src = readFileSync(resolve(i18nDir, file), 'utf8');
      const deps = [...src.matchAll(/^import\s.*?from\s+'([^']+)'|^import\s+'([^']+)'/gm)].map(m => m[1] ?? m[2]);
      for (const dep of deps) expect(dep, `${file} imports ${dep}`).toMatch(/^(i18next|react-i18next|\.\/[\w-]+(\.json)?|\.\/locales\/[\w-]+)$/);
    }
  });
});

