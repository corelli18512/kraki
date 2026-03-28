import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { useStore } from '../hooks/useStore';
import { DashboardPage } from '../pages/DashboardPage';
import { SessionPage } from '../pages/SessionPage';
import { MessageInput } from '../components/chat/MessageInput';

// Mock wsClient for MessageInput
vi.mock('../lib/ws-client', () => ({
  wsClient: {
    sendInput: vi.fn(),
    killSession: vi.fn(),
    abortSession: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    markRead: vi.fn(),
    createSession: vi.fn(),
    setSessionMode: vi.fn(),
  },
}));

import { wsClient } from '../lib/ws-client';

function renderWithRoute(route: string, ui: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/" element={ui} />
        <Route path="/session/:sessionId" element={ui} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useStore.getState().reset();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

// ============================================================
// DashboardPage
// ============================================================

describe('DashboardPage', () => {
  it('shows sign-in copy when oauth login is available', () => {
    useStore.getState().setStatus('awaiting_login');
    useStore.getState().setGithubClientId('github-client-id');
    renderWithRoute('/', <DashboardPage />);

    expect(screen.getByText('Sign in to connect to your coding agent sessions.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
    expect(screen.getByText(/^or$/)).toBeInTheDocument();
    expect(screen.getByText('Scan a pairing QR code from your terminal to connect.')).toBeInTheDocument();
  });

  it('shows only pairing copy when oauth login is unavailable', () => {
    vi.stubEnv('VITE_GITHUB_CLIENT_ID', '');
    useStore.getState().setStatus('awaiting_login');
    useStore.getState().setGithubClientId(null);
    renderWithRoute('/', <DashboardPage />);

    expect(screen.queryByText('Sign in to connect to your coding agent sessions.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in with GitHub' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^or$/)).not.toBeInTheDocument();
    expect(screen.getByText('Scan a pairing QR code from your terminal to connect.')).toBeInTheDocument();
  });

  it('shows connecting spinner', () => {
    localStorage.setItem('kraki_device', JSON.stringify({ relay: 'ws://localhost:4000', deviceId: 'dev_test' }));
    useStore.getState().setStatus('connecting');
    renderWithRoute('/', <DashboardPage />);
    expect(screen.getByText('Connecting to relay…')).toBeInTheDocument();
  });

  it('shows welcome state when connected on mobile viewport', () => {
    useStore.getState().setStatus('connected');
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 2 },
    ]);
    renderWithRoute('/', <DashboardPage />);
    expect(screen.getByText('Welcome to Kraki')).toBeInTheDocument();
  });

  it('shows empty state when connected with no sessions', () => {
    useStore.getState().setStatus('connected');
    renderWithRoute('/', <DashboardPage />);
    expect(screen.getByText('Welcome to Kraki')).toBeInTheDocument();
    expect(screen.getByText('Select a session from the sidebar to get started')).toBeInTheDocument();
  });
});

// ============================================================
// SessionPage
// ============================================================

