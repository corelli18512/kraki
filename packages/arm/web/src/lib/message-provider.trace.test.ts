import { describe, it, expect, beforeEach, vi } from 'vitest';

// message-provider persists nothing itself; it drives the store. Mock IDB so the
// store's fire-and-forget writes don't touch a real IndexedDB.
vi.mock('./message-db', () => ({
  putMessage: async () => {},
  putMessages: async () => {},
  getMessages: async () => [],
  getAllMessages: async () => new Map(),
  getLastSeq: async () => 0,
  getMessagesInRange: async () => [],
  deleteSessionMessages: async () => {},
  updateSessionMessages: async () => {},
  clearAllMessages: async () => {},
}));

import { messageProvider } from './message-provider';
import { useStore } from '../hooks/useStore';
import type { ChatMessage } from '../types/store';

function m(type: string, seq: number, payload: Record<string, unknown> = {}): ChatMessage {
  return { type, sessionId: 's1', deviceId: 'd1', seq, timestamp: '', payload } as unknown as ChatMessage;
}

function trace(type: 'tool_start' | 'tool_complete', toolCallId: string): ChatMessage {
  return { type, sessionId: 's1', deviceId: 'd1', seq: 9000, timestamp: '', payload: { toolName: 'read_file', toolCallId, headline: 'x' } } as unknown as ChatMessage;
}

describe('MessageProvider — TRACE axis', () => {
  let sent: Array<Record<string, unknown>>;

  beforeEach(() => {
    useStore.getState().reset();
    useStore.setState({ deviceId: 'web-dev' });
    messageProvider.clear();
    sent = [];
    messageProvider.setSend((msg) => sent.push(msg));
    messageProvider.setTentacleInfo('s1', 10, 'tentacle-dev');
    // The tentacle must be encryptable for a background trace pull to fire.
    useStore.getState().upsertDevice({
      id: 'tentacle-dev', name: 'tentacle', role: 'agent', online: true, encryptionKey: 'k',
    } as unknown as import('@kraki/protocol').DeviceSummary);
  });

  it('requestTurnTrace emits request_turn_trace with target device + bubbleSeq', () => {
    messageProvider.requestTurnTrace('s1', 5);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('request_turn_trace');
    expect(sent[0].payload).toMatchObject({ sessionId: 's1', bubbleSeq: 5, targetDeviceId: 'tentacle-dev' });
  });

  it('dedups repeated pulls for the same bubble', () => {
    messageProvider.requestTurnTrace('s1', 5);
    messageProvider.requestTurnTrace('s1', 5);
    messageProvider.requestTurnTrace('s1', 5);
    expect(sent.filter((x) => x.type === 'request_turn_trace')).toHaveLength(1);
  });

  it('invalidateTurnTrace allows a fresh re-pull (idle reconciliation)', () => {
    messageProvider.requestTurnTrace('s1', 5);
    messageProvider.invalidateTurnTrace('s1', 5);
    messageProvider.requestTurnTrace('s1', 5);
    expect(sent.filter((x) => x.type === 'request_turn_trace')).toHaveLength(2);
  });

  it('does not send when the tentacle device is unknown', () => {
    messageProvider.requestTurnTrace('unknown-session', 3);
    expect(sent).toHaveLength(0);
  });

  it('skips the pull silently when the tentacle has no encryption key, and retries once it arrives', () => {
    // Simulate an offline tentacle whose encryption key isn't known yet.
    useStore.getState().upsertDevice({
      id: 'tentacle-dev', name: 'tentacle', role: 'agent', online: false,
    } as unknown as import('@kraki/protocol').DeviceSummary);
    messageProvider.requestTurnTrace('s1', 5);
    expect(sent).toHaveLength(0);
    // Key arrives (device greeting) → the same pull now succeeds (not marked pulled).
    useStore.getState().upsertDevice({
      id: 'tentacle-dev', name: 'tentacle', role: 'agent', online: true, encryptionKey: 'k',
    } as unknown as import('@kraki/protocol').DeviceSummary);
    messageProvider.requestTurnTrace('s1', 5);
    expect(sent.filter((x) => x.type === 'request_turn_trace')).toHaveLength(1);
  });

  it('handleTurnTraceBatch injects steps into the turn via setTurnSteps', () => {
    // A concluded turn already in the store, with its tool steps missing
    // (reloaded from history — TRACE axis not on the spine).
    const store = useStore.getState();
    store.prependMessages('s1', [
      m('user_message', 4, { content: 'do it' }),
      m('agent_message', 5, { content: 'done' }),
    ]);

    messageProvider.handleTurnTraceBatch('s1', 5, [
      trace('tool_start', 'tc1'),
      trace('tool_complete', 'tc1'),
    ], true);

    const list = useStore.getState().messages.get('s1')!.map((x) => x.type);
    // tools land BEFORE the concluding bubble, after the user_message
    expect(list).toEqual(['user_message', 'tool_start', 'tool_complete', 'agent_message']);
  });

  it('handleTurnTraceBatch keeps the pull re-triggerable when turn incomplete', () => {
    const store = useStore.getState();
    store.prependMessages('s1', [
      m('user_message', 4, {}),
      m('agent_message', 5, {}),
    ]);
    // complete=false → provider must allow a later re-pull for the same bubble.
    messageProvider.requestTurnTrace('s1', 5);
    messageProvider.handleTurnTraceBatch('s1', 5, [trace('tool_start', 'tc1')], false);
    messageProvider.requestTurnTrace('s1', 5);
    expect(sent.filter((x) => x.type === 'request_turn_trace')).toHaveLength(2);
  });
});
