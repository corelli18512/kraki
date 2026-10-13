import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { DesktopSetup } from './DesktopSetup';
import type { BuiltInBridge, SetupEvent } from '../../lib/desktop';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('kraki-desktop.introShown', '1');
  localStorage.setItem('kraki-desktop.role', 'runsAgents');
});
function bridge() {
  let event: (e: SetupEvent) => void = () => {};
  let finish: (result: { ok: boolean }) => void = () => {};
  const b: BuiltInBridge = {
    state: async () => ({ available: true, version: '1', configured: false, signedIn: false, deviceName: 'PC', deviceId: null, relay: null, owned: false, running: false, relayState: null, cliDaemon: false, cliLogin: false }),
    checkAgents: async () => ({ ok: true }),
    setup: vi.fn((_opts, handler) => { event = handler; return new Promise((resolve) => { finish = resolve; }); }),
    cancelSetup: vi.fn(), showSignInWindow: vi.fn(),
    connectPhone: async () => ({ ok: false }), enable: async () => ({ ok: true }), disable: async () => ({ ok: true }), restart: async () => ({ ok: true }), credentials: () => null, openLogs: () => {},
  };
  return { b, emit: (e: SetupEvent) => act(() => event(e)), completion: () => finish };
}
it('reopens existing OAuth, switches to code, ignores old completion, copies and waits', async () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  vi.spyOn(window, 'open').mockImplementation(() => null);
  const { b, emit, completion } = bridge();
  render(<DesktopSetup builtIn={b} />);
  fireEvent.click(await screen.findByText('Sign in with GitHub'));
  emit({ event: 'oauth_url', url: 'https://github.com' });
  fireEvent.click(screen.getByText('Show Sign-in Window'));
  expect(b.showSignInWindow).toHaveBeenCalledTimes(1);
  // Capture the first attempt's completion, then start a different flow.
  const oldFinish = completion();
  fireEvent.click(screen.getByText('Sign in with a code instead'));
  expect(b.setup).toHaveBeenLastCalledWith({ forceLogin: false, useCode: true }, expect.any(Function));
  emit({ event: 'device_code', userCode: 'ABCD', verificationUri: 'https://github.com/login/device' });
  await act(async () => {});
  expect(copy).toHaveBeenCalledWith('ABCD');
  expect(screen.getByText('Waiting for approval…')).toBeInTheDocument();
  expect(screen.getByText('The code is copied and GitHub is open in your browser. Paste it there and approve Kraki.')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Cancel'));
  act(() => oldFinish({ ok: false }));
  await act(async () => {});
  expect(screen.getByText('Sign in with GitHub')).toBeInTheDocument();
});
it('does not claim the code copied if clipboard fails', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  vi.spyOn(window, 'open').mockImplementation(() => null);
  const { b, emit } = bridge();
  render(<DesktopSetup builtIn={b} />);
  fireEvent.click(await screen.findByText('Sign in with GitHub'));
  emit({ event: 'device_code', userCode: 'ABCD', verificationUri: 'https://github.com/login/device' });
  await act(async () => {});
  expect(screen.queryByText(/The code is copied/)).toBeNull();
  expect(screen.getByText('Waiting for approval…')).toBeInTheDocument();
});
it('detecting uses independent launch logo and activity, not a setup card', () => {
  const { b } = bridge();
  b.state = () => new Promise(() => {});
  render(<DesktopSetup builtIn={b} />);
  expect(screen.getByTestId('desktop-launch').querySelector('.ds-launch-logo')).not.toBeNull();
  expect(document.querySelector('.ds-card')).toBeNull();
});