describe('SessionPage', () => {
  it('shows not found for unknown session', () => {
    renderWithRoute('/session/unknown-id', <SessionPage />);
    expect(screen.getByText('Session not found')).toBeInTheDocument();
  });

  it('renders session header', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'MacBook', agent: 'copilot', model: 'gpt-4o', messageCount: 5 },
    ]);
    renderWithRoute('/session/s1', <SessionPage />);
    expect(screen.getByText('Copilot')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
    expect(screen.getByText('MacBook')).toBeInTheDocument();
  });

  it('shows message input for active session', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: '', agent: 'copilot', messageCount: 5 },
    ]);
    useStore.getState().setDevices([
      { id: 'd1', name: 'Mac', role: 'tentacle', online: true },
    ]);
    renderWithRoute('/session/s1', <SessionPage />);
    expect(screen.getByPlaceholderText('Send a message…')).toBeInTheDocument();
  });

  it('shows agent label in header', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: '', agent: 'copilot', messageCount: 1 },
    ]);
    renderWithRoute('/session/s1', <SessionPage />);
    expect(screen.getByText('Copilot')).toBeInTheDocument();
  });

  it('has back button that navigates home', async () => {
    const user = userEvent.setup();
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'copilot', messageCount: 0 },
    ]);
    renderWithRoute('/session/s1', <SessionPage />);
    // Find the back button (← svg)
    const backBtn = screen.getAllByRole('button').find((btn) =>
      btn.querySelector('svg path[d*="15 19"]'),
    );
    expect(backBtn).toBeTruthy();
    if (backBtn) await user.click(backBtn);
  });

  it('clicking back on not-found also navigates', async () => {
    const user = userEvent.setup();
    renderWithRoute('/session/unknown', <SessionPage />);
    const backLink = screen.getByText('← Back to sessions');
    await user.click(backLink);
  });

  it('renders session without model', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: '', agent: 'copilot', messageCount: 0 },
    ]);
    renderWithRoute('/session/s1', <SessionPage />);
    expect(screen.getByText('Copilot')).toBeInTheDocument();
  });

  it('renders session without device name', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: '', agent: 'claude', model: 'claude-4', messageCount: 3 },
    ]);
    renderWithRoute('/session/s1', <SessionPage />);
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('claude-4')).toBeInTheDocument();
  });

  it('shows message input for active session state', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: '', agent: 'copilot', messageCount: 0 },
    ]);
    useStore.getState().setDevices([
      { id: 'd1', name: 'Mac', role: 'tentacle', online: true },
    ]);
    renderWithRoute('/session/s1', <SessionPage />);
    expect(screen.getByPlaceholderText('Send a message…')).toBeInTheDocument();
  });

  it('hides kill session button for offline session', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: '', agent: 'copilot', messageCount: 0 },
    ]);
    renderWithRoute('/session/s1', <SessionPage />);
    expect(screen.queryByTitle('End session')).not.toBeInTheDocument();
  });

  it('shows offline badge for offline session', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: '', agent: 'copilot', messageCount: 0 },
    ]);
    renderWithRoute('/session/s1', <SessionPage />);
    expect(screen.getByText('offline')).toBeInTheDocument();
  });

  it('hides message input for offline session', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: '', agent: 'copilot', messageCount: 0 },
    ]);
    renderWithRoute('/session/s1', <SessionPage />);
    expect(screen.queryByPlaceholderText('Send a message…')).not.toBeInTheDocument();
  });

  it('does not show offline badge for online session', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: '', agent: 'copilot', messageCount: 0 },
    ]);
    useStore.getState().setDevices([
      { id: 'd1', name: 'Mac', role: 'tentacle', online: true },
    ]);
    renderWithRoute('/session/s1', <SessionPage />);
    expect(screen.queryByText('offline')).not.toBeInTheDocument();
  });

  it('shows mode selector for online session', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: '', agent: 'copilot', messageCount: 0 },
    ]);
    useStore.getState().setDevices([
      { id: 'd1', name: 'Mac', role: 'tentacle', online: true },
    ]);
    renderWithRoute('/session/s1', <SessionPage />);
    expect(screen.getByText('Safe')).toBeInTheDocument();
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText('Execute')).toBeInTheDocument();
    expect(screen.getByText('Delegate')).toBeInTheDocument();
  });

  it('hides mode selector for offline session', () => {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: '', agent: 'copilot', messageCount: 0 },
    ]);
    renderWithRoute('/session/s1', <SessionPage />);
    expect(screen.queryByText('Safe')).not.toBeInTheDocument();
    expect(screen.queryByText('Execute')).not.toBeInTheDocument();
  });

  it('clicking mode button switches mode', async () => {
    const user = userEvent.setup();
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: '', agent: 'copilot', messageCount: 0 },
    ]);
    useStore.getState().setDevices([
      { id: 'd1', name: 'Mac', role: 'tentacle', online: true },
    ]);
    renderWithRoute('/session/s1', <SessionPage />);
    await user.click(screen.getByText('Execute'));
    expect(wsClient.setSessionMode).toHaveBeenCalledWith('s1', 'execute');
  });
});

