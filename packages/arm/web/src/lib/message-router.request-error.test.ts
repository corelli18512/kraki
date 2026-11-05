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

  it('returns the typed first message to the New Session draft when create fails (iOS/Mac parity)', () => {
    const cmdState = new CommandState();
    cmdState.pendingCreateRequests.add('req_2');
    cmdState.pendingPrompts.set('req_2', 'Fix the flaky test');
    useStore.getState().setDraft('kraki.new-session-draft', 'half typed');
    handleDataMessage({
      type: 'error', deviceId: 'dev-t', seq: 1, timestamp: new Date().toISOString(), sessionId: '',
      payload: { message: 'model not available', requestId: 'req_2' },
    } as unknown as InnerMessage, { cmdState, messageProvider } as never);
    expect(useStore.getState().drafts.get('kraki.new-session-draft')).toBe('half typed\nFix the flaky test');
    expect(cmdState.pendingPrompts.has('req_2')).toBe(false);
  });

  it('server_error for a create also returns its typed first message to the draft', () => {
    const cmdState = new CommandState();
    cmdState.pendingCreateRequests.add('req_3');
    cmdState.pendingPrompts.set('req_3', 'Hello');
    cmdState.clearRequest('req_3');
    expect(useStore.getState().drafts.get('kraki.new-session-draft')).toBe('Hello');
    cmdState.clearRequest('req_3'); // a second clear does not duplicate it
    expect(useStore.getState().drafts.get('kraki.new-session-draft')).toBe('Hello');
  });

  it('ignores a session-less error for a request this app did not make', () => {
    handleDataMessage({
      type: 'error', deviceId: 'dev-t', seq: 1, timestamp: new Date().toISOString(), sessionId: '',
      payload: { message: 'other device', requestId: 'req_other' },
    } as unknown as InnerMessage, { cmdState: new CommandState(), messageProvider } as never);
    expect(useStore.getState().lastError).toBeNull();
  });
});

// K-204/K-206: a create or import the computer never answers ends after 30 s
// (iOS/Mac CommandSender.schedulePendingTimeout): the typed first message goes
// back to the draft, an import's pending page goes away, and the user is told.
describe('create/import with no answer (K-204, K-206)', () => {
  it('a create with no answer returns its prompt to the draft and says so', async () => {
    vi.useFakeTimers();
    try {
      const { createSession, CREATE_REQUEST_TIMEOUT_MS } = await import('./commands');
      const cmdState = new CommandState();
      createSession({ targetDeviceId: 'dev-t', model: 'm', prompt: 'Fix the flaky test' }, () => {}, cmdState);
      expect(cmdState.pendingCreateRequests.size).toBe(1);
      vi.advanceTimersByTime(CREATE_REQUEST_TIMEOUT_MS - 1);
      expect(useStore.getState().lastError).toBeNull();
      vi.advanceTimersByTime(1);
      expect(cmdState.pendingCreateRequests.size).toBe(0);
      expect(cmdState.pendingPrompts.size).toBe(0);
      expect(useStore.getState().drafts.get('kraki.new-session-draft')).toBe('Fix the flaky test');
      expect(useStore.getState().lastError).toBe('The computer didn’t answer in time. If the session doesn’t appear, try again.');
    } finally { vi.useRealTimers(); }
  });

  it('a create answered in time is not expired later', async () => {
    vi.useFakeTimers();
    try {
      const { createSession, CREATE_REQUEST_TIMEOUT_MS } = await import('./commands');
      const cmdState = new CommandState();
      let requestId = '';
      createSession({ targetDeviceId: 'dev-t', model: 'm', prompt: 'Hello' }, (msg) => { requestId = (msg.payload as { requestId: string }).requestId; }, cmdState);
      useStore.getState().setDevices([{ id: 'dev-t', name: 'Mac', role: 'tentacle', online: true }]);
      handleDataMessage({
        type: 'session_created', deviceId: 'dev-t', seq: 0, timestamp: new Date().toISOString(), sessionId: 'new-s',
        payload: { agent: 'pi', model: 'm', requestId },
      } as unknown as InnerMessage, { cmdState, messageProvider } as never);
      vi.advanceTimersByTime(CREATE_REQUEST_TIMEOUT_MS + 1);
      expect(useStore.getState().lastError).toBeNull();
      expect(useStore.getState().drafts.get('kraki.new-session-draft')).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('an import with no answer leaves its pending page and says so', async () => {
    vi.useFakeTimers();
    try {
      const { importSession, CREATE_REQUEST_TIMEOUT_MS } = await import('./commands');
      const cmdState = new CommandState();
      importSession('local-1', 'dev-t', () => {}, cmdState);
      expect(useStore.getState().pendingSessions.has('local-1')).toBe(true);
      vi.advanceTimersByTime(CREATE_REQUEST_TIMEOUT_MS);
      expect(useStore.getState().pendingSessions.has('local-1')).toBe(false);
      expect(useStore.getState().lastError).toBe('The computer didn’t answer in time. If the session doesn’t appear, try again.');
    } finally { vi.useRealTimers(); }
  });

  it('a failed import (error with its session id) leaves the pending page and shows the error', async () => {
    const { importSession } = await import('./commands');
    const cmdState = new CommandState();
    let requestId = '';
    importSession('local-2', 'dev-t', (msg) => { requestId = (msg.payload as { requestId: string }).requestId; }, cmdState);
    handleDataMessage({
      type: 'error', deviceId: 'dev-t', seq: 1, timestamp: new Date().toISOString(), sessionId: 'local-2',
      payload: { message: "Couldn't import the session: disk full", requestId },
    } as unknown as InnerMessage, { cmdState, messageProvider } as never);
    expect(useStore.getState().pendingSessions.has('local-2')).toBe(false);
    expect(useStore.getState().lastError).toBe("Couldn't import the session: disk full");
    expect(cmdState.pendingCreateRequests.has(requestId)).toBe(false);
  });

  it('a read-only import error (after session_created, with its request id) is shown', () => {
    const cmdState = new CommandState();
    useStore.getState().upsertSession({ id: 'local-3', deviceId: 'dev-t', agent: 'copilot', state: 'idle', messageCount: 0 });
    handleDataMessage({
      type: 'error', deviceId: 'dev-t', seq: 2, timestamp: new Date().toISOString(), sessionId: 'local-3',
      payload: { message: 'Session imported but could not connect to agent', requestId: 'req_import' },
    } as unknown as InnerMessage, { cmdState, messageProvider } as never);
    expect(useStore.getState().lastError).toBe('Session imported but could not connect to agent');
  });
});
