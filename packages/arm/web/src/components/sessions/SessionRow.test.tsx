import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { SessionRow } from './SessionRow';
import { useStore } from '../../hooks/useStore';
import { useOutbox } from '../../lib/chat/outbox';
import { wsClient } from '../../lib/ws-client';
import { sessionTimeLabel } from '../../lib/chat/session-card';
import type { WebSessionSummary } from '../../types/store';

const session: WebSessionSummary = { id: 's', agent: 'pi', deviceId: 'd', deviceName: 'Local Mac', model: 'deepseek/deepseek-flash', reasoningEffort: 'low', state: 'idle', messageCount: 1, title: 'Sidebar test', createdAt: '2026-01-01T09:00:00Z' };
function Location() { return <output data-testid="location">{useLocation().pathname + useLocation().search}</output>; }
function row(selected = false) {
  return render(<MemoryRouter initialEntries={['/session/s']}><SessionRow session={session} selected={selected} pinned={false} narrow={false} /><Location /></MemoryRouter>);
}
beforeEach(() => { useStore.getState().reset(); useOutbox.setState({ entries: [] }); vi.restoreAllMocks(); });

describe('SessionRow Mac sidebar', () => {
  it('uses a small model avatar, effort, createdAt fallback, and no offline title pill', () => {
    useStore.getState().setDevices([{ id: 'd', role: 'tentacle', name: 'Local Mac', online: false }]);
    const { container } = row();
    expect(container.querySelector('[data-model-family="DeepSeek"]')).toBeInTheDocument();
    expect(container.querySelector('.h-7.w-7')).toBeInTheDocument();
    expect(screen.getByText('· low')).toBeInTheDocument();
    expect(screen.getByText(sessionTimeLabel(session.createdAt!))).toBeInTheDocument();
    expect(screen.queryByText('offline')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Offline')).toBeInTheDocument();
    expect(container.querySelector('.ksr-devdot')).toBeNull();
  });
  it('renders six native-worded actions with a destructive separator and routes Rename to Session Info', () => {
    row();
    fireEvent.contextMenu(screen.getByRole('button', { name: /Sidebar test/ }), { clientX: 40, clientY: 100 });
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual(['Pin', 'Mark Unread', 'Rename…', 'Fork', 'Archive', 'Delete…']);
    expect(within(menu).getByRole('separator')).toBeInTheDocument();
    fireEvent.click(within(menu).getByText('Rename…'));
    expect(screen.getByTestId('location')).toHaveTextContent('/session/s?info=1');
  });
  it('archives and deselects the selected session', () => {
    const archive = vi.spyOn(wsClient, 'archiveSession').mockImplementation(() => {});
    row(true);
    fireEvent.contextMenu(screen.getByRole('button', { name: /Sidebar test/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(archive).toHaveBeenCalledWith('s', true);
    expect(screen.getByTestId('location').textContent).toBe('/');
  });
  it('projects pending delivery before drafts and live preview, restoring draft when pending clears', () => {
    useStore.getState().setStatus('connected');
    useStore.getState().setDraft('s', 'unsent draft');
    useOutbox.setState({ entries: [{ clientId: 'p', sessionId: 's', text: 'pending send', state: 'failed', order: 1, timestamp: session.createdAt! }] });
    const { unmount } = row();
    expect(screen.getByText('Send failed · pending send')).toBeInTheDocument();
    expect(screen.getByLabelText('Send failed')).toBeInTheDocument();
    expect(screen.queryByText('unsent draft')).toBeNull();
    unmount();
    useOutbox.setState({ entries: [] });
    const { container } = row();
    expect(container.querySelector('.ksr-line3.is-draft')).toHaveTextContent('unsent draft');
    expect(container.querySelector('.ksr-status-slot')).toBeInTheDocument();
  });
});
