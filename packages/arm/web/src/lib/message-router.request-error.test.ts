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
import { messageProvider } from './message-provider';
import { handleDataMessage } from './message-router';
import type { InnerMessage } from '@kraki/protocol';

beforeEach(() => {
  localStorage.clear();
  useStore.getState().reset();
});

describe('create/fork failures (release review A5)', () => {
  it('shows a failed create_session instead of failing silently', () => {
    const cmdState = new CommandState();
    cmdState.pendingCreateRequests.add('req_1');
    handleDataMessage({
      type: 'error', deviceId: 'dev-t', seq: 1, timestamp: new Date().toISOString(), sessionId: '',
      payload: { message: "Couldn't create the session: model not available", requestId: 'req_1' },
    } as unknown as InnerMessage, { cmdState, messageProvider } as never);
    expect(useStore.getState().lastError).toBe("Couldn't create the session: model not available");
    expect(cmdState.pendingCreateRequests.has('req_1')).toBe(false);
  });

  it('ignores a session-less error for a request this app did not make', () => {
    handleDataMessage({
      type: 'error', deviceId: 'dev-t', seq: 1, timestamp: new Date().toISOString(), sessionId: '',
      payload: { message: 'other device', requestId: 'req_other' },
    } as unknown as InnerMessage, { cmdState: new CommandState(), messageProvider } as never);
    expect(useStore.getState().lastError).toBeNull();
  });
});
