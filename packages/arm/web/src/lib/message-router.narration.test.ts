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
import { messageProvider } from './message-provider';
import { handleDataMessage } from './message-router';
import type { InnerMessage } from '@kraki/protocol';

function cardMessage(sessionId: string, seq: number, content: string, reset?: boolean): InnerMessage {
  return {
    type: 'agent_message_delta',
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

  it('routes agent_message_delta into the server-owned card text', () => {
    seedSession('s1');
    handleDataMessage(cardMessage('s1', 5, 'thinking '), {
      cmdState: new CommandState(),
    });
    handleDataMessage(cardMessage('s1', 6, 'about it'), {
      cmdState: new CommandState(),
    });
    expect(useStore.getState().cards.get('s1')?.text).toBe('thinking about it');
  });

  it('honors agent_message_delta reset', () => {
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
          type: 'question',
          payload: {
            id: 'q1',
            question: 'Proceed?',
          },
        },
      },
    } as unknown as InnerMessage, {
      cmdState: new CommandState(),
    });
    expect(useStore.getState().cards.get('s1')?.action?.type).toBe('question');
  });

  it('routes compacting start/end through session state without touching the card or IndexedDB', async () => {
    seedSession('runtime-s1');
    useStore.getState().setCardAction('runtime-s1', {
      type: 'question',
      payload: { id: 'q1', question: 'Proceed?' },
    });

    handleDataMessage({
      type: 'compacting', deviceId: 'dev-tentacle', seq: 8,
      timestamp: new Date().toISOString(), sessionId: 'runtime-s1',
      payload: { phase: 'start', reason: 'threshold' },
    } as unknown as InnerMessage, { cmdState: new CommandState() });

    expect(useStore.getState().sessions.get('runtime-s1')?.state).toBe('compacting');
    expect(useStore.getState().cards.get('runtime-s1')?.action?.type).toBe('question');

    handleDataMessage({
      type: 'compacting', deviceId: 'dev-tentacle', seq: 9,
      timestamp: new Date().toISOString(), sessionId: 'runtime-s1',
      payload: { phase: 'end', nextState: 'idle' },
    } as unknown as InnerMessage, { cmdState: new CommandState() });

    expect(useStore.getState().sessions.get('runtime-s1')?.state).toBe('idle');
    expect(useStore.getState().cards.get('runtime-s1')?.action?.type).toBe('question');
    await new Promise((r) => setTimeout(r, 5));
    expect(putMessage).not.toHaveBeenCalled();
  });

  it('does not let real card or active updates end new-protocol compacting state', () => {
    seedSession('mixed-s1');
    handleDataMessage({
      type: 'compacting', deviceId: 'dev-tentacle', seq: 12,
      timestamp: new Date().toISOString(), sessionId: 'mixed-s1',
      payload: { phase: 'start' },
    } as unknown as InnerMessage, { cmdState: new CommandState() });
    handleDataMessage({
      type: 'card_action', deviceId: 'dev-tentacle', seq: 13,
      timestamp: new Date().toISOString(), sessionId: 'mixed-s1',
      payload: { action: { type: 'tool_start', payload: { toolName: 'bash', headline: 'test' } } },
    } as unknown as InnerMessage, { cmdState: new CommandState() });
    handleDataMessage({
      type: 'active', deviceId: 'dev-tentacle', seq: 14,
      timestamp: new Date().toISOString(), sessionId: 'mixed-s1', payload: {},
    } as unknown as InnerMessage, { cmdState: new CommandState() });

    expect(useStore.getState().sessions.get('mixed-s1')?.state).toBe('compacting');
    expect(useStore.getState().cards.get('mixed-s1')?.action?.type).toBe('tool_start');
  });

  it('reconciles the persistent tail when idle arrives after a missed reply', () => {
    seedSession('gap-s1');
    const reconcile = vi.spyOn(messageProvider, 'reconcileTail').mockImplementation(() => {});

    handleDataMessage({
      type: 'idle', deviceId: 'dev-tentacle', seq: 496,
      timestamp: new Date().toISOString(), sessionId: 'gap-s1',
      payload: { reason: 'completed' },
    } as unknown as InnerMessage, { cmdState: new CommandState() });

    expect(reconcile).toHaveBeenCalledWith('gap-s1', 496);
    reconcile.mockRestore();
  });

  it('keeps card updates out of IndexedDB', async () => {
    seedSession('s1');
    handleDataMessage(cardMessage('s1', 5, 'private prose'), {
      cmdState: new CommandState(),
    });
    await new Promise((r) => setTimeout(r, 5));
    const persistedTypes = putMessage.mock.calls.map((c) => (c[1] as { type: string }).type);
    expect(persistedTypes).not.toContain('agent_message_delta');
  });
});
