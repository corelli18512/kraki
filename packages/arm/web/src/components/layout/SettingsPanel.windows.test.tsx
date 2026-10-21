import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { KrakiDesktopBridge } from '../../lib/desktop';
import { SettingsPanel } from './SettingsPanel';
import { useStore } from '../../hooks/useStore';
import { useUsageShortcut } from '../../lib/usage-shortcut';
import { signOut } from './ProfileBar';

const shell = vi.hoisted(() => ({ desktop: undefined as KrakiDesktopBridge | undefined }));
vi.mock('../../lib/desktop', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/desktop')>(),
  get desktop() { return shell.desktop; },
}));
const commands = vi.hoisted(() => ({ updatePreferences: vi.fn(), setAutoArchiveDays: vi.fn(), removeDevice: vi.fn(), requestAccountDeletion: vi.fn() }));
vi.mock('../../lib/ws-client', () => ({ wsClient: { url: 'ws://localhost:4430', ...commands } }));
vi.mock('../../lib/push', () => ({ isPushSupported: () => false, getPushPermission: () => 'default' }));
const theme = vi.hoisted(() => ({ theme: 'system', setTheme: vi.fn() }));
vi.mock('../../hooks/useTheme', () => ({ useTheme: () => theme }));
vi.mock('./ProfileBar', () => ({ signOut: vi.fn() }));
const os = { usageShortcut: 'F6', usageShortcutEnabled: true, launchAtLogin: false, keepRunningInTray: true, notificationPermission: 'granted' as const, logsPath: null, allowRemoteUpdates: false };
const bridge = {
  state: vi.fn(), setKeepRunningInTray: vi.fn(), setLaunchAtLogin: vi.fn(),
  setUsageShortcut: vi.fn(), openNotificationSettings: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useStore.getState().reset();
  useStore.setState({ status: 'connected', user: { id: 'u1', login: 'tester', provider: 'open' }, deviceId: 'self', archiveInfo: new Map([['pc', { count: 0, days: 14 }]]) });
  useUsageShortcut.setState({ shortcut: 'F6', enabled: true, recording: false });
  bridge.state.mockResolvedValue(os);
  bridge.setKeepRunningInTray.mockResolvedValue({ ok: true });
  bridge.setLaunchAtLogin.mockResolvedValue({ ok: true });
  bridge.setUsageShortcut.mockResolvedValue({ ok: true });
  shell.desktop = { platform: 'win32', settings: bridge, version: '0.1.0' } as unknown as KrakiDesktopBridge;
});
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

