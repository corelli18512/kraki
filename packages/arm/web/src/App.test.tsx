import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('./lib/ws-client', () => ({
  wsClient: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    markRead: vi.fn(),
    createSession: vi.fn(),
    url: 'ws://localhost:4000',
  },
}));

import { App } from './App';
import { useStore } from './hooks/useStore';
import { wsClient } from './lib/ws-client';

beforeEach(() => {
  useStore.getState().reset();
  vi.clearAllMocks();
});

function renderApp(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route element={<App />}>
          <Route index element={<div>Dashboard content</div>} />
          <Route path="session/:sessionId" element={<div>Session content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('App', () => {
  it('renders without crashing', () => {
    const { container } = renderApp();
    expect(container.firstChild).toBeTruthy();
  });

  it('renders header with kraki branding', () => {
    useStore.getState().setStatus('connected');
    const { getAllByText, getAllByAltText } = renderApp();
    expect(getAllByText('K').length).toBeGreaterThanOrEqual(1);
    expect(getAllByAltText('Kraki').length).toBeGreaterThanOrEqual(1);
  });

  it('shows a blocking relay overlay when disconnected on first connect', () => {
    useStore.getState().setStatus('disconnected');
    renderApp('/session/s1');

    const overlay = screen.getByRole('alertdialog');
    const sessionShell = screen.getByText('Session content').closest('main');
    expect(overlay).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
    expect(screen.getByText('Lost connection to the relay server.')).toBeInTheDocument();
    expect(sessionShell).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows a blocking relay overlay when the relay errors', () => {
    useStore.getState().setStatus('error');
    renderApp('/session/s1');

    const sessionShell = screen.getByText('Session content').closest('main');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Connection Error')).toBeInTheDocument();
    expect(screen.getByText('Could not connect to the relay server. Make sure the head is running.')).toBeInTheDocument();
    expect(sessionShell).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows non-blocking indicator during early reconnect attempts', () => {
    // Start as connected, then transition to reconnecting
    useStore.getState().setStatus('connected');
    renderApp('/session/s1');

    // Simulate disconnect + reconnect
    act(() => {
      useStore.getState().setStatus('connecting');
      useStore.getState().setReconnectState(2, null);
    });

    // Should not show blocking dialog — app stays usable
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows a manual connect button after repeated retries', () => {
    // Start as connected, then exhaust retries
    useStore.getState().setStatus('connected');
    renderApp('/session/s1');

    act(() => {
      useStore.getState().setStatus('disconnected');
      useStore.getState().setReconnectState(5, null);
    });

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    vi.mocked(wsClient.connect).mockClear();
    const button = screen.getByRole('button', { name: 'Connect now' });
    fireEvent.click(button);
    expect(wsClient.connect).toHaveBeenCalledTimes(1);
  });
});
