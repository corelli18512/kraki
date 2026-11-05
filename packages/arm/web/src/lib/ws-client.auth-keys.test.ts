import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KrakiWSClient } from './ws-client';
import { useStore } from '../hooks/useStore';

vi.mock('./message-db', () => ({
  putMessage: async () => {},
  putMessages: async () => {},
  getMessages: async () => [],
  getAllMessages: async () => new Map(),
  getLastSeq: async () => 0,
  deleteSessionMessages: async () => {},
  updateSessionMessages: async () => {},
  clearAllMessages: async () => {},
}));

/** A key store whose init() the test settles (slow key generation, or a
 *  browser that cannot keep keys at all). */
const keys = vi.hoisted(() => {
  const state = {
    ready: false,
    pending: [] as Array<{ resolve: () => void; reject: (err: Error) => void }>,
    init: () => new Promise<void>((resolve, reject) => {
      state.pending.push({ resolve: () => { state.ready = true; resolve(); }, reject });
    }),
    settle(ok: boolean) {
      for (const p of state.pending.splice(0)) ok ? p.resolve() : p.reject(new Error('IndexedDB unavailable'));
    },
  };
  return state;
});

vi.mock('./e2e', () => ({
  createAppKeyStore: () => ({
    isReady: () => keys.ready,
    init: () => keys.init(),
    getSigningPublicKey: async () => 'signing-key',
    getPublicKey: async () => 'encryption-key',
  }),
}));

type MockSocket = WebSocket & { sentMessages: string[]; _receive: (data: Record<string, unknown>) => void };
const socketOf = (client: KrakiWSClient) =>
  (client as unknown as { transport: { ws: MockSocket | null } }).transport.ws;
const authsOn = (ws: MockSocket) =>
  ws.sentMessages.map((raw) => JSON.parse(raw) as { type: string; auth?: { method: string; token?: string } })
    .filter((m) => m.type === 'auth');

beforeEach(() => {
  vi.useFakeTimers();
  keys.ready = false;
  keys.pending = [];
  localStorage.clear();
  useStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('KrakiWSClient auth while the keys are being created', () => {
  it('K-094: a socket that closed during key generation does not put a second auth on the next socket', async () => {
    const client = new KrakiWSClient('ws://localhost:9999');
    client.pairWithToken('ws://localhost:9999', 'pt_slow');
    await vi.advanceTimersByTimeAsync(1);
    const first = socketOf(client)!;
    expect(authsOn(first)).toHaveLength(0); // waiting for the keys

    // The relay drops the socket before the keys are ready; the client reconnects.
    first.readyState = 3;
    first.onclose?.({} as CloseEvent);
    await vi.advanceTimersByTimeAsync(2_000);
    const second = socketOf(client)!;
    expect(second).not.toBe(first);

    keys.settle(true);
    await vi.advanceTimersByTimeAsync(1);

    expect(authsOn(first)).toHaveLength(0);
    expect(authsOn(second)).toEqual([expect.objectContaining({ auth: { method: 'pairing', token: 'pt_slow' } })]);
    client.disconnect();
  });

  it('K-092: a browser that cannot keep keys does not half-pair; it says why and keeps the code unspent', async () => {
    const client = new KrakiWSClient('ws://localhost:9999');
    client.pairWithToken('ws://localhost:9999', 'pt_nokeys');
    await vi.advanceTimersByTimeAsync(1);
    const ws = socketOf(client)!;
    keys.settle(false); // connect()'s init
    await vi.advanceTimersByTimeAsync(1);
    keys.settle(false); // authenticate()'s retry
    await vi.advanceTimersByTimeAsync(1);

    expect(authsOn(ws)).toHaveLength(0);
    expect(useStore.getState().status).toBe('awaiting_login');
    expect(useStore.getState().lastError).toBe(
      'This browser can’t keep Kraki’s encryption keys, so it can’t sign in. Open Kraki over HTTPS in a regular (not private) window.');
    // No reconnect loop afterwards.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socketOf(client)).toBeNull();
  });
});
