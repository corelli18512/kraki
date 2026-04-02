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
});

describe('message-provider: replayed permissions', () => {
  it('adds pending permission from replay batch to store', () => {
    setupSession();

    messageProvider.handleBatch('s1', [
      { type: 'tool_start', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
        payload: { toolName: 'shell', args: { command: 'rm -rf /' }, toolCallId: 'tc1' } },
      { type: 'permission', sessionId: 's1', deviceId: 'd1', seq: 2, timestamp: '',
        payload: { id: 'p1', toolName: 'shell', args: { command: 'rm -rf /' }, description: 'Run: rm -rf /' } },
    ], 2, 2);

    expect(useStore.getState().pendingPermissions.has('p1')).toBe(true);
  });

  it('shows PermissionInput card for replayed pending permission', () => {
    setupSession();

    messageProvider.handleBatch('s1', [
      { type: 'permission', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
        payload: { id: 'p1', toolName: 'shell', args: { command: 'rm -rf /' }, description: 'Run: rm -rf /' } },
    ], 1, 1);

    renderChatView('s1');
    expect(screen.getByText('Approve')).toBeInTheDocument();
    expect(screen.getByText('Permission Required')).toBeInTheDocument();
  });

  it('does not add permission to pending if already resolved in batch', () => {
    setupSession();

    messageProvider.handleBatch('s1', [
      { type: 'permission', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
        payload: { id: 'p1', toolName: 'shell', args: { command: 'ls' }, description: 'List files' } },
      { type: 'permission_resolved', sessionId: 's1', deviceId: 'd1', seq: 2, timestamp: '',
        payload: { permissionId: 'p1', resolution: 'approved' } },
    ], 2, 2);

    expect(useStore.getState().pendingPermissions.has('p1')).toBe(false);

    renderChatView('s1');
    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
  });

  it('handles approve/deny resolution types in batch', () => {
    setupSession();

    messageProvider.handleBatch('s1', [
      { type: 'permission', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
        payload: { id: 'p1', toolName: 'shell', args: { command: 'ls' }, description: 'List files' } },
      { type: 'approve', sessionId: 's1', deviceId: 'd1', seq: 2, timestamp: '',
        payload: { permissionId: 'p1' } },
    ], 2, 2);

    expect(useStore.getState().pendingPermissions.has('p1')).toBe(false);
  });

  it('adds pending question from replay batch to store', () => {
    setupSession();

    messageProvider.handleBatch('s1', [
      { type: 'question', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
        payload: { id: 'q1', question: 'Which DB?', choices: ['sqlite', 'postgres'] } },
    ], 1, 1);

    expect(useStore.getState().pendingQuestions.has('q1')).toBe(true);
  });

  it('does not add question if answered in batch', () => {
    setupSession();

    messageProvider.handleBatch('s1', [
      { type: 'question', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
        payload: { id: 'q1', question: 'Which DB?', choices: ['sqlite', 'postgres'] } },
      { type: 'answer', sessionId: 's1', deviceId: 'd1', seq: 2, timestamp: '',
        payload: { questionId: 'q1', answer: 'postgres' } },
    ], 2, 2);

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
    messageProvider.handleBatch('s1', [
      { type: 'permission', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
        payload: { id: 'p1', toolName: 'shell', args: { command: 'ls' }, description: 'List' } },
    ], 1, 1);

    expect(useStore.getState().pendingPermissions.size).toBe(1);
  });
});
