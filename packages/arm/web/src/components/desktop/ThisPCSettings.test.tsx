import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThisPCSettings } from './ThisPCSettings';
import type { BuiltInBridge } from '../../lib/desktop';
const bridge = vi.hoisted(() => ({
  state: vi.fn(), goOnline: vi.fn(), goOffline: vi.fn(), setAllowRemoteUpdates: vi.fn(), setLaunchAtLogin: vi.fn(), showLogsInExplorer: vi.fn(), locateCli: vi.fn(), recheckCli: vi.fn(),
}));
vi.mock('../../lib/desktop', () => ({ desktop: { settings: bridge } }));
const builtIn = { state: vi.fn(), disable: vi.fn(), enable: vi.fn(), restart: vi.fn(), openLogs: vi.fn() } as unknown as BuiltInBridge;
const os = { usageShortcut: 'F6', usageShortcutEnabled: true, launchAtLogin: true, keepRunningInTray: true, notificationPermission: 'granted', logsPath: 'C:\\Kraki\\logs', allowRemoteUpdates: false };
beforeEach(() => {
  vi.clearAllMocks();
  bridge.state.mockResolvedValue(os);
  bridge.goOnline.mockResolvedValue({ ok: true });
  bridge.goOffline.mockResolvedValue({ ok: true });
  bridge.setAllowRemoteUpdates.mockResolvedValue({ ok: true });
  bridge.setLaunchAtLogin.mockResolvedValue({ ok: true });
  vi.mocked(builtIn.state).mockResolvedValue({ available: true, version: '0.29.4', configured: true, signedIn: true, deviceName: 'This PC', deviceId: 'pc', relay: 'ws://localhost', owned: true, running: true, relayState: 'connected', cliDaemon: false, cliLogin: false });
});
describe('ThisPCSettings capability-driven native parity', () => {
  it('groups Agents/Online/Updates/Logs and goes offline without disabling the role', async () => {
    render(<ThisPCSettings builtIn={builtIn} />);
    await screen.findByRole('heading', { name: 'Online' });
    for (const label of ['Agents', 'Updates', 'Logs', os.logsPath]) expect(screen.getByText(label)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go Offline' }));
    await waitFor(() => expect(bridge.goOffline).toHaveBeenCalled());
    expect(builtIn.disable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show in Explorer' }));
    expect(bridge.showLogsInExplorer).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open Logs Window' }));
    expect(builtIn.openLogs).toHaveBeenCalled();
  });
  it('uses actual startup/update preferences and displays bridge errors', async () => {
    bridge.setAllowRemoteUpdates.mockResolvedValue({ ok: false, error: 'Policy could not be saved.' });
    render(<ThisPCSettings builtIn={builtIn} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Allow remote updates' }));
    await waitFor(() => expect(bridge.setAllowRemoteUpdates).toHaveBeenCalledWith(true));
    expect(await screen.findByRole('alert')).toHaveTextContent('Policy could not be saved.');
  });
});
