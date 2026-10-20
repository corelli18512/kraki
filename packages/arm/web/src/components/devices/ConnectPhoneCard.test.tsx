import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../hooks/useStore';

vi.mock('../../lib/desktop', async (orig) => ({
  ...(await orig<typeof import('../../lib/desktop')>()),
  desktop: { builtIn: { connectPhone: async () => ({ ok: true, url: 'https://app.kraki.chat/?relay=x&token=t', expiresAt: new Date(Date.now() + 300_000).toISOString() }) } },
}));

import { desktop } from '../../lib/desktop';
import { CONNECT_PHONE_EVENT, ConnectPhoneHost } from './ConnectPhoneCard';

describe('Connect your phone card', () => {
  beforeEach(() => { vi.useFakeTimers(); useStore.getState().setDevices([]); });
  afterEach(() => vi.useRealTimers());

  it('shows Connected when a phone joins and closes itself even if devices keep updating', async () => {
    render(<ConnectPhoneHost />);
    await act(async () => { window.dispatchEvent(new Event(CONNECT_PHONE_EVENT)); await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByTestId('connect-phone')).toBeInTheDocument();
    act(() => useStore.getState().setDevices([{ id: 'phone', name: 'iPhone', role: 'app', online: true }]));
    expect(screen.getByText('Connected')).toBeInTheDocument();
    // The device list updates again (presence, greetings) before the timer fires.
    for (let i = 0; i < 4; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(800); });
      act(() => useStore.getState().setDevices([{ id: 'phone', name: 'iPhone', role: 'app', online: true }]));
    }
    expect(screen.queryByTestId('connect-phone')).toBeNull();
  });
});

it.each(['daemon_not_running', 'relay_failure'])('updates a pairing error after a language switch (%s)', async (error) => {
  const { i18next } = await import('../../i18n');
  const mock = vi.spyOn(desktop!.builtIn!, 'connectPhone').mockResolvedValue({ ok: false, error });
  render(<ConnectPhoneHost />);
  await act(async () => { window.dispatchEvent(new Event(CONNECT_PHONE_EVENT)); });
  expect(screen.getByText(error === 'daemon_not_running'
    ? 'Kraki isn’t running on this PC. Turn on “Run agents on this PC” in Settings, then try again.'
    : 'Couldn’t get a code from the relay. Check your connection and try again.')).toBeInTheDocument();
  try {
    await act(async () => { await i18next.changeLanguage('zh-Hans'); });
    expect(screen.getByText(error === 'daemon_not_running'
      ? '这台电脑上的 Kraki 未运行。请在设置中开启“在这台电脑上运行 Agent”，然后重试。'
      : '无法从中继服务器获取配对码。请检查连接后重试。')).toBeInTheDocument();
  } finally {
    mock.mockRestore();
    await act(async () => { await i18next.changeLanguage('en'); });
  }
});
