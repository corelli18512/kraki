import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThisPCSettings } from './ThisPCSettings';
import { SettingsPanel } from '../layout/SettingsPanel';
import { desktop, type BuiltInBridge, type BuiltInState } from '../../lib/desktop';
const bridge = vi.hoisted(() => ({
  state: vi.fn(), goOnline: vi.fn(), goOffline: vi.fn(), setAllowRemoteUpdates: vi.fn(), setLaunchAtLogin: vi.fn(), showLogsInExplorer: vi.fn(), locateCli: vi.fn(), recheckCli: vi.fn(),
}));
vi.mock('../../lib/desktop', () => ({ desktop: { settings: bridge }, desktopCredentials: () => null }));
vi.mock('../../lib/ws-client', () => ({ wsClient: { url: 'ws://localhost:4430' } }));
vi.mock('../../lib/push', () => ({ isPushSupported: () => false, getPushPermission: () => 'default' }));
vi.mock('../../hooks/useTheme', () => ({ useTheme: () => ({ theme: 'system', setTheme: vi.fn() }) }));
vi.mock('../layout/ProfileBar', () => ({ signOut: vi.fn() }));
const builtIn = { state: vi.fn(), disable: vi.fn(), enable: vi.fn(), restart: vi.fn(), openLogs: vi.fn() } as unknown as BuiltInBridge;
const os = { usageShortcut: 'F6', usageShortcutEnabled: true, launchAtLogin: true, keepRunningInTray: true, notificationPermission: 'granted', logsPath: 'C:\\Kraki\\logs', allowRemoteUpdates: false };
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  desktop!.settings = bridge;
  desktop!.builtIn = undefined;
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
  it('labels the selectable logs path as a body-text SettingsRow and keeps the full Mac update explanation', async () => {
    render(<ThisPCSettings builtIn={builtIn} />);
    const path = await screen.findByText(os.logsPath);
    expect(path.parentElement).toHaveClass('kp-row');
    expect(within(path.parentElement!).getByText('Path')).toBeInTheDocument();
    expect(path).toHaveClass('ds-logs-path');
    expect(path).not.toHaveClass('font-mono');
    expect(screen.getByText('From your phone or another computer, you can update Kraki here when a new version is out. Kraki restarts for a few seconds; running sessions are only stopped if you choose to.')).toBeInTheDocument();
  });
  it('dismisses only the foreground catalog/agents sheet before Settings and restores focus', async () => {
    desktop!.builtIn = {
      ...builtIn,
      checkAgents: vi.fn(async (onEvent) => {
        onEvent({ event: 'agent', id: 'pi', name: 'Pi', status: 'needs_login', models: 0 });
        return { ok: true };
      }),
    };
    const onClose = vi.fn();
    const view = render(<SettingsPanel open onClose={onClose} />);
    fireEvent.click(screen.getByRole('tab', { name: 'This PC' }));
    const opener = await screen.findByRole('button', { name: 'Check Coding Agents…' });
    opener.focus();
    fireEvent.click(opener);
    const agents = await screen.findByRole('dialog', { name: 'Coding Agents on This PC' });
    expect(agents).toHaveClass('ds-local-agents-sheet');
    expect(agents).toHaveTextContent('Kraki uses the agents installed and signed in on this PC. Install or sign in to an agent in its own app or in Terminal, then click Check Again.');
    const done = within(agents).getByRole('button', { name: 'Done' });
    expect(done).toHaveClass('ds-button-default');
    expect(done).toHaveFocus();
    fireEvent.keyDown(done, { key: 'Tab' });
    const supported = await within(agents).findByRole('button', { name: 'Supported agents' });
    expect(supported).toHaveFocus();
    fireEvent.keyDown(supported, { key: 'Tab', shiftKey: true });
    expect(done).toHaveFocus();
    supported.focus();
    fireEvent.click(supported);
    const catalog = screen.getByRole('dialog', { name: 'Supported coding agents' });
    expect(catalog).not.toHaveClass('ds-local-agents-sheet');
    expect(within(catalog).getByRole('button', { name: 'Done' })).toHaveClass('ds-button-default');
    expect(within(catalog).getByRole('button', { name: 'Check Again' })).not.toHaveClass('ds-button-default');
    fireEvent.keyDown(within(catalog).getByRole('button', { name: 'Done' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Supported coding agents' })).not.toBeInTheDocument();
    expect(agents).toBeInTheDocument();
    expect(supported).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(supported, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Coding Agents on This PC' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(opener, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    desktop!.builtIn = undefined;
  });
  it('shows status-query failures rather than an empty pane', async () => {
    vi.mocked(builtIn.state).mockRejectedValue(new Error('unavailable'));
    render(<ThisPCSettings builtIn={builtIn} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t read this PC’s status.');
  });
  it('uses actual startup/update preferences and displays bridge errors', async () => {
    bridge.setAllowRemoteUpdates.mockResolvedValue({ ok: false, error: 'Policy could not be saved.' });
    render(<ThisPCSettings builtIn={builtIn} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Let my other devices update Kraki on this PC' }));
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
