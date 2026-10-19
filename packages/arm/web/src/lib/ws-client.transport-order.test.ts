import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { scenarios, subscriptionCancellation } from './__tests__/ws-client.transport-order.scenarios';
import { messageProvider } from './message-provider';
import { outbox } from './chat/outbox';

const selected = Object.fromEntries(Object.entries(scenarios).filter(([name]) => process.env.TRANSPORT_ORDER_BASELINE !== '1' || name.startsWith('F1-') || name === 'ordinary-retained-input-control'));
const results: Record<string, any> = {};
beforeAll(async () => {
  vi.stubGlobal('crypto', webcrypto);
  for (const [name, run] of Object.entries(selected)) {
    results[name] = await run();
    console.log(`TRANSPORT_ORDER ${name} ${JSON.stringify(results[name])}`);
  }
}, 90_000);
afterAll(() => { messageProvider.clear(); outbox.reset(); vi.unstubAllGlobals(); });
describe('ws-client admission order with real WebCrypto', () => {
  it.each(Object.keys(selected))('%s desired contract', (name) => expect(results[name].invariant).toBe(true));
  (process.env.TRANSPORT_ORDER_BASELINE === '1' ? it.skip : it).each([false, true])('explicit disconnect owns cancellation when real transport suppresses late onClose (reject=%s)', async (rejectOld) => {
    const OriginalSocket = globalThis.WebSocket;
    const closed = vi.fn();
    globalThis.WebSocket = class extends OriginalSocket {
      close() { queueMicrotask(() => this.onclose?.({} as CloseEvent)); }
    } as typeof WebSocket;
    try {
      const result = await subscriptionCancellation(rejectOld, async (transport) => {
        const onClose = transport.callbacks.onClose;
        transport.callbacks.onClose = () => { closed(); onClose(); };
        transport.callbacks.onOpen = async () => {};
        transport.connect();
        await new Promise(r => setTimeout(r, 0));
      });
      expect(closed).not.toHaveBeenCalled();
      expect(result).toMatchObject({ invariant: true, error: null, sameFlight: true, oldRejected: true, ready: true });
    } finally { globalThis.WebSocket = OriginalSocket; }
  });
  it('current genuine encryption failure reports, stale cancellation does not', () => {
    if (process.env.TRANSPORT_ORDER_BASELINE === '1') return;
    expect(results['send-failure-control'].error).toBe('Cannot send: no target device for this session. Try reconnecting.');
    expect(results['subscription-disconnect-reject-control'].error).toBeNull();
  });
  it('preserves firstsecond sends and deltas, ACK-before-delta, stale-Head exclusion', () => {
    expect(results['F1-sends']).toMatchObject({ order: ['first', 'second'], admittedBeforeFirstRelease: 0 });
    expect(results['F1-ack-delta'].text).toBe('second');
    expect(results['F1-deltas'].text).toBe('firstsecond');
    expect(results['F1-handover']).toMatchObject({ text: 'fresh-link-snapshot', staleDropped: 1 });
  });
});
