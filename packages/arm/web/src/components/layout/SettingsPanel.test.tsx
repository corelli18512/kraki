import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAccountDeletion } from '../../lib/account-deletion';
import { SettingsPanel, providerLabel, performanceDataFooter } from './SettingsPanel';
import { diag } from '../../lib/diag';
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
  commands.registerPushToken.mockResolvedValue('registered');
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
  it('has six tabs in a Mac/Linux browser and only one pane; General matches appearance/archive wording', () => {
    open();
    expect(screen.getAllByRole('tab').map((el) => el.textContent)).toEqual(['General', 'Account', 'Voice Input', 'Notifications', 'Devices', 'About']);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByText('Brand palette preview')).toBeInTheDocument();
    expect(screen.queryByText('Relay server')).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: '14 days' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Archive After' }), { target: { value: '30' } });
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
  it('focuses the recorder on click so Safari delivers the keys (K-226)', () => {
    open();
    const recorder = screen.getByRole('button', { name: 'F6' });
    // Like Safari, a synthetic click does not focus a button by itself.
    fireEvent.click(recorder);
    expect(recorder).toHaveFocus();
  });
  it('shows the Command key as Cmd in a Mac browser, not Super (K-226)', () => {
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15');
    useUsageShortcut.setState({ shortcut: 'Super+Shift+J' });
    open();
    expect(screen.getByRole('button', { name: 'Cmd+Shift+J' })).toBeInTheDocument();
    expect(screen.getByText('Hold Cmd+Shift+J to peek at account usage')).toBeInTheDocument();
    expect(screen.getByText(/combination with Control, Option or Command/)).toBeInTheDocument();
    ua.mockRestore();
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
    push.supported = true;
    open(); tab('Notifications');
    expect(screen.getByText('System permission')).toBeInTheDocument();
    expect(screen.getByText('Push notifications aren’t available with this relay.')).toBeInTheDocument();
    // Without Web Push a browser has no way to notify: the switch reads off
    // and cannot be turned on (K-111).
    const notify = screen.getByRole('switch', { name: 'Notify me when an agent replies or needs me' });
    expect(notify).toHaveAttribute('aria-checked', 'false');
    expect(notify).toBeDisabled();
  });
  it('K-111: says the browser, not the relay, lacks push when it does', () => {
    useStore.setState({ vapidPublicKey: 'public-key' });
    open(); tab('Notifications');
    expect(screen.getByText('Push notifications aren’t available in this browser.')).toBeInTheDocument();
    expect(screen.queryByText('Push notifications aren’t available with this relay.')).not.toBeInTheDocument();
    const notify = screen.getByRole('switch', { name: 'Notify me when an agent replies or needs me' });
    expect(notify).toHaveAttribute('aria-checked', 'false');
    expect(notify).toBeDisabled();
  });
  it('K-111: Notify me reads off in a fresh browser that is not subscribed to push', async () => {
    push.supported = true;
    useStore.setState({ vapidPublicKey: 'public-key' });
    open(); tab('Notifications');
    await waitFor(() => expect(push.isPushSubscribed).toHaveBeenCalled());
    expect(screen.getByText('Turn notifications on to receive replies and requests when this browser is closed.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Notify me when an agent replies or needs me' })).toHaveAttribute('aria-checked', 'false');
  });
  it('K-111: Allow Notifications… subscribes to Web Push', async () => {
    push.supported = true;
    useStore.setState({ vapidPublicKey: 'public-key' });
    open(); tab('Notifications');
    fireEvent.click(screen.getByRole('button', { name: 'Allow Notifications…' }));
    await waitFor(() => expect(commands.registerPushToken).toHaveBeenCalledWith({ provider: 'web_push', token: 'subscription' }));
    expect(push.subscribeToPush).toHaveBeenCalledWith('public-key');
    await screen.findByText('Push notifications are on, including when this browser is closed.');
    expect(screen.getByRole('switch', { name: 'Notify me when an agent replies or needs me' })).toHaveAttribute('aria-checked', 'true');
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
  it('K-227: a push token the relay refuses does not read as on and gives a localized error', async () => {
    push.supported = true;
    push.isPushSubscribed.mockResolvedValue(false);
    commands.registerPushToken.mockResolvedValue('refused');
    localStorage.setItem('kraki:notifications.enabled', '0');
    useStore.setState({ vapidPublicKey: 'public-key' });
    open(); tab('Notifications');
    fireEvent.click(screen.getByRole('switch', { name: 'Notify me when an agent replies or needs me' }));
    await screen.findByText('The relay didn’t accept push notifications from this browser. Notifications still appear while Kraki is open.');
    expect(push.unsubscribeFromPush).toHaveBeenCalled();
    expect(screen.queryByText('Push notifications are on, including when this browser is closed.')).not.toBeInTheDocument();
    expect(localStorage.getItem('kraki:notifications.enabled')).toBe('1');
  });
  it('K-227: offline or unanswered, push is not reported as refused and the subscription stays', async () => {
    push.supported = true;
    push.isPushSubscribed.mockResolvedValue(false);
    commands.registerPushToken.mockResolvedValue('unconfirmed');
    localStorage.setItem('kraki:notifications.enabled', '0');
    useStore.setState({ vapidPublicKey: 'public-key' });
    open(); tab('Notifications');
    fireEvent.click(screen.getByRole('switch', { name: 'Notify me when an agent replies or needs me' }));
    await screen.findByText('Couldn’t update push notifications.');
    expect(push.unsubscribeFromPush).not.toHaveBeenCalled();
    expect(screen.queryByText(/didn’t accept push/)).not.toBeInTheDocument();
    expect(localStorage.getItem('kraki:notifications.enabled')).toBe('0');
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
  it('K-203: account deletion stays visible when the connection drops', async () => {
    open(); tab('Account');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    act(() => { useStore.setState({ status: 'disconnected' }); });
    // The open final confirmation does not vanish silently.
    expect(screen.getByRole('alertdialog', { name: 'Delete account permanently?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    act(() => { useAccountDeletion.getState().set({ kind: 'deleting', attempt: 1 }); });
    expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
    act(() => { useAccountDeletion.getState().set({ kind: 'failed', message: 'Kraki didn\'t answer. Check the connection and try again.' }); });
    expect(screen.getByText('Kraki didn\'t answer. Check the connection and try again.')).toBeInTheDocument();
    act(() => { useAccountDeletion.getState().set({ kind: 'idle' }); });
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
    expect(rows.slice(1, 3).map((row) => row.textContent)).toEqual(['ALPHAKraki 0.38.7 · offline', 'ZULUKraki 0.38.8']);
  });
  it('About: no Background Service row in a browser, no "Kraki —" for an offline computer (K-233)', () => {
    useStore.setState({ devices: new Map([
      ['a', { id: 'a', name: 'Alpha', role: 'tentacle', online: false }],
      ['z', { id: 'z', name: 'Zulu', role: 'tentacle', online: true }],
    ]) });
    const { container } = open(); tab('About');
    const rows = [...container.querySelectorAll('.kp-diagnostic')].map((row) => row.textContent);
    expect(rows.some((row) => row?.startsWith('BACKGROUND SERVICE'))).toBe(false);
    expect(rows).toContain('ALPHAKraki · offline');
    expect(rows).toContain('ZULUKraki —');
  });
  it('reopens on General, not the last tab (K-233)', () => {
    const view = render(<SettingsPanel open onClose={vi.fn()} />);
    tab('About');
    view.rerender(<SettingsPanel open={false} onClose={vi.fn()} />);
    view.rerender(<SettingsPanel open onClose={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
  });
  it.each([
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', false],
    ['Linux', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', false],
    ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', true],
  ])('shows the This PC tab with its Windows hint only in a Windows browser: %s (K-228)', (_name, userAgent, shown) => {
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    open();
    expect(!!screen.queryByRole('tab', { name: 'This PC' })).toBe(shown);
    ua.mockRestore();
  });
  it.each([
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', false],
    ['Android phone', 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36', false],
    ['Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', true],
  ])('shows the keyboard-only usage shortcut only where there is a keyboard: %s (K-228)', (_name, userAgent, shown) => {
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    open();
    expect(!!screen.queryByRole('switch', { name: 'Peek at account usage' })).toBe(shown);
    expect(!!screen.queryByText('Shortcut')).toBe(shown);
    ua.mockRestore();
  });
  it('the Dogfood row says when the switch is impossible instead of "Switching…" forever (K-229)', async () => {
    const { applyAccountChannel } = await import('../../lib/auth');
    // A browser that refuses the channel cookie.
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => '', set: () => {} });
    try {
      applyAccountChannel({ internal: true });
      useStore.setState({ user: { id: 'u1', login: 'tester', provider: 'open', preferences: { internal: true } } });
      open();
      expect(screen.getByTestId('release-channel')).toHaveTextContent('Couldn’t switch in this browser');
    } finally {
      delete (document as unknown as { cookie?: string }).cookie;
    }
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
  it('Share Performance Data: shown only where diagnostics run (Windows shell), Mac copy, toggles the client', () => {
    open();
    expect(screen.queryByRole('switch', { name: 'Share Performance Data' })).not.toBeInTheDocument();
    const active = vi.spyOn(diag, 'active', 'get').mockReturnValue(true);
    vi.spyOn(diag, 'enabled', 'get').mockReturnValue(true);
    const set = vi.spyOn(diag, 'setEnabled').mockResolvedValue();
    try {
      open();
      const toggle = screen.getAllByRole('switch', { name: 'Share Performance Data' }).at(-1)!;
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(screen.getAllByText(performanceDataFooter()).length).toBeGreaterThan(0);
      expect(performanceDataFooter()).toContain('Never message text, drafts, voice, attachments or file names.');
      fireEvent.click(toggle);
      expect(set).toHaveBeenCalledWith(false);
    } finally { active.mockRestore(); }
  });
});

describe('K-199: the Dogfood section is localized', () => {
  it('shows zh-Hans texts for an internal account', async () => {
    const i18next = (await import('i18next')).default;
    await i18next.changeLanguage('zh-Hans');
    try {
      useStore.setState({ user: { id: 'u1', login: 'tester', provider: 'open', preferences: { internal: true } } });
      open();
      expect(screen.getByText('内部账户：你会最先收到每个新版本。')).toBeInTheDocument();
      expect(screen.queryByText('Builds')).not.toBeInTheDocument();
      expect(screen.getByTestId('release-channel').textContent).toMatch(/^(内测|正在切换…|无法在此浏览器中切换)$/);
    } finally {
      await i18next.changeLanguage('en');
    }
  });
});

// K-104: phones have no app menu and no F6, so the narrow Settings (inline)
// is the way to Account Usage, and its footer does not point at the sidebar.
describe('Account Usage on narrow layouts (K-104)', () => {
  it('inline Settings opens Account Usage and does not point at the sidebar', async () => {
    const { OPEN_USAGE_EVENT } = await import('../usage/UsagePanel');
    const opened = vi.fn();
    window.addEventListener(OPEN_USAGE_EVENT, opened);
    try {
      render(<SettingsPanel open inline onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Show Account Usage' }));
      expect(opened).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('“Account Usage” in the sidebar', { exact: false })).not.toBeInTheDocument();
    } finally { window.removeEventListener(OPEN_USAGE_EVENT, opened); }
  });
  it('the wide Settings window keeps the sidebar entry wording and no extra button', () => {
    open();
    expect(screen.queryByRole('button', { name: 'Show Account Usage' })).not.toBeInTheDocument();
    expect(screen.getByText('“Account Usage” in the sidebar', { exact: false })).toBeInTheDocument();
  });
});

// K-212: the web Settings window is a modal dialog for assistive technology
// and the keyboard: aria-modal, focus moves in on open and back on close.
describe('Settings window modality on the web (K-212)', () => {
  it('is aria-modal, focuses the selected tab and returns focus on close', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    try {
      const view = render(<SettingsPanel open onClose={vi.fn()} />);
      expect(screen.getByRole('dialog', { name: 'Settings' })).toHaveAttribute('aria-modal', 'true');
      expect(screen.getByRole('tab', { name: 'General' })).toHaveFocus();
      view.rerender(<SettingsPanel open={false} onClose={vi.fn()} />);
      expect(opener).toHaveFocus();
    } finally { opener.remove(); }
  });
  // Safari's default Tab order skips buttons, so focus can be on a control
  // that is not the last one when Tab should wrap (same as K-101).
  it('moves focus itself on every Tab, so Safari cannot leave the window', () => {
    render(<SettingsPanel open onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const tab = screen.getByRole('tab', { name: 'General' });
    expect(fireEvent.keyDown(tab, { key: 'Tab' })).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(tab);
    const next = document.activeElement as HTMLElement;
    expect(fireEvent.keyDown(next, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(tab);
  });
  it('inline (narrow) Settings is not modal and does not take focus', () => {
    render(<SettingsPanel open inline onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-modal');
    expect(screen.getByRole('tab', { name: 'General' })).not.toHaveFocus();
  });
});