// ============================================================
// MessageInput
// ============================================================

describe('MessageInput', () => {
  it('renders input field', () => {
    render(
      <MemoryRouter>
        <MessageInput sessionId="sess-1" />
      </MemoryRouter>,
    );
    expect(screen.getByPlaceholderText('Send a message…')).toBeInTheDocument();
  });

  it('auto-focuses the composer on desktop devices', async () => {
    render(
      <MemoryRouter>
        <MessageInput sessionId="sess-1" />
      </MemoryRouter>,
    );

    const input = screen.getByPlaceholderText('Send a message…');
    await waitFor(() => expect(input).toHaveFocus());
  });

  it('does not auto-focus the composer on coarse-pointer devices', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(pointer: coarse)' ? true : query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    try {
      render(
        <MemoryRouter>
          <MessageInput sessionId="sess-1" />
        </MemoryRouter>,
      );

      expect(screen.getByPlaceholderText('Send a message…')).not.toHaveFocus();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('uses mobile-safe input sizing to avoid iOS zoom', () => {
    render(
      <MemoryRouter>
        <MessageInput sessionId="sess-1" />
      </MemoryRouter>,
    );

    expect(screen.getByPlaceholderText('Send a message…').className).toContain('text-base');
  });

  it('sends message on button click', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MessageInput sessionId="sess-1" />
      </MemoryRouter>,
    );
    const input = screen.getByPlaceholderText('Send a message…');
    await user.type(input, 'Hello there');
    await user.click(screen.getByLabelText('Send message'));
    expect(wsClient.sendInput).toHaveBeenCalledWith('sess-1', 'Hello there');
  });

  it('sends message on Enter key', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MessageInput sessionId="sess-1" />
      </MemoryRouter>,
    );
    const input = screen.getByPlaceholderText('Send a message…');
    await user.type(input, 'Hello{Enter}');
    expect(wsClient.sendInput).toHaveBeenCalledWith('sess-1', 'Hello');
  });

  it('does not send on Shift+Enter (newline)', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MessageInput sessionId="sess-1" />
      </MemoryRouter>,
    );
    const input = screen.getByPlaceholderText('Send a message…');
    await user.type(input, 'Line 1{Shift>}{Enter}{/Shift}Line 2');
    expect(wsClient.sendInput).not.toHaveBeenCalled();
  });

  it('clears input after sending', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MessageInput sessionId="sess-1" />
      </MemoryRouter>,
    );
    const input = screen.getByPlaceholderText('Send a message…') as HTMLTextAreaElement;
    await user.type(input, 'Hello{Enter}');
    expect(input.value).toBe('');
  });

  it('does not send empty message', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MessageInput sessionId="sess-1" />
      </MemoryRouter>,
    );
    await user.click(screen.getByLabelText('Send message'));
    expect(wsClient.sendInput).not.toHaveBeenCalled();
  });

  it('does not send whitespace-only message', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MessageInput sessionId="sess-1" />
      </MemoryRouter>,
    );
    const input = screen.getByPlaceholderText('Send a message…');
    await user.type(input, '   {Enter}');
    expect(wsClient.sendInput).not.toHaveBeenCalled();
  });

  it('send button is disabled when input is empty', () => {
    render(
      <MemoryRouter>
        <MessageInput sessionId="sess-1" />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText('Send message')).toBeDisabled();
  });

  it('renders cancel button that calls abortSession', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MessageInput sessionId="sess-1" />
      </MemoryRouter>,
    );
    const cancelBtn = screen.getByText('Cancel');
    expect(cancelBtn).toBeInTheDocument();
    await user.click(cancelBtn);
    expect(wsClient.abortSession).toHaveBeenCalledWith('sess-1');
  });
});
