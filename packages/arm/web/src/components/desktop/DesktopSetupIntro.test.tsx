import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopSetup } from './DesktopSetup';
import type { BuiltInBridge } from '../../lib/desktop';

const bridge = (): BuiltInBridge => ({
  // A new object on every poll, like the real IPC bridge.
  state: async () => ({ available: true, version: '1', configured: false, signedIn: false, deviceName: 'PC', deviceId: null, relay: null, owned: false, running: false, relayState: null, cliDaemon: false, cliLogin: false }),
  checkAgents: async () => ({ ok: true }),
  setup: () => new Promise(() => {}),
  cancelSetup: () => {},
  connectPhone: async () => ({ ok: false }),
  enable: async () => ({ ok: true }),
  disable: async () => ({ ok: true }),
  restart: async () => ({ ok: true }),
  credentials: () => null,
  openLogs: () => {},
});

describe('Kraki for Windows setup intro', () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it('hands over to setup even while the state poll keeps answering', async () => {
    render(<DesktopSetup builtIn={bridge()} />);
    expect(screen.getByTestId('desktop-intro')).toBeInTheDocument();
    for (let i = 0; i < 12; i++) await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.queryByTestId('desktop-intro')).toBeNull();
    expect(screen.getByTestId('desktop-setup')).toBeInTheDocument();
  });
});
