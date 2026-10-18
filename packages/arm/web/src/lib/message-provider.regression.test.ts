import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cases, invariant } from './__tests__/message-provider.scenarios';
import { messageProvider } from './message-provider';
import { outbox } from './chat/outbox';

beforeAll(() => { vi.stubGlobal('crypto', webcrypto); });
afterAll(() => { messageProvider.clear(); outbox.reset(); vi.unstubAllGlobals(); });
describe('message-provider desired replay/range/epoch invariants', () => {
  for (const [name, run] of Object.entries(cases)) {
    it(name, async () => {
      const result = await run();
      console.log(`HISTORY_PROVIDER ${name} ${JSON.stringify(result)}`);
      expect(invariant(name, result)).toBe(true);
    }, 20_000);
  }
});
