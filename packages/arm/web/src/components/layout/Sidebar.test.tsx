import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useStore } from '../../hooks/useStore';
import { Sidebar } from './Sidebar';

beforeEach(() => {
  useStore.getState().reset();
});

describe('Sidebar', () => {
  it('renders session list', () => {
    useStore.getState().setStatus('connected');
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    expect(screen.getAllByText('No sessions yet').length).toBeGreaterThanOrEqual(1);
  });

  it('renders device list and sessions', () => {
    useStore.getState().setDevices([
      { id: 'd1', name: 'MacBook Pro', role: 'tentacle', kind: 'desktop', online: true },
    ]);
    useStore.getState().setSessions([
      { id: 's1', deviceId: 'd1', deviceName: 'MacBook Pro', agent: 'copilot', state: 'active', messageCount: 2 },
    ]);
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    // "MacBook Pro" appears in both device list and session card
    expect(screen.getAllByText('MacBook Pro').length).toBeGreaterThanOrEqual(1);
    // Untitled: "New Session", like iOS and Mac (it used to be the agent name).
    expect(screen.getAllByText('New Session').length).toBeGreaterThanOrEqual(1);
  });
});


describe('Sidebar desktop rail', () => {
  it('centers native no-results content even when the account has no sessions', () => {
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: 'nothing matches' } });
    expect(screen.getByTestId('sidebar-no-results')).toBeInTheDocument();
    expect(screen.getByText('No matching sessions')).toBeInTheDocument();
    expect(screen.getByText('Try another search')).toBeInTheDocument();
    expect(screen.queryByText('No sessions yet')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Clear search')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: '' } });
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
  });
  it('reclaims the footer and retains navigation/settings entry points in one toolbar menu', () => {
    const { container } = render(<MemoryRouter><Sidebar /></MemoryRouter>);
    expect(container.querySelector('.ksb-footer')).toBeNull();
    expect(screen.queryByRole('menuitem')).toBeNull();
    fireEvent.click(screen.getByLabelText('App menu'));
    expect(screen.getByRole('menuitem', { name: 'Devices' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Account Usage' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Settings…' })).toBeInTheDocument();
    const button = screen.getByLabelText('App menu');
    button.focus();
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();
    // Reopening installs a fresh listener even if focus is elsewhere.
    fireEvent.click(button);
    screen.getByLabelText('Search sessions').focus();
    fireEvent.keyDown(screen.getByLabelText('Search sessions'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('dismisses the plus context menu with Escape even when focus is in Search', () => {
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    fireEvent.contextMenu(screen.getAllByLabelText('New session')[0]);
    expect(screen.getByRole('menuitem', { name: 'Import Session…' })).toBeInTheDocument();
    screen.getByLabelText('Search sessions').focus();
    fireEvent.keyDown(screen.getByLabelText('Search sessions'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('includes profile and sign-out menu items for authenticated accounts', () => {
    useStore.getState().setUser({ id: 'u', login: 'octocat', provider: 'github' });
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    fireEvent.click(screen.getByLabelText('App menu'));
    expect(screen.getByText('octocat')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign Out…' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});

describe('Sidebar native search and ordering', () => {
  const base = { deviceId: 'd', agent: 'pi' as const, state: 'idle' as const, messageCount: 0 };
  it('matches a raw model-only query case-insensitively', () => {
    useStore.getState().setSessions([
      { ...base, id: 'model', title: 'Model match', model: 'deepseek/deepseek-flash' },
      { ...base, id: 'other', title: 'Other model', model: 'claude-4' },
    ]);
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: '  DEEPSEEK  ' } });
    expect(screen.getByText('Model match')).toBeInTheDocument();
    expect(screen.queryByText('Other model')).toBeNull();
    expect(screen.queryByTestId('sidebar-no-results')).toBeNull();
  });
  it('sorts new/restored empty rows using creation when preview is absent, empty or invalid', () => {
    useStore.getState().setSessions([
      { ...base, id: 'old', title: 'Old conversation', createdAt: '2026-06-01T00:00:00Z' },
      { ...base, id: 'new', title: 'New empty', createdAt: '2026-06-10T00:00:00Z' },
      { ...base, id: 'restored', title: 'Restored empty', createdAt: '2026-06-11T00:00:00Z' },
      { ...base, id: 'invalid', title: 'Invalid preview', createdAt: '2026-06-12T00:00:00Z' },
    ]);
    useStore.getState().setSessionPreview('old', { text: 'Old message', type: 'agent', timestamp: '2026-06-02T00:00:00Z' });
    useStore.getState().setSessionPreview('restored', { text: '', type: 'session_created', timestamp: '' });
    useStore.getState().setSessionPreview('invalid', { text: '', type: 'session_created', timestamp: 'not a date' });
    const { container } = render(<MemoryRouter><Sidebar /></MemoryRouter>);
    expect([...container.querySelectorAll('.ksr-title')].map((e) => e.textContent)).toEqual([
      'Invalid preview', 'Restored empty', 'New empty', 'Old conversation',
    ]);
  });
  it('compares mixed ISO date shapes chronologically, preserving pin, creation and id ties', () => {
    useStore.getState().setSessions([
      { ...base, id: 'a', title: 'A', createdAt: '2026-06-01T00:00:00Z' },
      { ...base, id: 'b', title: 'B', createdAt: '2026-06-02T00:00:00Z' },
      { ...base, id: 'c', title: 'C', createdAt: '2026-06-02T00:00:00Z' },
      { ...base, id: 'd', title: 'D', createdAt: '2026-06-02T00:00:00Z' },
      { ...base, id: 'pinned', title: 'Pinned', createdAt: '2020-01-01T00:00:00Z' },
    ]);
    for (const id of ['a', 'b', 'c']) {
      useStore.getState().setSessionPreview(id, { text: '', type: 'agent', timestamp: id === 'b' ? '2026-06-10T10:00:00+00:00' : '2026-06-10T10:00:00Z' });
    }
    useStore.getState().setSessionPreview('d', { text: '', type: 'agent', timestamp: '2026-06-10T09:30:00-02:00' });
    useStore.getState().setPinnedSessions(new Set(['pinned']));
    const { container } = render(<MemoryRouter><Sidebar /></MemoryRouter>);
    expect([...container.querySelectorAll('.ksr-title')].map((e) => e.textContent)).toEqual(['Pinned', 'D', 'B', 'C', 'A']);
  });
});
