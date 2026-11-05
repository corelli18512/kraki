import { describe, it, expect, beforeEach, vi } from 'vitest';

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

import { useStore } from '../hooks/useStore';
import { CommandState } from './commands';
import { handleDataMessage } from './message-router';
import type { InnerMessage } from '@kraki/protocol';

function systemMessage(sessionId: string, seq: number, content: string): InnerMessage {
  return {
    type: 'system_message',
    deviceId: 'dev-tentacle',
    seq,
    timestamp: new Date().toISOString(),
    sessionId,
    payload: { content },
  } as unknown as InnerMessage;
}

beforeEach(() => {
  localStorage.clear();
  useStore.getState().reset();
  useStore.getState().upsertSession({
    id: 's1', deviceId: 'dev-tentacle', deviceName: 'test', agent: 'pi', state: 'active', messageCount: 0,
  });
});

describe('message-router sidebar preview (K-216)', () => {
  const preview = () => useStore.getState().sessionPreviews.get('s1')?.text;

  it('cuts on a grapheme boundary: no lone surrogate or half a ZWJ emoji before the ellipsis', () => {
    handleDataMessage(systemMessage('s1', 1, `${'a'.repeat(79)}\u{1F600} tail`), { cmdState: new CommandState() });
    expect(preview()).toBe(`${'a'.repeat(79)}…`);

    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    handleDataMessage(systemMessage('s1', 2, `${'a'.repeat(76)}${family} tail`), { cmdState: new CommandState() });
    expect(preview()).toBe(`${'a'.repeat(76)}…`);

    handleDataMessage(systemMessage('s1', 3, `${'a'.repeat(70)}${family} tail`), { cmdState: new CommandState() });
    expect(preview()).toBe(`${'a'.repeat(70)}${family} t…`);
  });

  it('keeps a short preview unchanged', () => {
    handleDataMessage(systemMessage('s1', 1, 'done 👨‍👩‍👧'), { cmdState: new CommandState() });
    expect(preview()).toBe('done 👨‍👩‍👧');
  });
});
