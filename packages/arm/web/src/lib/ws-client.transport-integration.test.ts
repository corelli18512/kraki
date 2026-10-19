import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { integrationScenarios } from './__tests__/ws-client.transport-integration.scenarios';
import { messageProvider } from './message-provider';
import { outbox } from './chat/outbox';

beforeAll(() => { vi.stubGlobal('crypto', webcrypto); });
afterAll(() => { messageProvider.clear(); outbox.reset(); vi.unstubAllGlobals(); });
describe('combined transport order and subscription ownership with real WebCrypto', () => {
  it.each(Object.entries(integrationScenarios))('%s', async (name, run) => {
    const result = await run();
    console.log(`TRANSPORT_INTEGRATION ${name} ${JSON.stringify(result)}`);
    expect(result).toMatchObject({ invariant: true, noResurrection: true, currentReady: true, aReady: false, text: 'current-C+live' });
  });
});
