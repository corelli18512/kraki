import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { SessionPage } from './SessionPage';
import { useStore } from '../hooks/useStore';
import { wsClient } from '../lib/ws-client';

vi.mock('../lib/desktop', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/desktop')>(),
  hasWindowsTitleBar: true,
}));
vi.mock('../hooks/useNarrow', () => ({ useNarrow: () => false }));
vi.mock('../lib/ws-client', () => ({ wsClient: { setSessionMode: vi.fn(), markRead: vi.fn() } }));
vi.mock('../lib/message-provider', () => ({ messageProvider: { ensureLoaded: vi.fn() } }));
vi.mock('../components/chat/ChatView', () => ({ ChatView: ({ topInset }: { topInset: number }) => <div data-testid="transcript" data-top-inset={topInset} /> }));
vi.mock('../components/devices/SessionInfoPanel', () => ({ SessionInfoPanel: ({ onClose }: { onClose: () => void }) => <button onClick={onClose}>Close details</button> }));

beforeEach(() => {
  useStore.getState().reset();
  vi.clearAllMocks();
  useStore.getState().setSessions([
    { id: 's1', deviceId: 'd1', agent: 'pi', state: 'idle', title: 'Fix the cache', messageCount: 1 },
  ]);
  useStore.getState().setDevices([{ id: 'd1', name: 'PC', role: 'tentacle', online: true }]);
  useStore.getState().setStatus('connected');
});

it('routes Windows title and mode actions to Session Info and the existing session-mode transport', () => {
  render(<MemoryRouter initialEntries={['/session/s1']}><Routes><Route path="/session/:sessionId" element={<SessionPage />} /></Routes></MemoryRouter>);
  expect(screen.getByTestId('transcript')).toHaveAttribute('data-top-inset', '56');
  fireEvent.click(screen.getByRole('button', { name: 'Fix the cache' }));
  expect(screen.getByRole('dialog', { name: 'Session Info' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Session mode, Auto' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: /Safe/ }));
  expect(wsClient.setSessionMode).toHaveBeenCalledWith('s1', 'safe');
  expect(wsClient.setSessionMode).toHaveBeenCalledOnce();
});
