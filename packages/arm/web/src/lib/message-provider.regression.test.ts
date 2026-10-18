import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { setImmediate } from 'node:timers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cases, invariant } from './__tests__/message-provider.scenarios';
import { messageProvider } from './message-provider';
import { outbox } from './chat/outbox';

beforeAll(() => { vi.stubGlobal('crypto', webcrypto); });
afterAll(() => { messageProvider.clear(); outbox.reset(); vi.unstubAllGlobals(); });
// Rejected late batches intentionally leave the range timer armed. Advance
// that timer without spending 10 real seconds per fault; yield to real IDB I/O.
async function withRangeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    let settled = false;
    const running = run();
    void running.then(() => { settled = true; }, () => { settled = true; });
    while (!settled) {
      await vi.advanceTimersByTimeAsync(50);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return await running;
  } finally { vi.useRealTimers(); }
}
const timedRejections = new Set(['F3-producer-duplicate-suffix-control', 'F3-duplicate-truncated',
  'F3-nonprefix-truncated', 'F3-outside-truncated', 'F9-timeout']);

describe('message-provider desired replay/range/epoch invariants', () => {
  for (const [name, run] of Object.entries(cases)) {
    it(name, async () => {
      const result = await (timedRejections.has(name) ? withRangeTimers(run) : run());
      console.log(`HISTORY_PROVIDER ${name} ${JSON.stringify(result)}`);
      expect(invariant(name, result)).toBe(true);
    }, 20_000);
  }
});
