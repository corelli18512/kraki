import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { useStore } from '../hooks/useStore';
import { ChatView } from '../components/chat/ChatView';
import { messageProvider } from './message-provider';

vi.mock('./ws-client', () => ({
  wsClient: {
    sendInput: vi.fn(), approve: vi.fn(), deny: vi.fn(),
    alwaysAllow: vi.fn(), answer: vi.fn(), markRead: vi.fn(),
    createSession: vi.fn(),
  },
}));

function renderChatView(sessionId: string) {
  return render(
    <MemoryRouter initialEntries={[`/session/${sessionId}`]}>
      <Routes>
        <Route path="/session/:sessionId" element={<ChatView />} />
      </Routes>
    </MemoryRouter>,
  );
}

function setupSession() {
  useStore.getState().setSessions([
    { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 0 },
  ]);
  useStore.getState().setDevices([{ id: 'd1', name: 'Mac', role: 'tentacle', online: true }]);
}

beforeEach(() => {
  useStore.getState().reset();
  messageProvider.clear();
});

describe('message-provider: replayed permissions', () => {
  it('adds pending permission from replay batch to store', () => {
    setupSession();

    messageProvider.handleRangeBatch('s1', [
      { type: 'tool_start', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
        payload: { toolName: 'shell', args: { command: 'rm -rf /' }, toolCallId: 'tc1' } },
      { type: 'permission', sessionId: 's1', deviceId: 'd1', seq: 2, timestamp: '',
        payload: { id: 'p1', toolName: 'shell', args: { command: 'rm -rf /' }, description: 'Run: rm -rf /' } },
    ], 1, 2, false);

    expect(useStore.getState().pendingPermissions.has('p1')).toBe(true);
  });

  it('shows PermissionInput card for replayed pending permission', () => {
    setupSession();

    messageProvider.handleRangeBatch('s1', [
      { type: 'permission', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
        payload: { id: 'p1', toolName: 'shell', args: { command: 'rm -rf /' }, description: 'Run: rm -rf /' } },
    ], 1, 1, false);

    renderChatView('s1');
    expect(screen.getByText('Approve')).toBeInTheDocument();
    expect(screen.getByText('Permission Required')).toBeInTheDocument();
  });

  it('does not add permission to pending if already resolved in batch', () => {
    setupSession();

    messageProvider.handleRangeBatch('s1', [
      { type: 'permission', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
        payload: { id: 'p1', toolName: 'shell', args: { command: 'ls' }, description: 'List files' } },
      { type: 'permission_resolved', sessionId: 's1', deviceId: 'd1', seq: 2, timestamp: '',
        payload: { permissionId: 'p1', resolution: 'approved' } },
    ], 1, 2, false);

    expect(useStore.getState().pendingPermissions.has('p1')).toBe(false);

    renderChatView('s1');
    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
  });

  it('handles approve/deny resolution types in batch', () => {
    setupSession();

    messageProvider.handleRangeBatch('s1', [
      { type: 'permission', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
        payload: { id: 'p1', toolName: 'shell', args: { command: 'ls' }, description: 'List files' } },
      { type: 'approve', sessionId: 's1', deviceId: 'd1', seq: 2, timestamp: '',
        payload: { permissionId: 'p1' } },
    ], 1, 2, false);

    expect(useStore.getState().pendingPermissions.has('p1')).toBe(false);
  });

  it('adds pending question from replay batch to store', () => {
    setupSession();

    messageProvider.handleRangeBatch('s1', [
      { type: 'question', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
        payload: { id: 'q1', question: 'Which DB?', choices: ['sqlite', 'postgres'] } },
    ], 1, 1, false);

    expect(useStore.getState().pendingQuestions.has('q1')).toBe(true);
  });

  it('does not add question if answered in batch', () => {
    setupSession();

    messageProvider.handleRangeBatch('s1', [
      { type: 'question', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
        payload: { id: 'q1', question: 'Which DB?', choices: ['sqlite', 'postgres'] } },
      { type: 'answer', sessionId: 's1', deviceId: 'd1', seq: 2, timestamp: '',
        payload: { questionId: 'q1', answer: 'postgres' } },
    ], 1, 2, false);

    expect(useStore.getState().pendingQuestions.has('q1')).toBe(false);
  });

  it('does not duplicate permission if already in store', () => {
    setupSession();

    // First add via addPermission directly
    useStore.getState().addPermission({
      id: 'p1', sessionId: 's1', toolName: 'shell',
      args: { command: 'ls' }, description: 'List', timestamp: '',
    });

    // Then replay batch with same permission
    messageProvider.handleRangeBatch('s1', [
      { type: 'permission', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
        payload: { id: 'p1', toolName: 'shell', args: { command: 'ls' }, description: 'List' } },
    ], 1, 1, false);

    expect(useStore.getState().pendingPermissions.size).toBe(1);
  });
});

