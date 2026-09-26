import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { useStore } from '../hooks/useStore';
import { DashboardPage } from '../pages/DashboardPage';
import { SessionPage } from '../pages/SessionPage';
import { Composer, composerIntent } from '../components/chat/Composer';

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
    resolvePermission: vi.fn(),
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
    expect(screen.getByText('Scan QR Code')).toBeInTheDocument();
  });

  it('shows only pairing copy when oauth login is unavailable', () => {
    vi.stubEnv('VITE_GITHUB_CLIENT_ID', '');
    useStore.getState().setStatus('awaiting_login');
    useStore.getState().setGithubClientId(null);
    renderWithRoute('/', <DashboardPage />);

    expect(screen.queryByText('Sign in to connect to your coding agent sessions.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in with GitHub' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^or$/)).not.toBeInTheDocument();
    expect(screen.getByText('Scan QR Code')).toBeInTheDocument();
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
  function withSession(state: 'idle' | 'active' = 'idle', online = true) {
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'MacBook', agent: 'pi', model: 'm', state, messageCount: 1, title: 'Fix the cache' },
    ]);
    useStore.getState().setDevices([{ id: 'd1', name: 'MacBook', role: 'tentacle', online }]);
    useStore.getState().setStatus('connected');
  }

  it('shows not found for an unknown session', () => {
    renderWithRoute('/session/unknown-id', <SessionPage />);
    expect(screen.getByText('Session not found')).toBeInTheDocument();
  });

  it('header: title and the session mode capsule', () => {
    withSession();
    renderWithRoute('/session/s1', <SessionPage />);
    expect(screen.getByText('Fix the cache')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Discuss/ })).toBeInTheDocument();
  });

  it('the mode capsule switches the session mode', async () => {
    withSession();
    renderWithRoute('/session/s1', <SessionPage />);
    await userEvent.click(screen.getByRole('button', { name: /Discuss/ }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Execute/ }));
    expect(wsClient.setSessionMode).toHaveBeenCalledWith('s1', 'execute');
  });

  it('an offline device shows a banner and messages still queue', () => {
    withSession('idle', false);
    renderWithRoute('/session/s1', <SessionPage />);
    expect(screen.getByText(/offline/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Send a message…')).toBeInTheDocument();
  });
});

describe('Composer', () => {
  const baseProps = { sessionId: 's1', canAbort: false, reachable: true, onSend: vi.fn(), onAbort: vi.fn() };

  it('intent: an open question makes it the answer field; a running turn steers', () => {
    expect(composerIntent(false, true)).toBe('answerQuestion');
    expect(composerIntent(true, false)).toBe('steer');
    expect(composerIntent(false, false)).toBe('prompt');
  });

  it('placeholders follow the intent', () => {
    const { rerender } = render(<Composer {...baseProps} intent="prompt" />);
    expect(screen.getByPlaceholderText('Send a message…')).toBeInTheDocument();
    rerender(<Composer {...baseProps} intent="answerQuestion" />);
    expect(screen.getByPlaceholderText('Type your answer…')).toBeInTheDocument();
    rerender(<Composer {...baseProps} intent="steer" />);
    expect(screen.getByPlaceholderText('Steer the agent…')).toBeInTheDocument();
  });

  it('sends on click and clears the draft', async () => {
    const onSend = vi.fn();
    render(<Composer {...baseProps} onSend={onSend} intent="prompt" />);
    await userEvent.type(screen.getByRole('textbox'), 'Hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSend).toHaveBeenCalledWith('Hello', undefined, 'prompt');
    expect(useStore.getState().drafts.get('s1')).toBeUndefined();
  });

  it('Enter sends on a keyboard device; Shift+Enter is a newline; blank never sends', async () => {
    const onSend = vi.fn();
    render(<Composer {...baseProps} onSend={onSend} intent="prompt" />);
    const field = screen.getByRole('textbox');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.type(field, 'a{Shift>}{Enter}{/Shift}b');
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('a\nb', undefined, 'prompt');
  });

  it('with nothing typed a running turn shows Stop; typing turns it into Steer', async () => {
    const onAbort = vi.fn();
    render(<Composer {...baseProps} canAbort onAbort={onAbort} intent="steer" />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop agent' }));
    expect(onAbort).toHaveBeenCalledTimes(1);
    await userEvent.type(screen.getByRole('textbox'), 'go left');
    expect(screen.getByRole('button', { name: 'Steer agent' })).toBeInTheDocument();
  });

  it('Stop is disabled while the device is unreachable', () => {
    render(<Composer {...baseProps} canAbort reachable={false} intent="steer" />);
    expect(screen.getByRole('button', { name: 'Stop agent' })).toBeDisabled();
  });
});
