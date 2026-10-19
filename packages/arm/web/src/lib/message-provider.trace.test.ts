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

  it('distinguishes a confirmed empty trace from an in-flight pull', () => {
    messageProvider.requestTurnTrace('s1', 5);
    expect(messageProvider.isTurnTraceLoaded('s1', 5)).toBe(false);
    messageProvider.handleTurnTraceBatch('s1', 5, [], false);
    expect(messageProvider.isTurnTraceLoaded('s1', 5)).toBe(false);
    messageProvider.handleTurnTraceBatch('s1', 5, [], true);
    expect(messageProvider.isTurnTraceLoaded('s1', 5)).toBe(true);
    messageProvider.invalidateTurnTrace('s1', 5);
    expect(messageProvider.isTurnTraceLoaded('s1', 5)).toBe(true);
    messageProvider.handleTurnTraceBatch('s1', 5, [], false);
    expect(messageProvider.isTurnTraceLoaded('s1', 5)).toBe(false);
  });

  it('dedups repeated pulls for the same bubble', () => {
    messageProvider.requestTurnTrace('s1', 5);
    messageProvider.requestTurnTrace('s1', 5);
    messageProvider.requestTurnTrace('s1', 5);
    expect(sent.filter((x) => x.type === 'request_turn_trace')).toHaveLength(1);
  });

  it('coalesces an in-flight invalidation into one refresh after the response', () => {
    messageProvider.requestTurnTrace('s1', 5);
    messageProvider.invalidateTurnTrace('s1', 5);
    messageProvider.requestTurnTrace('s1', 5);
    expect(sent.filter((x) => x.type === 'request_turn_trace')).toHaveLength(1);

    messageProvider.handleTurnTraceBatch('s1', 5, [], true);
    expect(sent.filter((x) => x.type === 'request_turn_trace')).toHaveLength(2);
  });

  it('allows only one cross-bubble trace pull in flight', () => {
    messageProvider.setTentacleInfo('s2', 10, 'tentacle-dev');
    messageProvider.setTentacleInfo('s3', 10, 'tentacle-dev');
    messageProvider.requestTurnTrace('s1', 5);
    messageProvider.requestTurnTrace('s2', 6);
    messageProvider.requestTurnTrace('s3', 7);
    expect(sent.filter((x) => x.type === 'request_turn_trace')).toHaveLength(1);

    messageProvider.handleTurnTraceBatch('s1', 5, [], true);
    expect(sent.filter((x) => x.type === 'request_turn_trace')).toHaveLength(2);
    expect(sent.at(-1)?.payload).toMatchObject({ sessionId: 's2', bubbleSeq: 6 });

    messageProvider.handleTurnTraceBatch('s2', 6, [], true);
    expect(sent.filter((x) => x.type === 'request_turn_trace')).toHaveLength(3);
    expect(sent.at(-1)?.payload).toMatchObject({ sessionId: 's3', bubbleSeq: 7 });
  });

  it('collapses repeated in-flight invalidations to one refresh', () => {
    messageProvider.requestTurnTrace('s1', 5);
    for (let i = 0; i < 100; i++) {
      messageProvider.invalidateTurnTrace('s1', 5);
      messageProvider.requestTurnTrace('s1', 5);
    }
    expect(sent.filter((x) => x.type === 'request_turn_trace')).toHaveLength(1);

    messageProvider.handleTurnTraceBatch('s1', 5, [], true);
    expect(sent.filter((x) => x.type === 'request_turn_trace')).toHaveLength(2);
    messageProvider.handleTurnTraceBatch('s1', 5, [], true);
    expect(sent.filter((x) => x.type === 'request_turn_trace')).toHaveLength(2);
  });

  it('releases the global trace window after a response timeout', () => {
    vi.useFakeTimers();
    try {
      messageProvider.setTentacleInfo('s2', 10, 'tentacle-dev');
      messageProvider.requestTurnTrace('s1', 5);
      messageProvider.requestTurnTrace('s2', 6);
      expect(sent.filter((x) => x.type === 'request_turn_trace')).toHaveLength(1);

      vi.advanceTimersByTime(15_000);
      expect(sent.filter((x) => x.type === 'request_turn_trace')).toHaveLength(2);
      expect(sent.at(-1)?.payload).toMatchObject({ sessionId: 's2', bubbleSeq: 6 });
    } finally {
      messageProvider.clear();
      vi.useRealTimers();
    }
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

  it.each([
    { turnB: 'live', empty: false },
    { turnB: 'live', empty: true },
    { turnB: 'concluded', empty: false },
    { turnB: 'concluded', empty: true },
  ])('preserves $turnB turn B when A’s delayed live response arrives (empty=$empty)', async ({ turnB, empty }) => {
    const store = useStore.getState();
    store.appendMessage('s1', m('user_message', 1));
    store.appendMessage('s1', trace('tool_start', 'a-old'));
    messageProvider.requestTurnTrace('s1', 1);

    // Another client concludes A and starts B before A's live pull returns.
    store.appendMessage('s1', m('agent_message', 2));
    store.appendMessage('s1', m('idle', 3));
    store.appendMessage('s1', m('user_message', 4));
    if (turnB === 'concluded') store.appendMessage('s1', m('agent_message', 5));
    messageProvider.handleTurnTraceBatch('s1', turnB === 'live' ? 4 : 5, [
      trace('tool_start', 'b'), trace('tool_complete', 'b'),
      m('permission', 9001, { id: 'b-permission', decision: 'allow' }),
      m('agent_narration', 9002, { content: 'B narration' }),
      m('error', 9003, { message: 'B error' }),
    ], turnB === 'concluded');
    const before = useStore.getState().messages.get('s1')!;
    const bStart = before.findIndex((msg) => msg.type === 'user_message' && msg.seq === 4);
    const expectedB = before.slice(bStart);
    const response = empty ? [] : [trace('tool_complete', 'a-new'), m('error', 9001, { message: 'A error' })];

    messageProvider.handleTurnTraceBatch('s1', 1, response, false);

    const after = useStore.getState().messages.get('s1')!;
    expect(after.slice(after.findIndex((msg) => msg.type === 'user_message' && msg.seq === 4))).toEqual(expectedB);
    expect(after.filter((msg) => msg.type === 'tool_start' || msg.type === 'tool_complete').map((msg) => msg.payload.toolCallId))
      .toEqual(empty ? ['b', 'b'] : ['a-new', 'b', 'b']);
    await vi.dynamicImportSettled();
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

describe('MessageProvider — confirmed empty trace', () => {
  it('only marks a trace loaded after completion and notifies subscribers', () => {
    messageProvider.clear();
    const changed = vi.fn();
    const unsubscribe = messageProvider.subscribeTurnTraces(changed);
    expect(messageProvider.isTurnTraceLoaded('s', 2)).toBe(false);
    messageProvider.handleTurnTraceBatch('s', 2, [], false);
    expect(messageProvider.isTurnTraceLoaded('s', 2)).toBe(false);
    messageProvider.handleTurnTraceBatch('s', 2, [], true);
    expect(messageProvider.isTurnTraceLoaded('s', 2)).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe();
    messageProvider.clear();
    expect(messageProvider.isTurnTraceLoaded('s', 2)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
