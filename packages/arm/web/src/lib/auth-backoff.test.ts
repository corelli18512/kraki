/**
 * K-198: a sign-in the relay refuses for a reason that may pass is retried on
 * the reconnect backoff, never at once (it used to retry 12-16 times a
 * second), and a refused region redirect says what is going on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  githubClientId: undefined,
  setLastError: vi.fn(),
  setReconnectState: vi.fn(),
  setStatus: vi.fn(),
}));
vi.mock('./store-adapter', () => ({ getStore: () => store }));

import { processAuthError } from './auth';
import { KrakiTransport } from './transport';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); localStorage.clear(); });

describe('K-198: auth error backoff', () => {
  it('repeated transient auth errors reconnect with growing delays', async () => {
    vi.useFakeTimers();
    localStorage.setItem('kraki_device', JSON.stringify({ relay: 'ws://127.0.0.1:6260', deviceId: 'web-1' }));
    let opens = 0;
    // The relay answers every sign-in with auth_unavailable.
    const transport: KrakiTransport = new KrakiTransport({
      onOpen: async () => { opens++; processAuthError({ code: 'auth_unavailable' }, 'web-1', deps); },
      onParsedMessage: vi.fn(),
    }, 'ws://127.0.0.1:6260');
    const deps = {
      clearStoredDeviceId: vi.fn(), setStoredDeviceId: vi.fn(), redirectToRelay: vi.fn(),
      disconnect: () => transport.disconnect(), connect: () => transport.connect(),
      reconnectLater: () => transport.retryLater(), currentRelay: transport.url,
    };
    try {
      transport.connect();
      await vi.advanceTimersByTimeAsync(3_000);
      // 0.5 s, 1 s, 2 s (±20 %): a handful of attempts in 3 s, not dozens.
      expect(opens).toBeGreaterThanOrEqual(2);
      expect(opens).toBeLessThanOrEqual(4);
      expect(store.setLastError).toHaveBeenLastCalledWith('Authentication temporarily unavailable. Reconnecting…');
      expect(transport.storedDeviceId).toBe('web-1');
    } finally {
      transport.disconnect();
    }
  });

  it('a refused region redirect says so instead of a generic reconnecting message', () => {
    const deps = {
      clearStoredDeviceId: vi.fn(), setStoredDeviceId: vi.fn(), redirectToRelay: vi.fn(),
      disconnect: vi.fn(), connect: vi.fn(), reconnectLater: vi.fn(), currentRelay: 'wss://relay.kraki.chat',
    };
    processAuthError({ code: 'wrong_region', redirect: 'wss://evil.example' }, 'web-1', deps);
    expect(deps.reconnectLater).toHaveBeenCalledOnce();
    expect(store.setLastError).toHaveBeenCalledWith("This server asked to move you to a server Kraki doesn't trust. Retrying…");
  });
});
