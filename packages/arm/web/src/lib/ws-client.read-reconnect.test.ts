/**
 * K-095: a read made while the relay link is down (or still on its way to the
 * Tentacle) must not be undone by a session_list built before the Tentacle
 * applied it. Chromium/WebKit flashed the unread dot; Firefox lost the read.
 * The browser keeps its read and sends it once more.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { KrakiWSClient } from './ws-client';
import { useStore } from '../hooks/useStore';
import { messageProvider } from './message-provider';
import { CommandState } from './commands';
import { handleDataMessage } from './message-router';
import type { InnerMessage } from '@kraki/protocol';

const recent = new Date(Date.now() - 60_000).toISOString();
function sessionList(readSeq: number, lastSeq = 10) {
  return {
    type: 'session_list', deviceId: 'dev-t1', seq: 1, timestamp: recent,
    payload: { sessions: [{ id: 's1', agent: 'pi', state: 'idle', mode: 'execute', lastSeq, readSeq, messageCount: lastSeq, createdAt: recent, title: 'S1' }], archivedCount: 0, autoArchiveDays: 14 },
  };
}

describe('a read not yet applied by the Tentacle survives a session_list (K-095)', () => {
  let client: KrakiWSClient;
  let send: ReturnType<typeof vi.spyOn>;
  const apply = (msg: unknown) => (client as unknown as { handleSessionList(m: unknown): void }).handleSessionList(msg);
  const reads = () => send.mock.calls.filter(([m]) => (m as { type: string }).type === 'mark_read').map(([m]) => (m as { payload: { seq: number } }).payload.seq);

  beforeEach(() => {
    useStore.getState().reset();
    messageProvider.clear();
    client = new KrakiWSClient('ws://localhost:9999');
    send = vi.spyOn(client, 'sendEncrypted').mockImplementation(() => {});
    apply(sessionList(4));
    expect(useStore.getState().unreadCount.get('s1')).toBe(1);
  });
  afterEach(() => { vi.restoreAllMocks(); messageProvider.clear(); });

  it('keeps the local read against an older list and sends it once more', () => {
    client.markRead('s1');
    expect(reads()).toEqual([10]);
    apply(sessionList(4));
    expect(useStore.getState().sessions.get('s1')?.readSeq).toBe(10);
    expect(useStore.getState().unreadCount.has('s1')).toBe(false);
    expect(reads()).toEqual([10, 10]);
    // Sent again once only: a later list is authoritative again.
    apply(sessionList(4));
    expect(useStore.getState().sessions.get('s1')?.readSeq).toBe(4);
    expect(reads()).toEqual([10, 10]);
  });

  it('a list that includes the read confirms it without sending again', () => {
    client.markRead('s1');
    apply(sessionList(10));
    apply(sessionList(4));
    expect(useStore.getState().sessions.get('s1')?.readSeq).toBe(4);
    expect(reads()).toEqual([10]);
  });

  it('Mark Unread here, or a session_read from the Tentacle, ends the tracking', () => {
    client.markRead('s1');
    client.markUnread('s1');
    apply(sessionList(4));
    expect(useStore.getState().sessions.get('s1')?.readSeq).toBe(4);

    client.markRead('s1');
    handleDataMessage({ type: 'session_read', deviceId: 'dev-t1', seq: 0, timestamp: recent, sessionId: 's1', payload: { seq: 9 } } as unknown as InnerMessage,
      { cmdState: new CommandState(), messageProvider } as never);
    apply(sessionList(4));
    expect(useStore.getState().sessions.get('s1')?.readSeq).toBe(4);
    expect(reads()).toEqual([10, 10]);
  });
});
