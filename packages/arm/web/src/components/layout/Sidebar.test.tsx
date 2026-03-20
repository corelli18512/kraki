import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    expect(screen.getAllByText('Copilot').length).toBeGreaterThanOrEqual(1);
  });
});
