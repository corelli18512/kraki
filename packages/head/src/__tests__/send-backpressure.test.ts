/**
 * A full send buffer holds frames back instead of disconnecting the client
 * (QA K-296): on a slow link a reconnect resent the whole backlog at once,
 * filled the buffer and was cut again, forever. Only a buffer that does not
 * drain at all for STALLED_SEND_TIMEOUT_MS is a stalled client.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { HeadServer } from '../server.js';
import { Storage } from '../storage.js';
import { OpenAuthProvider } from '../auth.js';
import { MAX_WS_BUFFERED_BYTES, STALLED_SEND_TIMEOUT_MS, type ClientState } from '../server/shared.js';

interface FakeSocket { readyState: number; bufferedAmount: number; send: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }

function setup() {
  const storage = new Storage(':memory:');
  const server = new HeadServer(storage, { authProvider: new OpenAuthProvider() });
  const ws: FakeSocket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: vi.fn(), terminate: vi.fn(), close: vi.fn() };
  const internals = server as unknown as {
    connections: Map<string, unknown>;
    clients: Map<unknown, ClientState>;
    sendPulseFrameTo(deviceId: string, pulseB64: string): boolean;
  };
  internals.connections.set('dev-slow', ws);
  internals.clients.set(ws, { authenticated: true, deviceId: 'dev-slow', isAlive: true, pongOverdueAt: null, pendingLivenessBroadcast: false });
  return { storage, server, ws, send: (frame: string) => internals.sendPulseFrameTo('dev-slow', frame) };
}

afterEach(() => vi.useRealTimers());

describe('HeadServer send backpressure (K-296)', () => {
  it('holds frames back while a slow client drains, and sends again once it has', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { storage, server, ws, send } = setup();
    try {
      ws.bufferedAmount = MAX_WS_BUFFERED_BYTES + 1_000;
      expect(send('a')).toBe(true);
      // Draining slowly but steadily: never cut, however long it takes.
      for (let i = 0; i < 10; i++) {
        vi.setSystemTime(Date.now() + STALLED_SEND_TIMEOUT_MS / 2);
        ws.bufferedAmount -= 1;
        expect(send(`b${i}`)).toBe(true);
      }
      expect(ws.terminate).not.toHaveBeenCalled();
      expect(ws.send).not.toHaveBeenCalled();
      ws.bufferedAmount = 0;
      expect(send('c')).toBe(true);
      expect(ws.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(ws.send.mock.calls[0]![0] as string)).toMatchObject({ pulse: 'c' });
    } finally { server.close(); storage.close(); }
  });

  it('disconnects a client whose full buffer does not drain at all', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { storage, server, ws, send } = setup();
    try {
      ws.bufferedAmount = MAX_WS_BUFFERED_BYTES + 1;
      send('a');
      vi.setSystemTime(Date.now() + STALLED_SEND_TIMEOUT_MS - 1);
      send('b');
      expect(ws.terminate).not.toHaveBeenCalled();
      vi.setSystemTime(Date.now() + 1);
      expect(send('c')).toBe(false);
      expect(ws.terminate).toHaveBeenCalledTimes(1);
    } finally { server.close(); storage.close(); }
  });
});
