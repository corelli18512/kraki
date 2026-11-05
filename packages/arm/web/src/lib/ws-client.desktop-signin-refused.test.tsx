/**
 * Kraki for Windows whose built-in Kraki has a GitHub token the relay no
 * longer accepts. It used to flip every ~10 s between "Sign in again" and the
 * dashboard's "Disconnected" overlay: each reconnect signed in with the same
 * refused token. It must stay on "Sign in again" and connect again only once
 * the built-in Kraki has been signed in again.
 */
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuiltInBridge, BuiltInState } from './desktop';

vi.mock('./message-db', () => ({
  putMessage: async () => {}, putMessages: async () => {}, getMessages: async () => [],
  getAllMessages: async () => new Map(), getLastSeq: async () => 0, deleteSessionMessages: async () => {},
  updateSessionMessages: async () => {}, clearAllMessages: async () => {},
}));
vi.mock('./e2e', () => ({
  createAppKeyStore: () => ({
    isReady: () => true,
    init: async () => {},
    getSigningPublicKey: async () => 'mock-signing-key',
    getPublicKey: async () => 'mock-encryption-key',
  }),
}));

type MockSocket = WebSocket & { sentMessages: string[]; _receive: (data: Record<string, unknown>) => void };

const RELAY = 'wss://cn.relay.test';
let finishSignIn: () => void = () => {};
const OriginalWebSocket = globalThis.WebSocket;
let sockets: MockSocket[] = [];
/** Tokens the mock relay accepts; any other github_token gets auth_rejected. */
let accepted = new Set<string>();

/** Mock relay: answers each `auth`, and (like the Head's auth deadline) closes
 *  a socket that did not sign in 10 s after opening. */
function installRelay() {
  globalThis.WebSocket = class extends OriginalWebSocket {
    constructor(url: string) {
      super(url);
      const ws = this as unknown as MockSocket;
      sockets.push(ws);
      const send = ws.send.bind(ws);
      let signedIn = false;
      ws.send = (data: string) => {
        send(data);
        const msg = JSON.parse(data) as { type: string; auth?: { method: string; token?: string } };
        if (msg.type !== 'auth') return;
        setTimeout(() => {
          if (msg.auth?.method === 'github_token' && accepted.has(msg.auth.token ?? '')) {
            signedIn = true;
            ws._receive({ type: 'auth_ok', deviceId: 'dev-desktop', devices: [], user: { id: 'u1', login: 'octo', provider: 'github' } });
          } else {
            ws._receive({ type: 'auth_error', code: 'auth_rejected', message: 'Invalid GitHub token' });
          }
        }, 0);
      };
      setTimeout(() => { if (!signedIn && ws.readyState === OriginalWebSocket.OPEN) ws.close(); }, 10_000);
    }
  } as unknown as typeof OriginalWebSocket;
}

function authAttempts(): string[] {
  return sockets.flatMap((ws) => ws.sentMessages.map((m) => JSON.parse(m) as { type: string; auth?: { token?: string } })
    .filter((m) => m.type === 'auth').map((m) => m.auth?.token ?? ''));
}

function installDesktop(token: { current: string }) {
  const state: BuiltInState = {
    available: true, version: '0.1.9', configured: true, signedIn: true, deviceName: 'PC', deviceId: 'tentacle-1',
    relay: RELAY, owned: true, running: true, relayState: null, cliDaemon: false, cliLogin: false,
  };
  const builtIn: BuiltInBridge = {
    state: async () => state,
    checkAgents: async () => ({ ok: true }),
    // Finishes when the test calls `finishSignIn` (the user approving on GitHub).
    setup: vi.fn(() => new Promise((resolve) => {
      finishSignIn = () => { token.current = 'gho_new'; resolve({ ok: true, username: 'octo' }); };
    })),
    cancelSetup: vi.fn(),
    connectPhone: async () => ({ ok: false }),
    enable: async () => ({ ok: true }),
    disable: async () => ({ ok: true }),
    restart: async () => ({ ok: true }),
    credentials: () => ({ relay: RELAY, token: token.current }),
    openLogs: () => {},
  };
  (window as unknown as { krakiDesktop?: unknown }).krakiDesktop = {
    platform: 'win32', deviceName: 'Kraki Windows', version: '0.1.9', oauthRedirectOrigin: 'https://kraki.chat',
    notify: () => {}, setBadge: () => {}, onOpenSession: () => () => {}, builtIn,
  };
  return builtIn;
}

async function boot() {
  vi.resetModules();
  const { KrakiWSClient } = await import('./ws-client');
  const { useStore } = await import('../hooks/useStore');
  const { DashboardPage } = await import('../pages/DashboardPage');
  const client = new KrakiWSClient();
  // The page's DesktopSetup talks to the app's client.
  const { wsClient } = await import('./ws-client');
  return { client, wsClient, useStore, DashboardPage };
}

