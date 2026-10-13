import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThisPCSettings } from './ThisPCSettings';
import { desktop, type BuiltInBridge, type BuiltInState } from '../../lib/desktop';
const bridge = vi.hoisted(() => ({
  state: vi.fn(), goOnline: vi.fn(), goOffline: vi.fn(), setAllowRemoteUpdates: vi.fn(), setLaunchAtLogin: vi.fn(), showLogsInExplorer: vi.fn(), locateCli: vi.fn(), recheckCli: vi.fn(),
}));
vi.mock('../../lib/desktop', () => ({ desktop: { settings: bridge } }));
const builtIn = { state: vi.fn(), disable: vi.fn(), enable: vi.fn(), restart: vi.fn(), openLogs: vi.fn() } as unknown as BuiltInBridge;
const os = { usageShortcut: 'F6', usageShortcutEnabled: true, launchAtLogin: true, keepRunningInTray: true, notificationPermission: 'granted', logsPath: 'C:\\Kraki\\logs', allowRemoteUpdates: false };
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  desktop!.settings = bridge;
  bridge.state.mockResolvedValue(os);
  bridge.goOnline.mockResolvedValue({ ok: true });
  bridge.goOffline.mockResolvedValue({ ok: true });
  bridge.setAllowRemoteUpdates.mockResolvedValue({ ok: true });
  bridge.setLaunchAtLogin.mockResolvedValue({ ok: true });
  vi.mocked(builtIn.restart).mockResolvedValue({ ok: true });
  vi.mocked(builtIn.state).mockResolvedValue({ available: true, version: '0.29.4', configured: true, signedIn: true, deviceName: 'This PC', deviceId: 'pc', relay: 'ws://localhost', owned: true, running: true, relayState: 'connected', cliDaemon: false, cliLogin: false });
});
describe('ThisPCSettings capability-driven native parity', () => {
  it('groups Agents/Online/Updates/Logs and goes offline without disabling the role', async () => {
    render(<ThisPCSettings builtIn={builtIn} />);
    await screen.findByRole('heading', { name: 'Online' });
    for (const toggle of screen.getAllByRole('switch')) expect(toggle).toHaveClass('kp-switch');
    expect(screen.getByRole('button', { name: 'Go Offline' })).toHaveClass('kp-button');
    for (const label of ['Agents', 'Updates', 'Logs', os.logsPath]) expect(screen.getByText(label)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go Offline' }));
    await waitFor(() => expect(bridge.goOffline).toHaveBeenCalled());
    expect(builtIn.disable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show in Explorer' }));
    expect(bridge.showLogsInExplorer).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open Logs Window' }));
    expect(builtIn.openLogs).toHaveBeenCalled();
  });
  it('shows status-query failures rather than an empty pane', async () => {
    vi.mocked(builtIn.state).mockRejectedValue(new Error('unavailable'));
    render(<ThisPCSettings builtIn={builtIn} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t read this PC’s status.');
  });
  it('uses actual startup/update preferences and displays bridge errors', async () => {
    bridge.setAllowRemoteUpdates.mockResolvedValue({ ok: false, error: 'Policy could not be saved.' });
    render(<ThisPCSettings builtIn={builtIn} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Allow remote updates' }));
    await waitFor(() => expect(bridge.setAllowRemoteUpdates).toHaveBeenCalledWith(true));
    expect(await screen.findByRole('alert')).toHaveTextContent('Policy could not be saved.');
  });
  it('keeps the settings-owned Go Online control visible but does not start agents for a remote-only PC', async () => {
    localStorage.setItem('kraki-desktop.role', 'remoteOnly');
    vi.mocked(builtIn.state).mockResolvedValue({ ...(await builtIn.state()), owned: false, running: false });
    render(<ThisPCSettings builtIn={builtIn} />);
    expect(await screen.findByRole('button', { name: 'Go Online' })).toBeDisabled();
    expect(bridge.goOnline).not.toHaveBeenCalled();
  });
  it('shows the settings-owned update error wording when an operation throws', async () => {
    bridge.setLaunchAtLogin.mockRejectedValue(new Error('unavailable'));
    render(<ThisPCSettings builtIn={builtIn} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Start automatically at login' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t update this PC’s status.');
  });
  it('uses relay state rather than claiming Online for a reconnecting daemon', async () => {
    vi.mocked(builtIn.state).mockResolvedValue({ ...(await builtIn.state()), relayState: 'reconnecting' });
    render(<ThisPCSettings builtIn={builtIn} />);
    expect(await screen.findByText('Connecting · reconnecting')).toBeInTheDocument();
  });
  it('locates/rechecks the CLI using settings capability names', async () => {
    bridge.locateCli.mockResolvedValue({ ok: true });
    bridge.recheckCli.mockResolvedValue({ ok: true });
    render(<ThisPCSettings builtIn={builtIn} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Locate Kraki…' }));
    await waitFor(() => expect(bridge.locateCli).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Re-check' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    await waitFor(() => expect(bridge.recheckCli).toHaveBeenCalledTimes(1));
  });
  it('retains OWNER_KEY external routing when its CLI is offline and reconnects without taking ownership', async () => {
    localStorage.setItem('kraki-desktop.owner', 'external');
    let state = { ...(await builtIn.state()), owned: false, running: false, cliDaemon: false, cliLogin: false };
    vi.mocked(builtIn.state).mockImplementation(async () => state);
    const externalPresence = vi.fn(async (action: 'start' | 'stop' | 'restart') => {
      state = { ...state, running: action !== 'stop', relayState: action === 'stop' ? null : 'connected' };
      return { ok: true };
    });
    render(<ThisPCSettings builtIn={{ ...builtIn, externalPresence }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Go Online' }));
    await screen.findByText('Online', { selector: 'span' });
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(externalPresence).toHaveBeenCalledWith('restart'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Go Offline' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Go Offline' }));
    await screen.findByText('Offline');
    expect(externalPresence.mock.calls.map(([action]) => action)).toEqual(['start', 'restart', 'stop']);
    expect(bridge.goOnline).not.toHaveBeenCalled();
    expect(bridge.goOffline).not.toHaveBeenCalled();
    expect(builtIn.enable).not.toHaveBeenCalled();
    expect(builtIn.disable).not.toHaveBeenCalled();
    expect(localStorage.getItem('kraki-desktop.owner')).toBe('external');
  });
  it('falls back to built-in presence/log capabilities with ownership preserved in older shells', async () => {
    desktop!.settings = undefined;
    let state: BuiltInState = { ...(await builtIn.state()) };
    const b: BuiltInBridge = {
      ...builtIn,
      state: async () => state,
      enable: vi.fn(async () => { state = { ...state, running: true }; return { ok: true }; }),
      disable: vi.fn(async () => { state = { ...state, running: false }; return { ok: true }; }),
      logsPath: async () => 'C:\\isolated\\logs', showLogsInExplorer: vi.fn(),
    };
    render(<ThisPCSettings builtIn={b} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Go Offline' }));
    expect(b.disable).toHaveBeenCalledWith({ keepOwnership: true });
    await screen.findByText('Offline');
    fireEvent.click(screen.getByRole('button', { name: 'Go Online' }));
    await screen.findByText('Online', { selector: 'span' });
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(b.restart).toHaveBeenCalledTimes(1));
    expect(screen.getByText('C:\\isolated\\logs')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show in Explorer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Logs Window' }));
    expect(b.showLogsInExplorer).toHaveBeenCalledTimes(1);
    expect(b.openLogs).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading', { name: 'Updates' })).toBeNull();
  });
});
