import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsPanel, providerLabel } from './SettingsPanel';
import { useStore } from '../../hooks/useStore';
import { useVoice, voiceSettings } from '../../lib/voice/voice';
import { useUsageShortcut } from '../../lib/usage-shortcut';

const commands = vi.hoisted(() => ({ updatePreferences: vi.fn(), setAutoArchiveDays: vi.fn(), deleteArchivedSessions: vi.fn(), removeDevice: vi.fn(), requestAccountDeletion: vi.fn(), registerPushToken: vi.fn(), unregisterPushToken: vi.fn() }));
vi.mock('../../lib/ws-client', () => ({ wsClient: { url: 'ws://localhost:4430', ...commands } }));
const push = vi.hoisted(() => ({ supported: false, isPushSubscribed: vi.fn(), subscribeToPush: vi.fn(), unsubscribeFromPush: vi.fn() }));
vi.mock('../../lib/push', () => ({ isPushSupported: () => push.supported, getPushPermission: () => 'default', isPushSubscribed: push.isPushSubscribed, subscribeToPush: push.subscribeToPush, unsubscribeFromPush: push.unsubscribeFromPush }));
vi.mock('../../hooks/useTheme', () => ({ useTheme: () => ({ theme: 'system', setTheme: vi.fn() }) }));
vi.mock('./ProfileBar', () => ({ signOut: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  push.supported = false;
  push.isPushSubscribed.mockResolvedValue(false);
  push.subscribeToPush.mockResolvedValue('subscription');
  push.unsubscribeFromPush.mockResolvedValue(true);
  localStorage.removeItem('kraki:notifications.enabled');
  useStore.getState().reset();
  useStore.setState({ status: 'connected', user: { id: 'u1', login: 'tester', provider: 'open' }, deviceId: 'self', archiveInfo: new Map([['computer', { count: 0, days: 14 }]]) });
  useUsageShortcut.setState({ shortcut: 'F6', enabled: true, recording: false });
  useVoice.setState({ words: [] });
  voiceSettings.correction = true;
});
const open = () => render(<SettingsPanel open onClose={vi.fn()} />);
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

describe('SettingsPanel native preferences parity', () => {
  it('has seven tabs and only one pane; General matches appearance/archive wording', () => {
    open();
    expect(screen.getAllByRole('tab').map((el) => el.textContent)).toEqual(['General', 'Account', 'Voice Input', 'Notifications', 'This PC', 'Devices', 'About']);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByText('Brand palette preview')).toBeInTheDocument();
    expect(screen.queryByText('Relay server')).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: '14 days' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '30' } });
    expect(commands.setAutoArchiveDays).toHaveBeenCalledWith('computer', 30);
    tab('About');
    expect(screen.queryByRole('radiogroup', { name: 'Theme' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Diagnostics' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Documentation' })).toHaveAttribute('href', 'https://kraki.chat/docs');
  });
  it('keeps archived session deletion behind native confirmation', () => {
    useStore.setState({ archiveInfo: new Map([['computer', { count: 3, days: 14 }]]) });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 Archived Sessions…' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent("Delete archived sessions from your computers? This can't be undone.");
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(commands.deleteArchivedSessions).not.toHaveBeenCalled();
  });
  it('hides the archive section when no computer supplies archive settings', () => {
    useStore.setState({ archiveInfo: new Map() });
    open();
    expect(screen.queryByRole('heading', { name: 'Sessions' })).not.toBeInTheDocument();
  });
  it('records a shortcut without opening account usage', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'F6' }));
    expect(screen.getByRole('button', { name: 'Press a shortcut…' })).toHaveClass('is-recording');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Press a shortcut…' }), { key: 'F8' });
    expect(useUsageShortcut.getState()).toMatchObject({ shortcut: 'F8', recording: false });
    expect(screen.getByRole('button', { name: 'F8' })).not.toHaveClass('is-recording');
  });
  it('clears the active recorder indication on blur and Escape without saving', () => {
    open();
    const recorder = screen.getByRole('button', { name: 'F6' });
    fireEvent.click(recorder);
    fireEvent.blur(recorder);
    expect(recorder).not.toHaveClass('is-recording');
    expect(useUsageShortcut.getState().shortcut).toBe('F6');
    fireEvent.click(recorder);
    fireEvent.keyDown(recorder, { key: 'Escape' });
    expect(recorder).not.toHaveClass('is-recording');
    expect(useUsageShortcut.getState()).toMatchObject({ shortcut: 'F6', recording: false });
  });
  it('shows notifications independently of push support', () => {
    open(); tab('Notifications');
    expect(screen.getByText('System permission')).toBeInTheDocument();
    expect(screen.getByText('Push notifications aren’t available with this relay.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Notify me when an agent replies or needs me' }));
    expect(localStorage.getItem('kraki:notifications.enabled')).toBe('0');
  });
  it('notification preference controls the existing browser push subscription', async () => {
    push.supported = true;
    push.isPushSubscribed.mockResolvedValue(true);
    useStore.setState({ vapidPublicKey: 'public-key' });
    open(); tab('Notifications');
    await screen.findByText('Push notifications are on, including when this browser is closed.');
    fireEvent.click(screen.getByRole('switch', { name: 'Notify me when an agent replies or needs me' }));
    await waitFor(() => expect(commands.unregisterPushToken).toHaveBeenCalledWith({ provider: 'web_push' }));
    expect(localStorage.getItem('kraki:notifications.enabled')).toBe('0');
    fireEvent.click(screen.getByRole('switch', { name: 'Notify me when an agent replies or needs me' }));
    await waitFor(() => expect(commands.registerPushToken).toHaveBeenCalledWith({ provider: 'web_push', token: 'subscription' }));
    expect(push.subscribeToPush).toHaveBeenCalledWith('public-key');
    expect(localStorage.getItem('kraki:notifications.enabled')).toBe('1');
  });
  it('shows open-auth identity and retains two-stage account deletion safety', () => {
    open(); tab('Account');
    expect(screen.getByText('Signed in via Open')).toBeInTheDocument();
    // Mac parity: Device ID is not an Account row (it is in About's diagnostics).
    expect(screen.queryByText('Device ID')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out…' }));
    expect(screen.getByRole('alertdialog', { name: 'Sign out of Kraki on this browser?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(commands.requestAccountDeletion).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: 'Delete account permanently?' })).toBeInTheDocument();
    expect(screen.getByTestId('delete-final').querySelector('.kp-alert-actions')).toHaveClass('is-stacked');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(commands.requestAccountDeletion).not.toHaveBeenCalled();
  });
  it('includes app devices and hides remove for this app and online devices', () => {
    useStore.setState({ devices: new Map([
      ['self', { id: 'self', name: 'This browser', role: 'app', online: false }],
      ['peer', { id: 'peer', name: 'Other browser', role: 'app', online: true }],
      ['old', { id: 'old', name: 'Old phone', role: 'app', online: false }],
    ]) });
    open(); tab('Devices');
    expect(screen.getByText('Other browser')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Remove…' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove…' }));
    expect(screen.getByRole('alertdialog', { name: 'Remove Old phone?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(commands.removeDevice).toHaveBeenCalledWith('old');
  });
  it('shows offline last-online metadata and sorts About diagnostics with offline suffixes', () => {
    useStore.setState({ devices: new Map([
      ['z', { id: 'z', name: 'Zulu', role: 'tentacle', online: true }],
      ['a', { id: 'a', name: 'Alpha', role: 'tentacle', online: false, lastSeen: new Date().toISOString() }],
      ['b', { id: 'b', name: 'Browser', role: 'app', online: true, lastSeen: new Date().toISOString() }],
    ]), deviceVersions: new Map([['a', '0.38.7'], ['z', '0.38.8']]) });
    const { container } = open(); tab('Devices');
    expect(screen.getAllByText('Last online today')).toHaveLength(1);
    expect(container.querySelectorAll('.kp-device')).toHaveLength(3);
    tab('About');
    const rows = [...container.querySelectorAll('.kp-diagnostic')];
    expect(rows.slice(2, 4).map((row) => row.textContent)).toEqual(['ALPHAKraki 0.38.7 · offline', 'ZULUKraki 0.38.8']);
  });
  it('provides empty vocabulary and disables dependent controls when correction is off', () => {
    open(); tab('Voice Input');
    expect(screen.getByText('No custom words yet. Add names and terms voice input gets wrong.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Custom word' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add Word' }));
    expect(screen.getByRole('textbox', { name: 'Custom word' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Correct Transcripts' }));
    expect(screen.getByRole('switch', { name: 'Use Conversation Context' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Custom word' })).toBeDisabled();
  });
  it('adds a custom word as an inline list row like Mac, saving only once it has a word', () => {
    useVoice.setState({ words: [], serverWords: [], outbox: [] });
    open(); tab('Voice Input');
    fireEvent.click(screen.getByRole('button', { name: 'Add Word' }));
    // Header appears, empty-state text goes, no separate Cancel/Add form.
    expect(screen.queryByText('No custom words yet. Add names and terms voice input gets wrong.')).not.toBeInTheDocument();
    expect(screen.getByText('Word or name')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    const word = screen.getByRole('textbox', { name: 'Custom word' });
    expect(word).toHaveFocus();
    expect(word).toHaveAttribute('placeholder', 'e.g. PostgreSQL');
    // Moving between the two fields of the row does not save a half-entered word.
    fireEvent.change(word, { target: { value: 'PostgreSQL' } });
    fireEvent.blur(word, { relatedTarget: screen.getByRole('textbox', { name: 'Often heard as' }) });
    expect(useVoice.getState().words).toEqual([]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Often heard as' }), { target: { value: 'post gress' } });
    fireEvent.blur(screen.getByRole('textbox', { name: 'Often heard as' }), { relatedTarget: null });
    expect(useVoice.getState().words.map((w) => w.term)).toEqual(['PostgreSQL']);
    expect(screen.queryByRole('textbox', { name: 'Custom word' })).not.toBeInTheDocument();
    // An empty new row is never sent and can be discarded.
    fireEvent.click(screen.getByRole('button', { name: 'Add Word' }));
    fireEvent.blur(screen.getByRole('textbox', { name: 'Custom word' }), { relatedTarget: null });
    expect(useVoice.getState().outbox).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove new word' }));
    expect(screen.queryByRole('textbox', { name: 'Custom word' })).not.toBeInTheDocument();
  });
  it('labels sign-in providers like Mac and lists the Device ID in About diagnostics', () => {
    expect([undefined, 'github', 'open', 'google'].map((p) => providerLabel(p))).toEqual(['GitHub', 'GitHub', 'Open', 'Google']);
    open(); tab('About');
    expect(screen.getByText('DEVICE ID')).toBeInTheDocument();
    expect(screen.getByText('self')).toBeInTheDocument();
  });
});
