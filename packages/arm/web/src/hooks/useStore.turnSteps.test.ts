import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture IDB writes to assert tool trace is NOT persisted to the spine store.
const { putMessage, putMessages, updateSessionMessages } = vi.hoisted(() => ({
  putMessage: vi.fn(async () => {}),
  putMessages: vi.fn(async () => {}),
  updateSessionMessages: vi.fn(async () => {}),
}));
vi.mock('../lib/message-db', () => ({
  putMessage,
  putMessages,
  getMessages: async () => [],
  getAllMessages: async () => new Map(),
  getLastSeq: async () => 0,
  getMessagesInRange: async () => [],
  deleteSessionMessages: async () => {},
  updateSessionMessages,
  clearAllMessages: async () => {},
}));

import { useStore } from './useStore';
import type { ChatMessage } from '../types/store';

function m(type: string, seq: number, payload: Record<string, unknown> = {}): ChatMessage {
  return { type, sessionId: 's1', deviceId: 'd1', seq, timestamp: '', payload } as unknown as ChatMessage;
}

function traceEntry(type: 'tool_start' | 'tool_complete', toolCallId: string): ChatMessage {
  // Shape as broadcast: full envelope with a global (large) envelope seq.
  return { type, sessionId: 's1', deviceId: 'd1', seq: 9000, timestamp: '', payload: { toolName: 'read_file', toolCallId, headline: 'x' } } as unknown as ChatMessage;
}

beforeEach(() => {
  localStorage.clear();
  useStore.getState().reset();
  putMessage.mockClear();
  putMessages.mockClear();
  updateSessionMessages.mockClear();
});

describe('appendMessage: tool trace is off-spine (not persisted to IDB)', () => {
  it('persists real bubbles but NOT tool_start/tool_complete', async () => {
    const store = useStore.getState();
    const settle = () => new Promise((r) => setTimeout(r, 5));
    // Yield between appends so each fire-and-forget IDB write settles (in prod
    // message-db is loaded once at startup; only the very first import races).
    store.appendMessage('s1', m('user_message', 1, { content: 'hi' }));
    await settle();
    store.appendMessage('s1', m('tool_start', 2, { toolCallId: 'tc1' }));
    await settle();
    store.appendMessage('s1', m('tool_complete', 3, { toolCallId: 'tc1' }));
    await settle();
    store.appendMessage('s1', m('agent_message', 4, { content: 'done' }));
    await settle();
    await settle();

    const persistedTypes = putMessage.mock.calls.map(c => (c[1] as ChatMessage).type);
    expect(persistedTypes).toContain('user_message');
    expect(persistedTypes).toContain('agent_message');
    expect(persistedTypes).not.toContain('tool_start');
    expect(persistedTypes).not.toContain('tool_complete');

    // …but they DO stay in the in-memory store for live rendering.
    const inMem = useStore.getState().messages.get('s1')!.map(x => x.type);
    expect(inMem).toEqual(['user_message', 'tool_start', 'tool_complete', 'agent_message']);
  });

  it('keeps agent_narration in memory but off the IDB spine', async () => {
    const store = useStore.getState();
    const settle = () => new Promise((r) => setTimeout(r, 5));
    store.appendMessage('s1', m('user_message', 1, { content: 'hi' }));
    await settle();
    store.appendMessage('s1', m('agent_narration', 2, { content: 'reasoning' }));
    await settle();
    await settle();

    const persistedTypes = putMessage.mock.calls.map(c => (c[1] as ChatMessage).type);
    expect(persistedTypes).toContain('user_message');
    expect(persistedTypes).not.toContain('agent_narration');

    const inMem = useStore.getState().messages.get('s1')!.map(x => x.type);
    expect(inMem).toEqual(['user_message', 'agent_narration']);
  });
});

