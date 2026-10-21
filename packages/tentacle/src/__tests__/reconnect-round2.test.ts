import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { transpileModule } from 'typescript';

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
import { handleSessionMessages } from '../relay/history.js';

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

describe('PR577 round2 Tentacle revocation wire compatibility', () => {
  it('1012 key_changed reconnect requests challenge without forgetting token or device id', async () => {
    const c = client('qa-token'); const fatal = vi.fn(); c.onFatalError = fatal; c.connect(); sockets[0].emit('open');
    sockets[0].close(); await vi.advanceTimersByTimeAsync(50);
    sockets.at(-1)!.emit('open');
    expect(JSON.parse(sockets.at(-1)!.sent[0]).auth).toEqual({ method: 'challenge', deviceId: 'r2-t' });
    expect(fatal).not.toHaveBeenCalled();
  });
  it('unknown_device with token switches from challenge to full sign-in', async () => {
    const c = client('qa-token'); c.connect(); sockets[0].emit('open');
    sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'auth_error', code: 'unknown_device', message: 'removed' })));
    await vi.advanceTimersByTimeAsync(50); sockets.at(-1)!.emit('open');
    const auth = JSON.parse(sockets.at(-1)!.sent[0]);
    expect(auth.auth).toEqual({ method: 'github_token', token: 'qa-token' });
    expect(auth.device.deviceId).toBe('r2-t');
  });
  it('unknown_device without token stops exactly once without an infinite reconnect loop', async () => {
    const c = client(); const removed = vi.fn(); c.onDeviceRemoved = removed; c.connect(); sockets[0].emit('open');
    sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'auth_error', code: 'unknown_device', message: 'removed' })));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(removed).toHaveBeenCalledTimes(1); expect(sockets).toHaveLength(1);
  });
});

function fixture(handler: typeof handleSessionMessages, cursor?: number) {
  const rows = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, type: 'agent_message', payload: JSON.stringify({ type: 'agent_message', payload: { content: 'row' } }) }));
  const send = vi.fn();
  const c = { consumerKeys: new Map([['app', 'key']]), authInfo: { deviceId: 't' }, seqCounter: 0,
    sessionManager: { getMeta: () => ({ lastSeq: 10 }), findTurnAlignedStart: () => 4, getMessagesAfterSeq: (_sid: string, after: number) => rows.filter((r) => r.seq > after) },
    sendReliableUnicastTo: send };
  handler(c as unknown as RelayClient, 'app', 'sid', undefined, cursor);
  return send.mock.lastCall![2].payload.messages.map((m: { seq: number }) => m.seq);
}

describe('actual origin/main Tentacle history mixed with new/old apps', () => {
  const source = execFileSync('git', ['show', 'origin/main:packages/tentacle/src/relay/history.ts'], { encoding: 'utf8' });
  const start = source.indexOf('export function handleSessionMessages(');
  const end = source.indexOf('\n/**', start);
  const js = transpileModule(source.slice(start, end).replace('export function', 'function'), {}).outputText;
  const old = new Function('RelayClient', 'logger', `${js}; return handleSessionMessages;`)(RelayClient, { info: vi.fn(), warn: vi.fn() }) as typeof handleSessionMessages;
  it('old Tentacle receives an afterSeq-less request and still returns a whole latest turn', () => {
    expect(fixture(old)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(fixture(handleSessionMessages)).toEqual(fixture(old));
  });
  it('old Tentacle safely ignores a new app cursor (duplicate rows, not a lost delta)', () => {
    expect(fixture(old, 8)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(fixture(handleSessionMessages, 8)).toEqual([9, 10]);
  });
});
