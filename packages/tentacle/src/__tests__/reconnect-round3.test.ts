import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sockets, Socket } = vi.hoisted(() => {
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    handlers = new Map<string, Array<(...a: unknown[]) => void>>();
    constructor(public url: string) { sockets.push(this); }
    on(e: string, f: (...a: unknown[]) => void) { this.handlers.set(e, [...this.handlers.get(e) ?? [], f]); }
    emit(e: string, ...a: unknown[]) { for (const f of this.handlers.get(e) ?? []) f(...a); }
    send(s: string) { this.sent.push(s); }
    close() { this.readyState = 3; this.emit('close', 1012, Buffer.from('reauthenticate')); }
  }
  const sockets: Socket[] = [];
  return { sockets, Socket };
});
vi.mock('ws', () => ({ WebSocket: Socket }));
vi.mock('../logger.js', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));
import { RelayClient } from '../relay-client.js';

const clients: RelayClient[] = [];
function client(token?: string) {
  const c = new RelayClient({}, { getResumableSessions: () => [], getSessionList: () => [] }, {
    relayUrl: 'ws://127.0.0.1:4000', authMethod: 'github_token', token, device: { deviceId: 'r2-t', name: 'r2', role: 'tentacle' },
    localLink: false, deviceTrust: 'compatible', reconnectDelay: 10,
  }, { getCompactPublicKey: () => 'pub', getKeyPair: () => ({ publicKey: 'pub', privateKey: 'private' }) });
  clients.push(c); return c;
}
beforeEach(() => { sockets.length = 0; vi.useFakeTimers(); });
afterEach(() => { clients.splice(0).forEach((c) => c.disconnect()); vi.useRealTimers(); });

describe('PR577 round3 retryable foreground epoch veto', () => {
  it('service_unavailable retries the same stored device challenge without fatal or removal callbacks', async () => {
    const c = client('qa-token'); const fatal = vi.fn(), removed = vi.fn();
    c.onFatalError = fatal; c.onDeviceRemoved = removed;
    c.connect(); sockets[0].emit('open');
    sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'auth_error', code: 'service_unavailable', message: 'Device changed during sign-in, try again' })));
    await vi.advanceTimersByTimeAsync(50); sockets.at(-1)!.emit('open');
    expect(JSON.parse(sockets.at(-1)!.sent[0]).auth).toEqual({ method: 'challenge', deviceId: 'r2-t' });
    expect(fatal).not.toHaveBeenCalled(); expect(removed).not.toHaveBeenCalled();
  });
});