describe('message-provider: ensureLoaded', () => {
  it('triggers fetchRange when store has no messages', () => {
    setupSession();
    messageProvider.setTentacleInfo('s1', 100, 'd1');
    // setSend to prevent "cannot request from tentacle" path
    messageProvider.setSend(() => {});

    const spy = vi.spyOn(messageProvider, 'fetchRange');
    messageProvider.ensureLoaded('s1');

    expect(spy).toHaveBeenCalledWith('s1', 51, 100, { initial: true });
    spy.mockRestore();
  });

  it('does not fetch when store already has messages', () => {
    setupSession();
    messageProvider.setTentacleInfo('s1', 100, 'd1');

    // Put a message into the store
    useStore.getState().appendMessage('s1', {
      type: 'agent_message', sessionId: 's1', deviceId: 'd1', seq: 99, timestamp: '',
      payload: { content: 'hello' },
    });

    const spy = vi.spyOn(messageProvider, 'fetchRange');
    messageProvider.ensureLoaded('s1');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not fetch when no tentacle info available', () => {
    setupSession();
    // Don't set tentacle info

    const spy = vi.spyOn(messageProvider, 'fetchRange');
    messageProvider.ensureLoaded('s1');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('message-provider: range-fetch protocol', () => {
  it('sends request_session_messages_range with inclusive fromSeq/toSeq', async () => {
    setupSession();
    messageProvider.setTentacleInfo('s1', 100, 'd1');
    const sent: Record<string, unknown>[] = [];
    messageProvider.setSend((m) => sent.push(m));

    // fetchRange(s1, 51, 100) → afterSeq=50, limit=50
    // → fromSeq=51, toSeq=100 inclusive
    void messageProvider.fetchRange('s1', 51, 100, { initial: true });

    // fetchRange awaits dynamic imports (./message-db); poll until the send fires.
    await vi.waitFor(() => {
      expect(sent.find(m => m.type === 'request_session_messages_range')).toBeDefined();
    });

    const rangeReq = sent.find(m => m.type === 'request_session_messages_range');
    const payload = rangeReq!.payload as Record<string, unknown>;
    expect(payload.sessionId).toBe('s1');
    expect(payload.fromSeq).toBe(51);
    expect(payload.toSeq).toBe(100);
    expect(payload.targetDeviceId).toBe('d1');

    // No legacy replay request should have been sent
    expect(sent.find(m => m.type === 'request_session_replay')).toBeUndefined();

    // Resolve the pending request so fetchRange completes its finally clause
    messageProvider.handleRangeBatch('s1', [], 0, 0, false);
    await vi.waitFor(() => {
      expect(messageProvider.isLoading('s1')).toBe(false);
    });
  });

  it('handleRangeBatch resolves the pending request and persists messages', async () => {
    setupSession();
    messageProvider.setTentacleInfo('s1', 10, 'd1');
    const sent: Record<string, unknown>[] = [];
    messageProvider.setSend((m) => sent.push(m));

    const pending = messageProvider.fetchRange('s1', 1, 10, { initial: true });
    await vi.waitFor(() => {
      expect(sent.find(m => m.type === 'request_session_messages_range')).toBeDefined();
    });

    messageProvider.handleRangeBatch('s1', [
      { type: 'agent_message', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
        payload: { content: 'first' } },
      { type: 'agent_message', sessionId: 's1', deviceId: 'd1', seq: 2, timestamp: '',
        payload: { content: 'second' } },
    ], 1, 2, false);

    await pending;

    const msgs = useStore.getState().messages.get('s1');
    expect(msgs).toBeDefined();
    expect(msgs!.length).toBe(2);
    expect(messageProvider.isLoading('s1')).toBe(false);
  });

  it('handleRangeBatch warns but still delivers when truncated=true', async () => {
    setupSession();
    messageProvider.setTentacleInfo('s1', 1000, 'd1');
    const sent: Record<string, unknown>[] = [];
    messageProvider.setSend((m) => sent.push(m));

    const pending = messageProvider.fetchRange('s1', 1, 1000, { initial: true });
    await vi.waitFor(() => {
      expect(sent.find(m => m.type === 'request_session_messages_range')).toBeDefined();
    });

    messageProvider.handleRangeBatch('s1', [
      { type: 'agent_message', sessionId: 's1', deviceId: 'd1', seq: 501, timestamp: '',
        payload: { content: 'newer end' } },
    ], 501, 501, true);

    await pending;

    expect(useStore.getState().messages.get('s1')?.length).toBe(1);
  });
});
