import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { BrowserAppKeyStore, clearDeviceKeys } from './e2e';

// K-006: sign-out deletes this browser's keys, so a late push preview for the
// signed-out device cannot be decrypted (public/sw.js reads the same store).
describe('clearDeviceKeys', () => {
  it('deletes the stored key pairs: the next key store starts with new keys', async () => {
    const before = new BrowserAppKeyStore();
    await before.init();
    const again = new BrowserAppKeyStore();
    await again.init();
    expect(await again.getPublicKey()).toBe(await before.getPublicKey());

    const cleared = clearDeviceKeys();
    // A key store started while the keys are being deleted waits for it.
    const after = new BrowserAppKeyStore();
    await Promise.all([cleared, after.init()]);
    expect(await after.getPublicKey()).not.toBe(await before.getPublicKey());
    expect(await after.getSigningPublicKey()).not.toBe(await before.getSigningPublicKey());
  }, 60_000);
});