describe('setTurnSteps', () => {
  it('injects pulled trace just before the bubble so it groups into the turn', () => {
    const store = useStore.getState();
    // Reloaded spine: only bubbles, no tools.
    store.appendMessage('s1', m('user_message', 1, { content: 'hi' }));
    store.appendMessage('s1', m('agent_message', 2, { content: 'done' }));

    store.setTurnSteps('s1', 2, [traceEntry('tool_start', 'tc1'), traceEntry('tool_complete', 'tc1')]);

    const list = useStore.getState().messages.get('s1')!;
    expect(list.map(x => x.type)).toEqual(['user_message', 'tool_start', 'tool_complete', 'agent_message']);
    // Injected entries sort strictly between the user_message(1) and bubble(2).
    const startSeq = (list[1] as { seq: number }).seq;
    const completeSeq = (list[2] as { seq: number }).seq;
    expect(startSeq).toBeGreaterThan(1);
    expect(startSeq).toBeLessThan(completeSeq);
    expect(completeSeq).toBeLessThan(2);
  });

  it('is idempotent — a second pull replaces (not duplicates) the turn steps', () => {
    const store = useStore.getState();
    store.appendMessage('s1', m('user_message', 1));
    store.appendMessage('s1', m('agent_message', 2));

    store.setTurnSteps('s1', 2, [traceEntry('tool_start', 'tc1'), traceEntry('tool_complete', 'tc1')]);
    store.setTurnSteps('s1', 2, [
      traceEntry('tool_start', 'tc1'), traceEntry('tool_complete', 'tc1'),
      traceEntry('tool_start', 'tc2'), traceEntry('tool_complete', 'tc2'),
    ]);

    const list = useStore.getState().messages.get('s1')!;
    const toolCount = list.filter(x => x.type === 'tool_start' || x.type === 'tool_complete').length;
    expect(toolCount).toBe(4); // the second pull's 4 entries, not 6
  });

  it('only affects the target turn in a multi-turn session', () => {
    const store = useStore.getState();
    store.appendMessage('s1', m('user_message', 1));
    store.appendMessage('s1', m('agent_message', 2));
    store.appendMessage('s1', m('user_message', 3));
    store.appendMessage('s1', m('agent_message', 4));

    store.setTurnSteps('s1', 4, [traceEntry('tool_start', 'b1'), traceEntry('tool_complete', 'b1')]);

    const list = useStore.getState().messages.get('s1')!;
    // Turn 1 (seq 1→2) has no tools; turn 2 (seq 3→4) has the injected pair.
    const idxBubble1 = list.findIndex(x => x.type === 'agent_message' && (x as { seq: number }).seq === 2);
    const before1 = list.slice(0, idxBubble1);
    expect(before1.some(x => x.type === 'tool_start')).toBe(false);
    const tools = list.filter(x => x.type === 'tool_start' || x.type === 'tool_complete');
    expect(tools).toHaveLength(2);
  });

  it('rejects a stale final-agent trace response once terminal status owns the turn', () => {
    const store = useStore.getState();
    store.appendMessage('s1', m('user_message', 1));
    store.appendMessage('s1', m('agent_message', 2, { content: 'done' }));
    store.appendMessage('s1', m('turn_status', 3, {
      draft: '',
      action: { type: 'failed', payload: { message: '524', source: 'backend', failedAt: '' } },
      finishedAt: '',
    }));

    const terminalTrace = [traceEntry('tool_start', 'tc1'), traceEntry('tool_complete', 'tc1')];
    store.setTurnSteps('s1', 3, terminalTrace);
    store.setTurnSteps('s1', 2, terminalTrace); // stale response races in later

    const list = useStore.getState().messages.get('s1')!;
    expect(list.filter(x => x.type === 'tool_start')).toHaveLength(1);
    expect(list.filter(x => x.type === 'tool_complete')).toHaveLength(1);
  });

  it('does not persist injected trace to IDB', async () => {
    const store = useStore.getState();
    store.appendMessage('s1', m('user_message', 1));
    store.appendMessage('s1', m('agent_message', 2));
    putMessage.mockClear();
    putMessages.mockClear();
    updateSessionMessages.mockClear();

    store.setTurnSteps('s1', 2, [traceEntry('tool_start', 'tc1'), traceEntry('tool_complete', 'tc1')]);
    await Promise.resolve();
    await Promise.resolve();

    expect(putMessage).not.toHaveBeenCalled();
    expect(putMessages).not.toHaveBeenCalled();
    expect(updateSessionMessages).not.toHaveBeenCalled();
  });

  it('is a no-op when the bubble is not loaded', () => {
    const store = useStore.getState();
    store.appendMessage('s1', m('user_message', 1));
    store.setTurnSteps('s1', 999, [traceEntry('tool_start', 'tc1')]);
    const list = useStore.getState().messages.get('s1')!;
    expect(list.map(x => x.type)).toEqual(['user_message']);
  });

  it('places in-progress turn steps AFTER the user_message (seed by lastUserMessageSeq)', () => {
    const store = useStore.getState();
    // A turn is running — only the user_message is on the spine, no conclusion.
    store.appendMessage('s1', m('user_message', 1, { content: 'go' }));

    // Seed the card by keying on the leading user_message seq.
    store.setTurnSteps('s1', 1, [
      traceEntry('tool_start', 'tc1'),
      traceEntry('tool_complete', 'tc1'),
    ]);

    const list = useStore.getState().messages.get('s1')!;
    expect(list.map(x => x.type)).toEqual(['user_message', 'tool_start', 'tool_complete']);
    // Steps sort strictly AFTER the user_message(1), before the next turn (2).
    const startSeq = (list[1] as { seq: number }).seq;
    const completeSeq = (list[2] as { seq: number }).seq;
    expect(startSeq).toBeGreaterThan(1);
    expect(startSeq).toBeLessThan(completeSeq);
    expect(completeSeq).toBeLessThan(2);
  });

  it('re-pull replaces in-progress trace rather than duplicating it', () => {
    const store = useStore.getState();
    store.appendMessage('s1', m('user_message', 1));
    store.setTurnSteps('s1', 1, [traceEntry('tool_start', 'tc1')]);
    store.setTurnSteps('s1', 1, [
      traceEntry('tool_start', 'tc1'),
      traceEntry('tool_complete', 'tc1'),
    ]);
    const list = useStore.getState().messages.get('s1')!;
    const toolCount = list.filter(x => x.type === 'tool_start' || x.type === 'tool_complete').length;
    expect(toolCount).toBe(2);
  });
});
