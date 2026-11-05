import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useNavigate, type NavigateFunction } from 'react-router';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';
import { Sidebar } from './Sidebar';

vi.mock('../../hooks/useNarrow', () => ({ useNarrow: () => true, NARROW_QUERY: '(max-width: 767px)' }));

let navigate: NavigateFunction;
function Layout() {
  navigate = useNavigate();
  return <><Sidebar /><Outlet /></>;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  useStore.getState().reset();
  vi.useRealTimers();
  useStore.getState().setDevices([{ id: 'd1', name: 'MacBook Pro', role: 'tentacle', online: true }]);
  useStore.getState().setDeviceAgents('d1', [{ type: 'code', id: 'copilot', models: ['model'], modelDetails: [{ id: 'model', name: 'Model' }] }]);
  useStore.getState().setSessions([{ id: 'old', deviceId: 'd1', deviceName: 'MacBook Pro', agent: 'copilot', state: 'idle', messageCount: 1 }]);
});

function mount() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes><Route element={<Layout />}><Route index element={null} /><Route path="session/:sessionId" element={<p>chat</p>} /></Route></Routes>
    </MemoryRouter>,
  );
}

describe('Sidebar New Session sheet (K-240)', () => {
  it('stays up after Start until the new session opens, so the list does not flash in between', () => {
    const create = vi.spyOn(wsClient, 'createSession').mockImplementation(() => {});
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start Session' }));
    expect(create).toHaveBeenCalledOnce();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // A second tap while waiting must not create a second session.
    expect(screen.getByRole('button', { name: 'Start Session' })).toBeDisabled();
    act(() => { navigate('/session/new-1'); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    create.mockRestore();
  });

  it('closes at once when creating the session fails, so the error is not hidden under the sheet', () => {
    const create = vi.spyOn(wsClient, 'createSession').mockImplementation(() => {});
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start Session' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    act(() => { useStore.getState().setLastError('Agent failed to start'); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    create.mockRestore();
  });

  it('closes anyway when the session never arrives', () => {
    vi.useFakeTimers();
    const create = vi.spyOn(wsClient, 'createSession').mockImplementation(() => {});
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start Session' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    create.mockRestore();
    vi.useRealTimers();
  });
});
