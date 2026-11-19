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
import { i18next } from '../i18n';
import { CommandState } from './commands';
import { outbox } from './chat/outbox';
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

  it('K-218: a failed fork reads as a copy failure, not a create failure', () => {
    const cmdState = new CommandState();
    cmdState.pendingCreateRequests.add('req_fork');
    handleDataMessage({
      type: 'error', deviceId: 'dev-t', seq: 1, timestamp: new Date().toISOString(), sessionId: '',
      payload: { message: "Couldn't copy the session: Source session not found: s1", requestId: 'req_fork' },
    } as unknown as InnerMessage, { cmdState, messageProvider } as never);
    expect(useStore.getState().lastError).toBe("Couldn't copy the session: Source session not found: s1");
    expect(cmdState.pendingCreateRequests.has('req_fork')).toBe(false);
  });

  it('K-218: importing a session twice says it is already imported', () => {
    const cmdState = new CommandState();
    cmdState.pendingCreateRequests.add('req_import');
    handleDataMessage({
      type: 'error', deviceId: 'dev-t', seq: 1, timestamp: new Date().toISOString(), sessionId: '',
      payload: { message: 'Session already imported as sess_9', requestId: 'req_import' },
    } as unknown as InnerMessage, { cmdState, messageProvider } as never);
    expect(useStore.getState().lastError).toBe('This session has already been imported.');
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

  it('a session request error goes through requestErrorText (an empty one gets the generic line)', () => {
    const cmdState = new CommandState();
    useStore.getState().upsertSession({ id: 'local-4', deviceId: 'dev-t', agent: 'copilot', state: 'idle', messageCount: 0 });
    handleDataMessage({
      type: 'error', deviceId: 'dev-t', seq: 2, timestamp: new Date().toISOString(), sessionId: 'local-4',
      payload: { message: '', requestId: 'req_import_empty' },
    } as unknown as InnerMessage, { cmdState, messageProvider } as never);
    expect(useStore.getState().lastError).toBe("The computer couldn't complete that. Try again.");
  });
});

// Triage #11/#23: a message the computer refused without storing it (disk
// full, device trust) is named by its clientId. A bare `error` is never a chat
// row: the bubble shows "Not delivered" (Retry / Delete) and the banner says
// why, in the app's language (the computer's text is English).
describe('a message the computer refused (triage #11, #23)', () => {
  const refuse = (payload: Record<string, unknown>) => handleDataMessage({
    type: 'error', deviceId: 'dev-t', seq: 7, timestamp: new Date().toISOString(), sessionId: 's',
    payload: { message: 'Kraki on this computer could not save your message because its disk is full.', ...payload },
  } as unknown as InnerMessage, { cmdState: new CommandState(), messageProvider } as never);

  beforeEach(() => {
    outbox.reset();
    outbox.configure({ send: async () => true, isDeliveryPathUp: () => true });
    useStore.getState().upsertSession({ id: 's', deviceId: 'dev-t', agent: 'claude', state: 'idle', messageCount: 0 });
  });

  it('marks that message not delivered and says why in the app language', async () => {
    const disk = outbox.send('s', 'hello');
    const other = outbox.send('s', 'second');
    refuse({ clientId: disk, code: 'input_disk_full' });
    expect(outbox.forSession('s').map((e) => [e.clientId, e.state])).toEqual([[disk, 'failed'], [other, 'sending']]);
    expect(useStore.getState().lastError).toBe("Kraki on your computer couldn't save this message because its disk is full. Free some space, then retry.");

    await i18next.changeLanguage('zh-Hans');
    try {
      refuse({ clientId: other, code: 'trust_rejected_clock' });
      expect(outbox.forSession('s').every((e) => e.state === 'failed')).toBe(true);
      expect(useStore.getState().lastError).toBe('\u7535\u8111\u62D2\u7EDD\u4E86\u8FD9\u6761\u6D88\u606F\uFF0C\u56E0\u4E3A\u672C\u8BBE\u5907\u7684\u65F6\u949F\u6BD4\u7535\u8111\u5FEB\u3002\u8BF7\u68C0\u67E5\u4E24\u53F0\u8BBE\u5907\u7684\u65E5\u671F\u548C\u65F6\u95F4\uFF0C\u7136\u540E\u91CD\u8BD5\u3002');
    } finally {
      await i18next.changeLanguage('en');
    }
  });

  it('an unknown code gets the generic line; Retry sends it again', () => {
    const id = outbox.send('s', 'hello');
    refuse({ clientId: id, code: 'something_new' });
    expect(useStore.getState().lastError).toBe("Kraki on your computer couldn't take this message. Retry; if it keeps failing, check the computer.");
    outbox.retry(id);
    expect(outbox.forSession('s')[0].state).toBe('sending');
  });

  it("another app's message, or one already delivered, changes nothing here", () => {
    const id = outbox.send('s', 'hello');
    refuse({ clientId: 'someone-elses', code: 'input_disk_full' });
    refuse({ code: 'trust_rejected_stale' });
    expect(outbox.forSession('s')[0].state).toBe('sending');
    expect(useStore.getState().lastError).toBeNull();
    outbox.confirm('s', id, 'hello');
    refuse({ clientId: id, code: 'input_disk_full' });
    expect(useStore.getState().lastError).toBeNull();
  });
});

describe('remote update race (K-322)', () => {
  const status = (payload: Record<string, unknown>) => handleDataMessage({
    type: 'device_update_status', deviceId: 'pc', seq: 1, timestamp: new Date().toISOString(), payload,
  } as unknown as InnerMessage, { cmdState: new CommandState(), messageProvider } as never);

  it("another app's refused request does not replace the running update", () => {
    status({ phase: 'downloading', requestId: 'winner', from: '0.38.9', to: '0.38.10', progress: 0.4 });
    status({ phase: 'failed', requestId: 'loser', error: 'An update is already in progress.' });
    expect(useStore.getState().updateProgress.get('pc')).toMatchObject({ phase: 'downloading', requestId: 'winner' });
  });

  it('the requesting app still sees its own refusal, and the running update its own failure', () => {
    useStore.getState().setUpdateProgress('pc', { phase: 'requested', requestId: 'loser', at: Date.now() });
    status({ phase: 'failed', requestId: 'loser', error: 'An update is already in progress.' });
    expect(useStore.getState().updateProgress.get('pc')).toMatchObject({ phase: 'failed', requestId: 'loser' });

    status({ phase: 'downloading', requestId: 'winner', progress: 0.1 });
    status({ phase: 'failed', requestId: 'winner', error: 'Download failed' });
    expect(useStore.getState().updateProgress.get('pc')).toMatchObject({ phase: 'failed', error: 'Download failed' });
  });
});
