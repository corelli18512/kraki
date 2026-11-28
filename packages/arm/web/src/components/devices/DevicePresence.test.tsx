import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { DeviceGrid } from './DeviceGrid';
import { DevicePanel } from './DevicePanel';
import { useStore } from '../../hooks/useStore';

vi.mock('../../lib/ws-client', () => ({ wsClient: { removeDevice: vi.fn(), renameDevice: vi.fn(), deviceHasFeature: () => false } }));

const offline = { id: 'build', name: 'Build Box', role: 'tentacle' as const, online: false };
const online = { id: 'studio', name: 'Studio Mac', role: 'tentacle' as const, online: true };

beforeEach(() => {
  useStore.getState().reset();
  // A reload: the persisted list, its online flags stale until auth_ok.
  useStore.setState({ devices: new Map([[offline.id, offline], [online.id, online]]) });
});

describe('Devices: presence before this page load\'s auth_ok', () => {
  it('device list shows hollow rings (status unknown), then live dots', () => {
    const { container } = render(<MemoryRouter><DeviceGrid /></MemoryRouter>);
    const list = container.querySelector('.space-y-1')!;
    expect(list.querySelectorAll('.k-presence-unknown')).toHaveLength(2);
    expect(list.querySelectorAll('[aria-label="Status unknown"]')).toHaveLength(2);
    expect(list.querySelector('.bg-slate-400')).toBeNull();
    act(() => { useStore.getState().setDevices([offline, online]); });
    expect(list.querySelector('.k-presence-unknown')).toBeNull();
    expect(list.querySelectorAll('.bg-slate-400')).toHaveLength(1);
  });

  it('device detail says status unknown instead of offline', () => {
    render(<MemoryRouter><DevicePanel device={offline} isCurrentDevice={false} selectedSessionId={null} onSelectSession={() => {}} onClose={() => {}} /></MemoryRouter>);
    expect(screen.getByText('status unknown')).toBeInTheDocument();
    expect(screen.queryByText('offline')).toBeNull();
    act(() => { useStore.getState().setDevices([offline, online]); });
    expect(screen.getByText('offline')).toBeInTheDocument();
  });
});