describe('Kraki for Windows: the relay refuses the built-in Kraki\'s sign-in', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    localStorage.clear();
    localStorage.setItem('kraki-desktop.introShown', '1');
    localStorage.setItem('kraki-desktop.role', 'runsAgents');
    localStorage.setItem('kraki-desktop.owner', 'builtIn');
    sockets = [];
    accepted = new Set();
    installRelay();
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = OriginalWebSocket;
    delete (window as unknown as { krakiDesktop?: unknown }).krakiDesktop;
    localStorage.clear();
  });

  it('stays on "Sign in again" and does not sign in with the refused token again', async () => {
    const token = { current: 'gho_revoked' };
    installDesktop(token);
    const { client, useStore, DashboardPage } = await boot();
    client.connect();
    await vi.advanceTimersByTimeAsync(10);
    expect(authAttempts()).toEqual(['gho_revoked']);
    expect(useStore.getState().status).toBe('awaiting_login');

    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    // A minute of relay deadlines and transport backoff: no second attempt.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(authAttempts()).toEqual(['gho_revoked']);
    expect(useStore.getState().status).toBe('awaiting_login');
    expect(screen.getByText('Sign in again')).toBeInTheDocument();
    expect(screen.getByTestId('desktop-setup-signin')).toBeInTheDocument();
  });

  it('keeps this PC\'s device id and does not retry when it signed in before', async () => {
    localStorage.setItem('kraki_device', JSON.stringify({ relay: RELAY, deviceId: 'dev-desktop' }));
    installDesktop({ current: 'gho_revoked' });
    const { client, useStore } = await boot();
    client.connect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(authAttempts()).toEqual(['gho_revoked']);
    expect(useStore.getState().status).toBe('awaiting_login');
    expect(JSON.parse(localStorage.getItem('kraki_device')!)).toEqual({ relay: RELAY, deviceId: 'dev-desktop' });
  });

  it('connects again with the new token once the built-in Kraki is signed in again', async () => {
    const token = { current: 'gho_revoked' };
    const builtIn = installDesktop(token);
    accepted.add('gho_new');
    const { wsClient, useStore, DashboardPage } = await boot();
    wsClient.connect();
    await vi.advanceTimersByTimeAsync(10);
    expect(useStore.getState().status).toBe('awaiting_login');

    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { screen.getByTestId('desktop-setup-signin').click(); });
    expect(builtIn.setup).toHaveBeenCalledWith({ forceLogin: true, useCode: false }, expect.any(Function));
    // The sign-in in progress is not cancelled by the page going away.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(builtIn.cancelSetup).not.toHaveBeenCalled();
    expect(authAttempts()).toEqual(['gho_revoked']);

    await act(async () => { finishSignIn(); await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(authAttempts()).toEqual(['gho_revoked', 'gho_new']);
    expect(useStore.getState().status).toBe('connected');
    wsClient.disconnect();
  });

  it('a new token from the built-in Kraki is used without waiting for the app\'s sign-in', async () => {
    const token = { current: 'gho_revoked' };
    installDesktop(token);
    const { client } = await boot();
    const { desktopCredentials } = await import('./desktop');
    client.connect();
    await vi.advanceTimersByTimeAsync(10);
    expect(desktopCredentials()).toBeNull();
    expect(client.connectWithDesktopCredentials()).toBe(false);

    token.current = 'gho_other';
    accepted.add('gho_other');
    expect(desktopCredentials()).toEqual({ relay: RELAY, token: 'gho_other' });
    expect(client.connectWithDesktopCredentials()).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(authAttempts()).toEqual(['gho_revoked', 'gho_other']);
    client.disconnect();
  });

  it('a passing outage still retries with the same token', async () => {
    const token = { current: 'gho_ok' };
    installDesktop(token);
    globalThis.WebSocket = class extends OriginalWebSocket {
      constructor(url: string) {
        super(url);
        const ws = this as unknown as MockSocket;
        sockets.push(ws);
        const send = ws.send.bind(ws);
        ws.send = (data: string) => {
          send(data);
          if ((JSON.parse(data) as { type: string }).type !== 'auth') return;
          setTimeout(() => {
            ws._receive({ type: 'auth_error', code: 'service_unavailable', message: 'Authentication service unavailable' });
            ws.close();
          }, 0);
        };
      }
    } as unknown as typeof OriginalWebSocket;
    const { client } = await boot();
    const { desktopCredentials } = await import('./desktop');
    client.connect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(authAttempts().length).toBeGreaterThan(1);
    expect(new Set(authAttempts())).toEqual(new Set(['gho_ok']));
    expect(desktopCredentials()).not.toBeNull();
    client.disconnect();
  });
});
