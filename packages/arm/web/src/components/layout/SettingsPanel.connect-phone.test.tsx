import { useState } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';
import { ConnectPhoneHost } from '../devices/ConnectPhoneCard';
import { useStore } from '../../hooks/useStore';

const shell = vi.hoisted(() => ({ platform: 'win32', connectPhone: vi.fn() }));
vi.mock('../../lib/desktop', async (original) => ({
  ...await original<typeof import('../../lib/desktop')>(),
  desktop: {
    get platform() { return shell.platform; },
    version: '0.0.0-test',
    builtIn: {
      state: async () => ({ deviceId: 'pc' }),
      connectPhone: shell.connectPhone,
      credentials: () => null,
    },
  },
}));
vi.mock('../../lib/ws-client', () => ({ wsClient: { url: 'ws://localhost:4430' } }));
vi.mock('../../lib/push', () => ({ isPushSupported: () => false, getPushPermission: () => 'default' }));
vi.mock('../../hooks/useTheme', () => ({ useTheme: () => ({ theme: 'system', setTheme: vi.fn() }) }));
vi.mock('./ProfileBar', () => ({ signOut: vi.fn() }));

const code = { ok: true, url: 'https://example.invalid/disposable-pairing-test', expiresAt: new Date(Date.now() + 300_000).toISOString() };
const settingsClosed = vi.fn();
function SettingsAndPairing() {
  const [open, setOpen] = useState(true);
  return <>
    <SettingsPanel open={open} onClose={() => { settingsClosed(); setOpen(false); }} />
    <ConnectPhoneHost />
  </>;
}
async function openWithKeyboard(user: ReturnType<typeof userEvent.setup>) {
  render(<SettingsAndPairing />);
  await user.click(screen.getByRole('tab', { name: 'Devices' }));
  const opener = screen.getByRole('button', { name: 'Show Code…' });
  opener.focus();
  await user.keyboard('{Enter}');
  return { opener, pairing: screen.getByRole('dialog', { name: 'Connect your phone' }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  shell.platform = 'win32';
  shell.connectPhone.mockResolvedValue(code);
  useStore.getState().reset();
  useStore.setState({ status: 'connected', deviceId: 'self', user: { id: 'u1', login: 'tester', provider: 'open' } });
});
afterEach(() => vi.useRealTimers());

describe('SettingsPanel + sibling ConnectPhoneHost keyboard ownership', () => {
  it.each(['win32', 'linux'])('enters, contains and restores focus; Escape closes only pairing (%s)', async (platform) => {
    shell.platform = platform;
    let resolveCode!: (result: typeof code) => void;
    shell.connectPhone.mockImplementationOnce(() => new Promise((resolve) => { resolveCode = resolve; }));
    const user = userEvent.setup();
    const { opener, pairing } = await openWithKeyboard(user);
    const close = within(pairing).getByRole('button', { name: 'Close', exact: true });
    expect(close).toHaveFocus();
    expect(within(pairing).getByRole('button', { name: 'Copy link' })).toBeDisabled();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    // A sibling modal, not a descendant of Settings, owns even programmatic focus attempts.
    opener.focus();
    expect(close).toHaveFocus();
    await act(async () => resolveCode(code));
    const copy = within(pairing).getByRole('button', { name: 'Copy link' });
    await user.tab();
    expect(copy).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(copy).toHaveFocus();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await user.keyboard('{Enter}');
    expect(write).toHaveBeenCalledWith(code.url);
    expect(within(pairing).getByRole('button', { name: 'Copied' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Connect your phone' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(settingsClosed).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(settingsClosed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('keeps retry/loading/success controls reachable and restores Show Code on button/backdrop close', async () => {
    shell.connectPhone.mockResolvedValueOnce({ ok: false, error: 'daemon_not_running' });
    let resolveRetry!: (result: typeof code) => void;
    shell.connectPhone.mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
    const user = userEvent.setup();
    const { opener, pairing } = await openWithKeyboard(user);
    const close = within(pairing).getByRole('button', { name: 'Close', exact: true });
    const retry = await within(pairing).findByRole('button', { name: 'Try again' });
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(retry).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab();
    expect(retry).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(shell.connectPhone).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(close).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await act(async () => resolveRetry(code));
    await user.tab();
    expect(within(pairing).getByRole('button', { name: 'Copy link' })).toHaveFocus();
    await user.click(close);
    expect(opener).toHaveFocus();
    expect(screen.queryByRole('dialog', { name: 'Connect your phone' })).not.toBeInTheDocument();
    expect(settingsClosed).not.toHaveBeenCalled();
    shell.connectPhone.mockResolvedValueOnce({ ok: false, error: 'offline' });
    await user.keyboard('{Enter}');
    const errorPairing = screen.getByRole('dialog', { name: 'Connect your phone' });
    await within(errorPairing).findByRole('button', { name: 'Try again' });
    await user.click(errorPairing.parentElement!);
    expect(screen.queryByRole('dialog', { name: 'Connect your phone' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(settingsClosed).not.toHaveBeenCalled();
  });

  it('restores Show Code when a successful connection auto-closes pairing', async () => {
    const user = userEvent.setup();
    const { opener, pairing } = await openWithKeyboard(user);
    await within(pairing).findByRole('button', { name: 'Copy link' });
    await user.tab();
    expect(within(pairing).getByRole('button', { name: 'Copy link' })).toHaveFocus();
    vi.useFakeTimers();
    act(() => useStore.getState().setDevices([{ id: 'phone', name: 'Test phone', role: 'app', online: true }]));
    expect(within(pairing).getByText('Connected')).toBeInTheDocument();
    expect(within(pairing).getByRole('button', { name: 'Close', exact: true })).toHaveFocus();
    await act(async () => { await vi.advanceTimersByTimeAsync(2200); });
    expect(screen.queryByRole('dialog', { name: 'Connect your phone' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(settingsClosed).not.toHaveBeenCalled();
  });
});
