import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, act, within } from '@testing-library/react';
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

  it('renders the session sidebar', () => {
    useStore.getState().setStatus('connected');
    const { getAllByLabelText } = renderApp();
    expect(getAllByLabelText('New session').length).toBeGreaterThanOrEqual(1);
  });

  it('shows a blocking relay overlay when disconnected on first connect', () => {
    useStore.getState().setStatus('disconnected');
    renderApp('/session/s1');

    const overlay = screen.getByRole('alertdialog');
    const sessionShell = screen.getByText('Session content').closest('main');
    expect(overlay).toHaveAttribute('aria-modal', 'true');
    // K-087: never connected, so nothing was "lost".
    expect(screen.getByText('Connection Error')).toBeInTheDocument();
    expect(screen.getByText('Could not connect to the relay server. Make sure the head is running.')).toBeInTheDocument();
    expect(screen.queryByText('Disconnected')).not.toBeInTheDocument();
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

  it('never blocks the app after it has been connected, however long the outage', () => {
    // Transport retries forever; the user keeps reading and queueing.
    useStore.getState().setStatus('connected');
    renderApp('/session/s1');

    act(() => {
      useStore.getState().setStatus('disconnected');
      useStore.getState().setReconnectState(40, 30_000);
    });

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('offers Connect now when the very first connection fails', () => {
    renderApp('/session/s1');
    act(() => {
      useStore.getState().setStatus('error');
    });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    vi.mocked(wsClient.connect).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Connect now' }));
    expect(wsClient.connect).toHaveBeenCalledTimes(1);
  });

  it('K-087: keeps the first-connect dialog up through retries and shows the spinner while one runs', () => {
    useStore.getState().setStatus('connecting');
    renderApp('/session/s1');
    // The very first attempt is still running: nothing failed yet.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    act(() => { useStore.getState().setStatus('error'); });
    act(() => { useStore.getState().setStatus('disconnected'); });
    expect(screen.getByText('Connection Error')).toBeInTheDocument();
    act(() => { useStore.getState().setStatus('connecting'); });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Connection Error')).toBeInTheDocument();
    expect(within(screen.getByRole('alertdialog')).getByText('Connecting…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect now' })).not.toBeInTheDocument();
    act(() => { useStore.getState().setStatus('disconnected'); });
    expect(screen.getByRole('button', { name: 'Connect now' })).toBeInTheDocument();
    act(() => { useStore.getState().setStatus('connected'); });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('K-005: a sidebar render error stays inside the sidebar', () => {
  it('keeps the main area rendered when the sidebar throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useStore.setState({ status: 'connected' });
    useStore.setState({ sessions: new Map([['s-bad', {
      id: 's-bad', deviceId: 'dev-1', deviceName: 'Mac', agent: 'pi', state: 'idle', messageCount: 0,
      // Bypasses the store's own title check, like an unforeseen bad field.
      get title(): string { throw new TypeError('boom'); },
      toJSON: () => ({ id: 's-bad' }),
    } as never]]) });
    renderApp();
    expect(screen.getByText('Dashboard content')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });
});
