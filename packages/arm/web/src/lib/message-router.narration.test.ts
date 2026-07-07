import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture IDB writes to assert narration is NOT persisted to the spine store.
const { putMessage } = vi.hoisted(() => ({
  putMessage: vi.fn(async () => {}),
}));
vi.mock('./message-db', () => ({
  putMessage,
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

function cardMessage(sessionId: string, seq: number, content: string, reset?: boolean): InnerMessage {
  return {
    type: 'card_message',
    deviceId: 'dev-tentacle',
    seq,
    timestamp: new Date().toISOString(),
    sessionId,
    payload: { content, reset },
  } as unknown as InnerMessage;
}

beforeEach(() => {
  localStorage.clear();
  useStore.getState().reset();
  putMessage.mockClear();
});

describe('handleDataMessage card messages', () => {
  const seedSession = (id: string) => {
    useStore.getState().upsertSession({
      id, deviceId: 'dev-tentacle', deviceName: 'test', agent: 'pi', state: 'active', messageCount: 0,
    });
  };

  it('routes card_message into the server-owned card text', () => {
    seedSession('s1');
    handleDataMessage(cardMessage('s1', 5, 'thinking '), {
      cmdState: new CommandState(),
    });
    handleDataMessage(cardMessage('s1', 6, 'about it'), {
      cmdState: new CommandState(),
    });
    expect(useStore.getState().cards.get('s1')?.text).toBe('thinking about it');
  });

  it('honors card_message reset', () => {
    seedSession('s1');
    handleDataMessage(cardMessage('s1', 5, 'old'), {
      cmdState: new CommandState(),
    });
    handleDataMessage(cardMessage('s1', 6, 'new', true), {
      cmdState: new CommandState(),
    });
    expect(useStore.getState().cards.get('s1')?.text).toBe('new');
  });

  it('routes card_action into the server-owned card action', () => {
    seedSession('s1');
    handleDataMessage({
      type: 'card_action',
      deviceId: 'dev-tentacle',
      seq: 7,
      timestamp: new Date().toISOString(),
      sessionId: 's1',
      payload: {
        action: {
          kind: 'question',
          id: 'q1',
          headline: 'Question',
          question: 'Proceed?',
        },
      },
    } as unknown as InnerMessage, {
      cmdState: new CommandState(),
    });
    expect(useStore.getState().cards.get('s1')?.action?.kind).toBe('question');
  });

  it('keeps card updates out of IndexedDB', async () => {
    seedSession('s1');
    handleDataMessage(cardMessage('s1', 5, 'private prose'), {
      cmdState: new CommandState(),
    });
    await new Promise((r) => setTimeout(r, 5));
    const persistedTypes = putMessage.mock.calls.map((c) => (c[1] as { type: string }).type);
    expect(persistedTypes).not.toContain('card_message');
  });
});
