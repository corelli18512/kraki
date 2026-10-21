import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./store-adapter', () => ({ getStore: () => ({ setStatus: vi.fn(), setReconnectState: vi.fn(), setLastError: vi.fn() }) }));
import { KrakiTransport } from './transport';

const Original = globalThis.WebSocket;
afterEach(() => { globalThis.WebSocket = Original; vi.useRealTimers(); });

describe('PR577 Web key_changed wire close', () => {
  it('1012 reconnects with the same stored identity, unlike a replaced-tab close', async () => {
    vi.useFakeTimers();
    localStorage.setItem('kraki_device', JSON.stringify({ relay: 'ws://127.0.0.1:4000', deviceId: 'r2-web' }));
    const sockets: WebSocket[] = [];
    globalThis.WebSocket = class extends Original {
      constructor(url: string | URL) { super(url); sockets.push(this); }
    };
    const opened = vi.fn(async () => {});
    const transport = new KrakiTransport({ onOpen: opened, onParsedMessage: vi.fn() }, 'ws://127.0.0.1:4000');
    try {
      transport.connect(); await vi.advanceTimersByTimeAsync(1);
      sockets[0].onclose?.({ code: 1012, reason: 'reauthenticate' } as CloseEvent);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(2);
      expect(opened).toHaveBeenCalledTimes(2);
      expect(transport.storedDeviceId).toBe('r2-web');
      expect(localStorage.getItem('kraki_device')).not.toBeNull();
    } finally { transport.disconnect(); }
  });
});
