import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ThisPCSettings } from './ThisPCSettings';
import type { BuiltInBridge, BuiltInState } from '../../lib/desktop';

beforeEach(() => localStorage.clear());
it('Go Offline preserves ownership; Go Online and Reconnect show transitions and logs hierarchy', async () => {
  let state: BuiltInState = { available: true, version: '1', configured: true, signedIn: true, deviceName: 'PC', deviceId: 'd', relay: 'ws://localhost', owned: true, running: true, relayState: 'connected', cliDaemon: false, cliLogin: false };
  const b: BuiltInBridge = {
    state: async () => state, checkAgents: async () => ({ ok: true }), setup: async () => ({ ok: false }), cancelSetup: () => {}, connectPhone: async () => ({ ok: false }), credentials: () => null,
    enable: vi.fn(async () => { state = { ...state, running: true }; return { ok: true }; }),
    disable: vi.fn(async () => { state = { ...state, running: false }; return { ok: true }; }),
    restart: vi.fn(async () => ({ ok: true })), openLogs: vi.fn(), logsPath: async () => 'C:\\isolated\\logs', showLogsInExplorer: vi.fn(),
  };
  render(<ThisPCSettings builtIn={b} />);
  fireEvent.click(await screen.findByText('Go Offline'));
  expect(b.disable).toHaveBeenCalledWith({ keepOwnership: true });
  await screen.findByText('Offline');
  fireEvent.click(screen.getByText('Go Online'));
  await screen.findByText('Online');
  fireEvent.click(screen.getByText('Reconnect'));
  await waitFor(() => expect(b.restart).toHaveBeenCalledTimes(1));
  expect(screen.getByText('Updates')).toBeInTheDocument();
  expect(screen.getByText('C:\\isolated\\logs')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Show in Explorer')); fireEvent.click(screen.getByText('Open Logs Window'));
  expect(b.showLogsInExplorer).toHaveBeenCalledTimes(1); expect(b.openLogs).toHaveBeenCalledTimes(1);
});
