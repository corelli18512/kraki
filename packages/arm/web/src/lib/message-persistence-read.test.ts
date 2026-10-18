import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readCases, readExpected } from './__tests__/message-persistence-read.scenarios';

beforeAll(() => { vi.stubGlobal('crypto', webcrypto); });
afterAll(() => { vi.unstubAllGlobals(); });
for (const [name, run] of Object.entries(readCases)) {
  it(`message-persistence-read: ${name}`, async () => {
    expect(await run()).toEqual(readExpected[name]);
  });
}
