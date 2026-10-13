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
    fireEvent.click(screen.getByLabelText('Clear search'));
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
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
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
