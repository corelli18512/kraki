import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { useStore } from '../../hooks/useStore';
import { ChatView } from './ChatView';
import type { ChatMessage } from '../../types/store';

vi.mock('../../lib/ws-client', () => ({
  wsClient: {
    sendInput: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
    alwaysAllow: vi.fn(),
    answer: vi.fn(),
    markRead: vi.fn(),
    createSession: vi.fn(),
  },
}));

function renderChatView(sessionId?: string) {
  const route = sessionId ? `/session/${sessionId}` : '/session/none';
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/session/:sessionId" element={<ChatView />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useStore.getState().reset();
  vi.clearAllMocks();
});

describe('ChatView', () => {
  it('shows empty state when no session', () => {
    renderChatView('nonexistent');
    expect(screen.getByText('Select a session to view')).toBeInTheDocument();
  });

  it('renders messages for a session', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 1 },
    ]);
    useStore.getState().appendMessage('s1', {
      type: 'user_message',
      deviceId: 'd1', seq: 1,
      timestamp: new Date().toISOString(), sessionId: 's1',
      payload: { content: 'Hello from user' },
    } as ChatMessage);
    renderChatView('s1');
    expect(screen.getByText('Hello from user')).toBeInTheDocument();
  });

  it('renders streaming content', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 0 },
    ]);
    useStore.getState().appendDelta('s1', 'Streaming text...');
    renderChatView('s1');
    expect(screen.getByText('Streaming text...')).toBeInTheDocument();
  });

  it('renders inline permission card', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 0 },
    ]);
    useStore.getState().setDevices([{ id: 'd1', name: 'Mac', role: 'tentacle', online: true }]);
    useStore.getState().addPermission({
      id: 'p1', sessionId: 's1', toolName: 'shell',
      args: { command: 'ls' }, description: 'List files', timestamp: '',
    });
    renderChatView('s1');
    expect(screen.getByText('Permission Required')).toBeInTheDocument();
    expect(screen.getByText('Approve')).toBeInTheDocument();
  });

  it('renders inline question card', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 0 },
    ]);
    useStore.getState().setDevices([{ id: 'd1', name: 'Mac', role: 'tentacle', online: true }]);
    useStore.getState().addQuestion({
      id: 'q1', sessionId: 's1', question: 'Which DB?',
      choices: ['sqlite', 'postgres'], timestamp: '',
    });
    useStore.getState().appendMessage('s1', {
      type: 'question', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '',
      payload: { id: 'q1', question: 'Which DB?', choices: ['sqlite', 'postgres'] },
    } as any);
    renderChatView('s1');
    expect(screen.getByText('Which DB?')).toBeInTheDocument();
  });

  it('shows message input for active session', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 0 },
    ]);
    useStore.getState().setDevices([{ id: 'd1', name: 'Mac', role: 'tentacle', online: true }]);
    renderChatView('s1');
    expect(screen.getByPlaceholderText('Send a message…')).toBeInTheDocument();
  });

  it('hides message input for ended session', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 0 },
    ]);
    renderChatView('s1');
    expect(screen.queryByPlaceholderText('Send a message…')).not.toBeInTheDocument();
  });

  it('does not show permissions from other sessions', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 0 },
    ]);
    useStore.getState().addPermission({
      id: 'p1', sessionId: 's2', toolName: 'shell',
      args: {}, description: 'Other session perm', timestamp: '',
    });
    renderChatView('s1');
    expect(screen.queryByText('Other session perm')).not.toBeInTheDocument();
  });

  it('scroll area is present and scrollable', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 0 },
    ]);
    // Add several messages to make scrollable
    for (let i = 0; i < 5; i++) {
      useStore.getState().appendMessage('s1', {
        type: 'agent_message',
        deviceId: 'd1', seq: i,
        timestamp: new Date().toISOString(), sessionId: 's1',
        payload: { content: `Message ${i}` },
      } as ChatMessage);
    }
    const { container } = renderChatView('s1');
    const scrollArea = container.querySelector('.overflow-y-auto');
    expect(scrollArea).toBeTruthy();
    // Trigger scroll event to cover handleScroll
    if (scrollArea) {
      scrollArea.dispatchEvent(new Event('scroll'));
    }
  });

  it('does not jump upward on idle for tiny overflow', async () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 2 },
    ]);
    const now = new Date().toISOString();
    useStore.getState().appendMessage('s1', {
      type: 'user_message',
      deviceId: 'd1', seq: 1,
      timestamp: now, sessionId: 's1',
      payload: { content: 'Question' },
    } as ChatMessage);
    useStore.getState().appendMessage('s1', {
      type: 'agent_message',
      deviceId: 'd1', seq: 2,
      timestamp: now, sessionId: 's1',
      payload: { content: 'Answer' },
    } as ChatMessage);

    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const { container } = renderChatView('s1');
    const scrollArea = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    expect(scrollArea).toBeTruthy();

    Object.defineProperty(scrollArea, 'scrollHeight', { configurable: true, value: 801 });
    Object.defineProperty(scrollArea, 'clientHeight', { configurable: true, value: 760 });
    Object.defineProperty(scrollArea, 'scrollTop', { configurable: true, writable: true, value: 3332 });

    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, value: 3291 });

    await act(async () => {
      useStore.getState().appendMessage('s1', {
        type: 'idle',
        deviceId: 'd1', seq: 3,
        timestamp: now, sessionId: 's1',
        payload: {},
      } as ChatMessage);
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('does not re-arm the session entry scroll after mount', async () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 2 },
    ]);
    useStore.setState({ unreadCount: new Map([['s1', 1]]) });

    const now = new Date().toISOString();
    useStore.getState().appendMessage('s1', {
      type: 'user_message',
      deviceId: 'd1', seq: 1,
      timestamp: now, sessionId: 's1',
      payload: { content: 'Question' },
    } as ChatMessage);
    useStore.getState().appendMessage('s1', {
      type: 'idle',
      deviceId: 'd1', seq: 2,
      timestamp: now, sessionId: 's1',
      payload: {},
    } as ChatMessage);

    const scrollIntoView = vi.fn();
    let scrollTopValue = 1200;
    const setScrollTop = vi.fn((value: number) => {
      scrollTopValue = value;
    });

    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      value: 1100,
    });
    Object.defineProperty(HTMLDivElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 2000,
    });
    Object.defineProperty(HTMLDivElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 760,
    });
    Object.defineProperty(HTMLDivElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: setScrollTop,
    });

    renderChatView('s1');

    await act(async () => {});

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(setScrollTop).not.toHaveBeenCalledWith(2000);
    expect(scrollTopValue).toBe(1188);
  });
});