describe('SettingsPanel Windows-scoped rounded design', () => {
  it.each([undefined, 'linux', 'darwin'])('keeps the current toolbar outside Windows Electron (%s)', async (platform) => {
    shell.desktop = platform ? { ...shell.desktop!, platform } : undefined;
    render(<SettingsPanel open onClose={vi.fn()} />);
    expect(screen.getByTestId('settings-window')).not.toHaveClass('kp-windows');
    expect(screen.getByRole('tablist')).not.toHaveAttribute('aria-orientation');
    expect(screen.getByText('Brand palette preview')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Account details' })).not.toBeInTheDocument();
    expect(screen.getByRole('radiogroup')).toHaveClass('kp-segment');
    const general = screen.getByRole('tab', { name: 'General' });
    fireEvent.keyDown(general, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Account' })).toHaveFocus();
    expect(screen.getByRole('tabpanel', { name: 'Account' })).toBeInTheDocument();
    if (platform) await waitFor(() => expect(bridge.state).toHaveBeenCalled());
  });

  it('uses vertical roving navigation, keeps seven real panes, and restores opener focus', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const view = render(<SettingsPanel open onClose={onClose} />);
    await screen.findByRole('switch', { name: 'Open Kraki at login' });
    expect(screen.getByTestId('settings-window')).toHaveClass('kp-window', 'kp-windows');
    expect(screen.getByRole('dialog', { name: 'Settings' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getAllByRole('tab')).toHaveLength(7);
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
    const general = screen.getByRole('tab', { name: 'General' });
    expect(general).toHaveFocus();
    fireEvent.keyDown(general, { key: 'ArrowDown' });
    const account = screen.getByRole('tab', { name: 'Account' });
    expect(account).toHaveFocus();
    expect(account).toHaveAttribute('aria-selected', 'true');
    expect(general).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(account, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'About' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Copy Diagnostics' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'About' }), { key: 'ArrowDown' });
    expect(general).toHaveFocus();
    fireEvent.keyDown(general, { key: 'ArrowUp' });
    expect(screen.getByRole('tab', { name: 'About' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'About' }), { key: 'Home' });
    expect(general).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Account details' }));
    expect(screen.getByRole('tabpanel', { name: 'Account' })).toHaveTextContent('Signed in via Open');
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(<SettingsPanel open={false} onClose={onClose} />);
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('preserves theme preferences, OS actions, shortcut failures, archive settings, and notification controls', async () => {
    render(<SettingsPanel open onClose={vi.fn()} />);
    expect(screen.getByRole('radiogroup')).toHaveClass('kp-theme-grid');
    expect(screen.getByRole('radio', { name: 'Use system' })).toHaveAttribute('tabindex', '0');
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(theme.setTheme).toHaveBeenCalledWith('dark');
    expect(commands.updatePreferences).toHaveBeenCalledWith({ theme: 'dark' });
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Use system' }), { key: 'Home' });
    expect(theme.setTheme).toHaveBeenLastCalledWith('light');
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveFocus();
    fireEvent.click(await screen.findByRole('switch', { name: 'Open Kraki at login' }));
    await waitFor(() => expect(bridge.setLaunchAtLogin).toHaveBeenCalledWith(true));
    fireEvent.click(screen.getByRole('switch', { name: 'Keep running in tray when window closes' }));
    await waitFor(() => expect(bridge.setKeepRunningInTray).toHaveBeenCalledWith(false));
    bridge.setUsageShortcut.mockResolvedValue({ ok: false, error: 'Shortcut unavailable.' });
    fireEvent.click(screen.getByRole('button', { name: 'F6' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Press a shortcut…' }), { key: 'F8' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Shortcut unavailable.');
    expect(useUsageShortcut.getState().shortcut).toBe('F6');
    fireEvent.change(screen.getByRole('combobox', { name: 'Archive After' }), { target: { value: '30' } });
    expect(commands.setAutoArchiveDays).toHaveBeenCalledWith('pc', 30);
    tab('Notifications');
    expect(screen.getByText('Granted')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open System Settings…' }));
    expect(bridge.openNotificationSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('switch', { name: 'Notify me when an agent replies or needs me' }));
    expect(localStorage.getItem('kraki:notifications.enabled')).toBe('0');
    expect(screen.queryByText('Web Push')).not.toBeInTheDocument();
  });

  it('keeps destructive actions confirmed and foreground Escape independent of Settings', async () => {
    const onClose = vi.fn();
    render(<SettingsPanel open onClose={onClose} />);
    await screen.findByRole('switch', { name: 'Open Kraki at login' });
    tab('Account');
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out…' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Conversations cached on this PC are removed.');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(signOut).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete account permanently?' })).toBeInTheDocument();
    expect(commands.requestAccountDeletion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Sign Out…' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps this PC protected from removal and retains the real remote-only This PC controls', async () => {
    const builtIn = {
      state: vi.fn().mockResolvedValue({ available: true, configured: true, signedIn: true, deviceId: 'pc', deviceName: 'Test PC', owned: false, running: false, cliDaemon: false, cliLogin: false }),
      credentials: () => null, enable: vi.fn(), disable: vi.fn(), restart: vi.fn(), openLogs: vi.fn(),
    };
    shell.desktop!.builtIn = builtIn as unknown as NonNullable<KrakiDesktopBridge['builtIn']>;
    useStore.setState({ devices: new Map([
      ['self', { id: 'self', name: 'This app', role: 'app', online: false }],
      ['pc', { id: 'pc', name: 'Test PC', role: 'tentacle', online: false }],
      ['old', { id: 'old', name: 'Old phone', role: 'app', online: false }],
    ]) });
    render(<SettingsPanel open onClose={vi.fn()} />);
    await screen.findByRole('switch', { name: 'Open Kraki at login' });
    tab('Devices');
    expect(screen.getAllByRole('button', { name: 'Remove…' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove…' }));
    expect(screen.getByRole('alertdialog', { name: 'Remove Old phone?' })).toBeInTheDocument();
    expect(commands.removeDevice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(commands.removeDevice).toHaveBeenCalledWith('old');
    tab('This PC');
    expect(await screen.findByRole('button', { name: 'Go Online' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check Coding Agents…' })).toBeInTheDocument();
    expect(builtIn.enable).not.toHaveBeenCalled();
    expect(builtIn.disable).not.toHaveBeenCalled();
    tab('Voice Input');
    expect(screen.getByRole('switch', { name: 'Correct Transcripts' })).toBeInTheDocument();
    expect(screen.getByText(/a third-party AI service fixes recognition mistakes/)).toBeInTheDocument();
  });

  it('traps modal focus without trapping inline settings or swallowing shortcut Escape', async () => {
    const onClose = vi.fn();
    const view = render(<SettingsPanel open onClose={onClose} />);
    await screen.findByRole('switch', { name: 'Open Kraki at login' });
    const last = screen.getByRole('switch', { name: 'Open Kraki at login' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    const close = screen.getByRole('button', { name: 'Close settings' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'F6' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Press a shortcut…' }), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    view.rerender(<SettingsPanel open inline onClose={onClose} />);
    expect(screen.getByTestId('settings-window')).toHaveClass('kp-inline', 'kp-windows');
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-modal');
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
