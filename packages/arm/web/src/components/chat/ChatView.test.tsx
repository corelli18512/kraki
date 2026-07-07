import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { useStore } from '../../hooks/useStore';
import { ChatView } from './ChatView';
import type { ChatMessage } from '../../types/store';
import { messageProvider } from '../../lib/message-provider';

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
    useStore.getState().applyCardMessage('s1', 'Streaming text...');
    renderChatView('s1');
    expect(screen.getByText('Streaming text...')).toBeInTheDocument();
  });

  it('renders inline permission card', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 0 },
    ]);
    useStore.getState().setDevices([{ id: 'd1', name: 'Mac', role: 'tentacle', online: true }]);
    useStore.getState().setCardAction('s1', {
      kind: 'permission', id: 'p1', headline: 'Shell', toolName: 'shell',
      args: { command: 'ls' }, description: 'List files',
    });
    renderChatView('s1');
    expect(screen.getByText('Permission Required')).toBeInTheDocument();
    expect(screen.getByText('Approve')).toBeInTheDocument();
  });

  it('keeps the composer available while a permission is pending (permission lives in the card)', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'pi', state: 'active', messageCount: 0 },
    ]);
    useStore.getState().setDevices([{ id: 'd1', name: 'Mac', role: 'tentacle', online: true }]);
    useStore.getState().setCardAction('s1', {
      kind: 'permission', id: 'p1', headline: 'Shell', toolName: 'shell',
      args: { command: 'ls' }, description: 'List files',
    });
    renderChatView('s1');
    // Permission renders in the transient card…
    expect(screen.getByText('Permission Required')).toBeInTheDocument();
    // …and no longer gates the composer.
    expect(screen.getByPlaceholderText('Send a message…')).toBeInTheDocument();
  });

  it('renders live narration inside the single live agent bubble (fused status)', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'pi', state: 'active', messageCount: 1 },
    ]);
    useStore.getState().setDevices([{ id: 'd1', name: 'Mac', role: 'tentacle', online: true }]);
    useStore.getState().appendMessage('s1', {
      type: 'user_message', deviceId: 'd1', seq: 1, timestamp: '', sessionId: 's1',
      payload: { content: 'do it' },
    } as ChatMessage);
    // A trace step so the bubble-level Steps entry has something to open.
    useStore.getState().appendMessage('s1', {
      type: 'tool_start', deviceId: 'd1', seq: 2, timestamp: '', sessionId: 's1',
      payload: { toolName: 'bash', headline: 'ls' },
    } as ChatMessage);
    useStore.getState().applyCardMessage('s1', 'narrating a step');
    const { container } = renderChatView('s1');
    // The narration is the content part of the ONE live bubble…
    const liveBubble = container.querySelector('[data-live-bubble]');
    expect(liveBubble).toBeInTheDocument();
    expect(liveBubble).toHaveTextContent('narrating a step');
    // …with NO generic "Working…" chrome (pure narration / finalize window reads
    // as settled) but the bubble-level Steps entry stays reachable.
    expect(liveBubble).not.toHaveTextContent('Working…');
    expect(within(liveBubble as HTMLElement).getByRole('button', { name: 'Open steps' })).toBeInTheDocument();
  });

  it('shows the running tool in the live bubble action section', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'pi', state: 'active', messageCount: 1 },
    ]);
    useStore.getState().setDevices([{ id: 'd1', name: 'Mac', role: 'tentacle', online: true }]);
    useStore.getState().appendMessage('s1', {
      type: 'user_message', deviceId: 'd1', seq: 1, timestamp: '', sessionId: 's1',
      payload: { content: 'do it' },
    } as ChatMessage);
    useStore.getState().setCardAction('s1', {
      kind: 'tool', id: 't1', headline: 'Shell', status: 'running', toolName: 'shell', args: { command: 'ls' },
    });
    renderChatView('s1');
    expect(screen.getByText('shell')).toBeInTheDocument();
    expect(screen.queryByText('Working…')).not.toBeInTheDocument();
  });

  it('hides the status card when the session is idle', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'pi', state: 'idle', messageCount: 2 },
    ]);
    useStore.getState().appendMessage('s1', {
      type: 'user_message', deviceId: 'd1', seq: 1, timestamp: '', sessionId: 's1',
      payload: { content: 'do it' },
    } as ChatMessage);
    useStore.getState().appendMessage('s1', {
      type: 'agent_message', deviceId: 'd1', seq: 2, timestamp: '', sessionId: 's1',
      payload: { content: 'done' },
    } as ChatMessage);
    useStore.getState().appendMessage('s1', {
      type: 'idle', deviceId: 'd1', seq: 3, timestamp: '', sessionId: 's1', payload: {},
    } as ChatMessage);
    renderChatView('s1');
    expect(screen.queryByText('Working…')).not.toBeInTheDocument();
    expect(screen.getByText('done')).toBeInTheDocument();
  });

  it('renders the question inside the live bubble, not as a spine bubble, and keeps the composer', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 0 },
    ]);
    useStore.getState().setDevices([{ id: 'd1', name: 'Mac', role: 'tentacle', online: true }]);
    useStore.getState().setCardAction('s1', {
      kind: 'question', id: 'q1', headline: 'Choose DB', question: 'Which DB?',
      choices: ['sqlite', 'postgres'],
    });
    const { container } = renderChatView('s1');
    // Prompt text + choice buttons live inside the single live bubble.
    const card = container.querySelector('[data-live-bubble]');
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent('Which DB?');
    expect(card).toHaveTextContent('sqlite');
    expect(card).toHaveTextContent('postgres');
    // The composer is NOT swapped out for a question — it stays available.
    expect(screen.getByPlaceholderText('Send a message…')).toBeInTheDocument();
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

  it('does not show card actions from other sessions', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 0 },
    ]);
    useStore.getState().setCardAction('s2', {
      kind: 'permission', id: 'p1', headline: 'Other', toolName: 'shell',
      args: {}, description: 'Other session perm',
    });
    renderChatView('s1');
    expect(screen.queryByText('Other session perm')).not.toBeInTheDocument();
  });

  it('requests a card snapshot when opening a working session without a card', async () => {
    const spy = vi.spyOn(messageProvider, 'requestCard').mockImplementation(() => {});
    useStore.getState().upsertDevice({
      id: 'd1', name: 'Mac', role: 'tentacle', online: true, encryptionKey: 'k1',
    });
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', state: 'active', messageCount: 0 },
    ]);
    renderChatView('s1');
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith('s1');
    });
    spy.mockRestore();
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

  it('does not auto-follow when the user is already away from bottom', async () => {
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

    let scrollHeightValue = 1000;
    let scrollTopValue = 100;
    const setScrollTop = vi.fn((value: number) => {
      scrollTopValue = value;
    });

    Object.defineProperty(HTMLDivElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
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

    const { container } = renderChatView('s1');
    const scrollArea = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    await act(async () => {});
    scrollTopValue = 100;
    scrollArea.dispatchEvent(new Event('scroll'));

    setScrollTop.mockClear();
    scrollHeightValue = 1400;
    scrollTopValue = 100;

    await act(async () => {
      useStore.getState().applyCardMessage('s1', 'more streaming content');
    });

    expect(setScrollTop).not.toHaveBeenCalled();
  });

  it('only counts unread for completed message bubbles, not streaming updates', async () => {
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
      payload: { content: 'Working...' },
    } as ChatMessage);

    let scrollHeightValue = 1200;
    let scrollTopValue = 100;
    Object.defineProperty(HTMLDivElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue,
    });
    Object.defineProperty(HTMLDivElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 760,
    });
    Object.defineProperty(HTMLDivElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => { scrollTopValue = value; },
    });

    const { container } = renderChatView('s1');
    const scrollArea = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    await act(async () => {});
    scrollTopValue = 100;
    scrollArea.dispatchEvent(new Event('scroll'));

    await act(async () => {
      useStore.getState().applyCardMessage('s1', 'still streaming');
    });

    expect(container.querySelector('span.bg-kraki-500')).toBeNull();

    await act(async () => {
      useStore.getState().clearCard('s1');
      useStore.getState().appendMessage('s1', {
        type: 'idle',
        deviceId: 'd1', seq: 3,
        timestamp: now, sessionId: 's1',
        payload: {},
      } as ChatMessage);
    });
    await act(async () => {});

    const scrollBtn = container.querySelector('button.absolute');
    expect(scrollBtn).toBeTruthy();
    expect(container.querySelector('span.bg-kraki-500')?.textContent).toContain('1');
  });
});
