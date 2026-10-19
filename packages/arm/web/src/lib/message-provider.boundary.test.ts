import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { queuedStoreWrite } from './__tests__/message-provider.scenarios';

// Retained formerly opt-in RED: the store/DB lifecycle now guards this seam.
// Original RED artifacts remain outside the repository; this contract always runs.
it('message-provider boundary: a store-queued write must not recreate deleted IDB rows', async () => {
  vi.stubGlobal('crypto', webcrypto);
  try {
    const result = await queuedStoreWrite();
    console.log(`GUARDED_STORE_WRITE ${JSON.stringify(result)}`);
    expect(result.persisted).toBe(0);
  } finally { vi.unstubAllGlobals(); }
});
