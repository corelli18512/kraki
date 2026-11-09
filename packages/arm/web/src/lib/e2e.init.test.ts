import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAppKeyStore } from './e2e';

beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('BrowserAppKeyStore.init (K-004)', () => {
  it('concurrent init() calls create one key set and share it', async () => {
    const generateKey = vi.spyOn(crypto.subtle, 'generateKey');
    const keys = new BrowserAppKeyStore();
    await Promise.all([keys.init(), keys.init(), keys.init()]);
    // One signing key pair + one encryption key pair, never more.
    expect(generateKey).toHaveBeenCalledTimes(2);
    const published = await keys.getPublicKey();

    // A reload reads the stored keys: they must be the ones this page published.
    const reloaded = new BrowserAppKeyStore();
    await reloaded.init();
    expect(await reloaded.getPublicKey()).toBe(published);
    expect(await reloaded.getSigningPublicKey()).toBe(await keys.getSigningPublicKey());
  }, 60_000);

  it('two key stores starting at once (two tabs) end up with the same stored keys', async () => {
    const a = new BrowserAppKeyStore();
    const b = new BrowserAppKeyStore();
    await Promise.all([a.init(), b.init()]);
    expect(await a.getPublicKey()).toBe(await b.getPublicKey());
    expect(await a.getSigningPublicKey()).toBe(await b.getSigningPublicKey());
    const reloaded = new BrowserAppKeyStore();
    await reloaded.init();
    expect(await reloaded.getPublicKey()).toBe(await a.getPublicKey());
  }, 60_000);

  it('a failed init can be retried', async () => {
    const keys = new BrowserAppKeyStore();
    vi.spyOn(crypto.subtle, 'generateKey').mockRejectedValueOnce(new Error('boom'));
    await expect(keys.init()).rejects.toThrow('boom');
    expect(keys.isReady()).toBe(false);
    vi.restoreAllMocks();
    await keys.init();
    expect(keys.isReady()).toBe(true);
  }, 60_000);
});
