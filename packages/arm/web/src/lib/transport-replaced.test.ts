/**
 * Two tabs = two real KrakiWSClient instances sharing the same localStorage
 * `kraki_device` (2026-10-07: one Web identity re-authenticated 2351 times in
 * two hours). The fake relay behaves like Head's evictPreviousConnection():
 * a new auth for the device closes the previous socket. Before the fix that
 * close was a bare terminate (1006) and the tabs evicted each other ~1/s.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { KrakiWSClient } from './ws-client';
import { useStore } from '../hooks/useStore';
import { REPLACED_ELSEWHERE_MESSAGE } from './transport';

vi.mock('./message-db', () => ({
  putMessage: async () => {}, putMessages: async () => {}, getMessages: async () => [],
  getAllMessages: async () => new Map(), getLastSeq: async () => 0, deleteSessionMessages: async () => {},
  updateSessionMessages: async () => {}, clearAllMessages: async () => {},
}));
vi.mock('./e2e', () => ({
  createAppKeyStore: () => ({
    isReady: () => true, init: async () => {},
    getSigningPublicKey: async () => 'k', getPublicKey: async () => 'k',
    sign: async () => 'sig', signChallenge: async () => 'sig',
  }),
}));

type Sock = {
  url: string; readyState: number; sentMessages: string[];
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  _receive(d: unknown): void;
};

const Original = globalThis.WebSocket;
afterEach(() => { globalThis.WebSocket = Original; vi.useRealTimers(); });

function installRelay(closeCode: number) {
    // Fake relay: the device has at most one live socket.
    const relay = { live: null as Sock | null, auths: 0, sockets: [] as Sock[] };
    globalThis.WebSocket = class extends (Original as unknown as { new (u: string): Sock }) {
      constructor(url: string) {
        super(url);
        relay.sockets.push(this as unknown as Sock);
        const self = this as unknown as Sock;
        const origSend = (self as unknown as { send: (d: string) => void }).send.bind(self);
        (self as unknown as { send: (d: string) => void }).send = (data: string) => {
          origSend(data);
          const msg = JSON.parse(data) as { type?: string };
          if (msg.type === 'ping') { setTimeout(() => self.readyState === 1 && self._receive({ type: 'pong' }), 5); return; }
          if (msg.type !== 'auth' && msg.type !== 'auth_response') return;
          setTimeout(() => {
            if (self.readyState !== 1) return;
            relay.auths += 1;
            const prev = relay.live;
            relay.live = self;
            self._receive({ type: 'auth_ok', deviceId: 'dev_web_shared', devices: [] });
            if (prev && prev !== self && prev.readyState === 1) {
              prev.readyState = 3;
              prev.onclose?.({ code: closeCode, reason: closeCode === 4009 ? 'replaced' : '', wasClean: closeCode !== 1006 });
            }
          }, 300); // ≈ backend auth latency
        };
      }
    } as unknown as typeof WebSocket;
    return relay;
}

describe('two Web tabs with one stored identity', () => {
  it('settles: the replaced tab stays offline instead of evicting its twin', async () => {
    vi.useFakeTimers();
    useStore.getState().reset();
    localStorage.setItem('kraki_device', JSON.stringify({ relay: 'ws://relay', deviceId: 'dev_web_shared' }));
    const relay = installRelay(4009);
    const tabA = new KrakiWSClient('ws://relay');
    const tabB = new KrakiWSClient('ws://relay');
    tabA.connect();
    tabB.connect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(relay.auths).toBeLessThanOrEqual(2);
    expect(useStore.getState().lastError).toBe(REPLACED_ELSEWHERE_MESSAGE);
    expect(useStore.getState().reconnectAttempts).toBe(0); // no "Reconnecting…"

    // Focusing the replaced tab takes the connection back (once).
    const before = relay.auths;
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(relay.auths).toBeGreaterThanOrEqual(before + 1);
    expect(relay.auths).toBeLessThanOrEqual(before + 2);
    tabA.disconnect();
    tabB.disconnect();
  }, 30_000);

  it('control: an unexplained drop (1006) still reconnects', async () => {
    vi.useFakeTimers();
    useStore.getState().reset();
    localStorage.setItem('kraki_device', JSON.stringify({ relay: 'ws://relay', deviceId: 'dev_web_shared' }));

    const relay = installRelay(1006);
    const tabA = new KrakiWSClient('ws://relay');
    const tabB = new KrakiWSClient('ws://relay');
    tabA.connect();
    tabB.connect();
    await vi.advanceTimersByTimeAsync(60_000);
    tabA.disconnect();
    tabB.disconnect();

    // Without a reason the client cannot tell eviction from a network drop and
    // must keep reconnecting (this is the pre-fix behaviour of the relay).
    expect(relay.auths).toBeGreaterThan(40);
  }, 30_000);
});
