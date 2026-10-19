import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { persistenceCases, expected } from './__tests__/message-persistence-generation.scenarios';

beforeAll(() => { vi.stubGlobal('crypto', webcrypto); });
afterAll(() => { vi.unstubAllGlobals(); });
// Insertion order matters: first-open fault must run before any DB operation.
for (const [name, run] of Object.entries(persistenceCases)) {
  it(`message-persistence-generation: ${name}`, async () => {
    expect(await run()).toEqual(expected[name]);
  });
}
