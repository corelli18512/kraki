/**
 * K-093 / K-005: a session_list from a computer is untrusted input. A
 * malformed list must not empty the sidebar, and a non-text title must not
 * reach rendering. A frame that parses to `null` must not throw in transport.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KrakiWSClient } from './ws-client';
import { KrakiTransport } from './transport';
import { useStore } from '../hooks/useStore';
import { messageProvider } from './message-provider';

vi.mock('./message-db', () => ({
  putMessage: async () => {},
  putMessages: async () => {},
  getMessages: async () => [],
  getMessagesInRange: async () => [],
  getAllMessages: async () => new Map(),
  getLastSeq: async () => 0,
  deleteSessionMessages: async () => {},
  updateSessionMessages: async () => {},
  clearAllMessages: async () => {},
}));

const now = new Date().toISOString();
const digest = (id: string, extra: Record<string, unknown> = {}) => ({
  id, agent: 'pi', state: 'idle', mode: 'execute', lastSeq: 0, readSeq: 0, messageCount: 0, createdAt: now, title: `T ${id}`, ...extra,
});
const list = (payload: unknown) => ({ type: 'session_list', deviceId: 'dev-t1', seq: 1, timestamp: now, payload });

describe('session_list shape (K-093, K-005)', () => {
  let client: KrakiWSClient;
  const apply = (msg: unknown) => (client as unknown as { handleSessionList(m: unknown): void }).handleSessionList(msg);
  const ids = () => [...useStore.getState().sessions.keys()].sort();

  beforeEach(() => {
    useStore.getState().reset();
    messageProvider.clear();
    client = new KrakiWSClient('ws://localhost:9999');
    apply(list({ sessions: [digest('a'), digest('b')] }));
  });
  afterEach(() => { messageProvider.clear(); vi.restoreAllMocks(); });

  it.each([
    ['no payload', undefined],
    ['no sessions', {}],
    ['sessions is an object', { sessions: { a: 1 } }],
    ['sessions is a string', { sessions: 'oops' }],
    ['sessions is null', { sessions: null }],
  ])('ignores a list with %s and keeps the sidebar', (_name, payload) => {
    expect(() => apply(list(payload))).not.toThrow();
    expect(ids()).toEqual(['a', 'b']);
  });

  it('skips malformed entries without removing sessions it cannot account for', () => {
    expect(() => apply(list({ sessions: [null, 7, { title: 'no id' }, digest('a', { title: 'A2' })] }))).not.toThrow();
    expect(ids()).toEqual(['a', 'b']);
    expect(useStore.getState().sessions.get('a')?.title).toBe('A2');
  });

  it('a well-formed list still removes sessions that are gone', () => {
    apply(list({ sessions: [digest('a')] }));
    expect(ids()).toEqual(['a']);
  });

  it('stores a non-text title as absent', () => {
    apply(list({ sessions: [digest('a', { title: 42, autoTitle: { x: 1 } }), digest('b')] }));
    const a = useStore.getState().sessions.get('a');
    expect(a?.title).toBeUndefined();
    expect(a?.autoTitle).toBeUndefined();
  });
});

describe('transport frame shape (K-093)', () => {
  it('a frame that parses to null or a number is dropped without throwing', async () => {
    const onParsedMessage = vi.fn();
    const transport = new KrakiTransport({ onOpen: async () => {}, onParsedMessage }, 'ws://localhost:9999');
    transport.connect();
    const ws = (transport as unknown as { ws: { onmessage: (e: { data: string }) => void } }).ws;
    expect(() => ws.onmessage({ data: 'null' })).not.toThrow();
    expect(() => ws.onmessage({ data: '5' })).not.toThrow();
    expect(onParsedMessage).not.toHaveBeenCalled();
    ws.onmessage({ data: JSON.stringify({ type: 'pong' }) });
    expect(onParsedMessage).toHaveBeenCalledTimes(1);
    transport.disconnect();
  });
});
