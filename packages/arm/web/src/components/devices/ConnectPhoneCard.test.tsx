import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../hooks/useStore';

vi.mock('../../lib/desktop', async (orig) => ({
  ...(await orig<typeof import('../../lib/desktop')>()),
  desktop: { builtIn: { connectPhone: async () => ({ ok: true, url: 'https://app.kraki.chat/?relay=x&token=t', expiresAt: new Date(Date.now() + 300_000).toISOString() }) } },
}));

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
