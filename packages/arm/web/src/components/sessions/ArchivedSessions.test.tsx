import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { wsClient } from '../../lib/ws-client';
import { i18next } from '../../i18n';
import { useStore } from '../../hooks/useStore';
import { ArchiveSettings, ArchivedSessions } from './ArchivedSessions';

beforeEach(() => { useStore.getState().reset(); });
afterEach(async () => { await i18next.changeLanguage('en'); });

describe('ArchiveSettings localization', () => {
  it('uses English plurals and updates Chinese counts and day options live', async () => {
    useStore.setState({ archiveInfo: new Map([['device', { count: 1, days: 14 }]]) });
    render(<ArchiveSettings />);
    expect(screen.getByRole('button', { name: 'Delete 1 Archived Session…' })).toBeInTheDocument();
    act(() => { useStore.setState({ archiveInfo: new Map([['device', { count: 2, days: 14 }]]) }); });
    expect(screen.getByRole('button', { name: 'Delete 2 Archived Sessions…' })).toBeInTheDocument();
    await act(async () => { await i18next.changeLanguage('zh-Hans'); });
    expect(screen.getByRole('button', { name: '删除 2 个已归档会话…' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '14 天' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '永不' })).toBeInTheDocument();
  });
});

describe('ArchivedSessions expanded group (K-205)', () => {
  const digest = (id: string) => ({ id, agent: 'pi', state: 'idle', messageCount: 1, lastSeq: 1, readSeq: 1, createdAt: '2026-06-01T09:00:00Z', title: id, lastActivityAt: '2026-06-01T09:00:00Z' });
  afterEach(() => { vi.restoreAllMocks(); });

  it('asks again when a session is archived while the group is expanded', () => {
    const request = vi.spyOn(wsClient, 'requestArchivedSessions').mockImplementation(() => {});
    useStore.getState().setDevices([{ id: 'd1', name: 'Mac', role: 'tentacle', online: true }]);
    useStore.getState().setArchiveInfo('d1', { count: 1, days: 14 });
    render(<MemoryRouter><ArchivedSessions narrow={false} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Archived (1)' }));
    expect(request).toHaveBeenCalledTimes(1);
    act(() => { useStore.getState().setArchivedSessions('d1', [digest('old')] as never); });
    expect(screen.getByText('old')).toBeInTheDocument();
    // Another session gets archived: the session_list carries the new count.
    act(() => { useStore.getState().setArchiveInfo('d1', { count: 2, days: 14 }); });
    expect(request).toHaveBeenCalledTimes(2);
    // An unrelated re-render with the same count does not ask again.
    act(() => { useStore.getState().setDeviceOnline('d1', true); });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('says the computer is offline instead of loading forever', () => {
    const request = vi.spyOn(wsClient, 'requestArchivedSessions').mockImplementation(() => {});
    useStore.getState().setDevices([{ id: 'd1', name: 'Mac', role: 'tentacle', online: false }]);
    useStore.getState().setArchiveInfo('d1', { count: 3, days: 14 });
    render(<MemoryRouter><ArchivedSessions narrow={false} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Archived (3)' }));
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByText('Archived sessions load when their computer is online.')).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
    act(() => { useStore.getState().setDeviceOnline('d1', true); });
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
