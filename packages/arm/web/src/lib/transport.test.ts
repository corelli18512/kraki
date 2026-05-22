import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KrakiTransport,
  OAUTH_STATE_KEY,
  OAUTH_VERIFIER_KEY,
  OAUTH_REDIRECT_KEY,
  OAUTH_CALLBACK_PATH,
  consumeOAuthState,
  consumePkceMaterial,
  storeOAuthState,
} from './transport';
import { useStore } from '../hooks/useStore';

const callbacks = {
  onOpen: vi.fn(async () => {}),
  onParsedMessage: vi.fn(),
};

describe('transport oauth state handling', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useStore.getState().reset();
    window.history.replaceState({}, '', '/');
    vi.clearAllMocks();
  });

  it('stores oauth state in both sessionStorage and localStorage', () => {
    storeOAuthState('state-123');

    expect(sessionStorage.getItem(OAUTH_STATE_KEY)).toBe('state-123');
    expect(localStorage.getItem(OAUTH_STATE_KEY)).toBe('state-123');
  });

  it('accepts a callback state from localStorage when sessionStorage is missing', () => {
    localStorage.setItem(OAUTH_STATE_KEY, 'state-123');

    expect(consumeOAuthState('state-123')).toBe(true);
    expect(sessionStorage.getItem(OAUTH_STATE_KEY)).toBeNull();
    expect(localStorage.getItem(OAUTH_STATE_KEY)).toBeNull();
  });

  it('loads githubCode from a callback verified by localStorage fallback', () => {
    localStorage.setItem(OAUTH_STATE_KEY, 'state-123');
    window.history.replaceState({}, '', '/?code=gh-code&state=state-123');

    const transport = new KrakiTransport(callbacks);

    expect(transport.githubCode).toBe('gh-code');
    expect(useStore.getState().lastError).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('surfaces a user-visible error when callback state verification fails', () => {
    storeOAuthState('expected-state');
    window.history.replaceState({}, '', '/?code=gh-code&state=wrong-state');

    const transport = new KrakiTransport(callbacks);

    expect(transport.githubCode).toBeUndefined();
    expect(useStore.getState().lastError).toBe('GitHub sign-in could not be verified. Please try again.');
    expect(sessionStorage.getItem(OAUTH_STATE_KEY)).toBeNull();
    expect(localStorage.getItem(OAUTH_STATE_KEY)).toBeNull();
  });

  it('wipes PKCE material even when state verification fails', () => {
    // Hygiene: a callback with a bad state shouldn't be able to leave
    // a stale verifier in storage. Belt-and-suspenders against an
    // attacker who manages to deliver a malformed callback.
    storeOAuthState('expected-state');
    sessionStorage.setItem(OAUTH_VERIFIER_KEY, 'leaked-verifier');
    sessionStorage.setItem(OAUTH_REDIRECT_KEY, 'https://app.example.com/auth/callback');
    localStorage.setItem(OAUTH_VERIFIER_KEY, 'leaked-verifier');
    localStorage.setItem(OAUTH_REDIRECT_KEY, 'https://app.example.com/auth/callback');
    window.history.replaceState({}, '', '/?code=gh-code&state=wrong-state');

    new KrakiTransport(callbacks);

    expect(sessionStorage.getItem(OAUTH_VERIFIER_KEY)).toBeNull();
    expect(localStorage.getItem(OAUTH_VERIFIER_KEY)).toBeNull();
    expect(sessionStorage.getItem(OAUTH_REDIRECT_KEY)).toBeNull();
    expect(localStorage.getItem(OAUTH_REDIRECT_KEY)).toBeNull();
  });

  it('captures the PKCE verifier + redirect_uri alongside the code', () => {
    storeOAuthState('state-123');
    sessionStorage.setItem(OAUTH_VERIFIER_KEY, 'v-abc');
    sessionStorage.setItem(OAUTH_REDIRECT_KEY, 'https://app.example.com/auth/callback');
    window.history.replaceState({}, '', '/auth/callback?code=gh-code&state=state-123');

    const transport = new KrakiTransport(callbacks);

    expect(transport.githubCode).toBe('gh-code');
    expect(transport.codeVerifier).toBe('v-abc');
    expect(transport.redirectUri).toBe('https://app.example.com/auth/callback');
    // After consuming, PKCE storage is wiped so a stale code can't be replayed.
    expect(sessionStorage.getItem(OAUTH_VERIFIER_KEY)).toBeNull();
    expect(localStorage.getItem(OAUTH_VERIFIER_KEY)).toBeNull();
  });

  it('redirects /auth/callback back to / after consuming the code', () => {
    storeOAuthState('state-123');
    window.history.replaceState({}, '', '/auth/callback?code=gh-code&state=state-123');

    new KrakiTransport(callbacks);

    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
  });

  it('still accepts the OAuth code on / for back-compat with older deploys', () => {
    storeOAuthState('state-123');
    window.history.replaceState({}, '', '/?code=gh-code&state=state-123');

    const transport = new KrakiTransport(callbacks);

    expect(transport.githubCode).toBe('gh-code');
    expect(window.location.pathname).toBe('/');
  });

  it('consumePkceMaterial returns and wipes both storages', () => {
    sessionStorage.setItem(OAUTH_VERIFIER_KEY, 'v-from-session');
    localStorage.setItem(OAUTH_REDIRECT_KEY, 'https://app.example.com/auth/callback');

    const popped = consumePkceMaterial();

    expect(popped.codeVerifier).toBe('v-from-session');
    expect(popped.redirectUri).toBe('https://app.example.com/auth/callback');
    expect(sessionStorage.getItem(OAUTH_VERIFIER_KEY)).toBeNull();
    expect(localStorage.getItem(OAUTH_VERIFIER_KEY)).toBeNull();
    expect(sessionStorage.getItem(OAUTH_REDIRECT_KEY)).toBeNull();
    expect(localStorage.getItem(OAUTH_REDIRECT_KEY)).toBeNull();
  });

  it('exports the dedicated /auth/callback path used by the AASA file', () => {
    // Sanity check — the path must stay in lockstep with the AASA
    // file hosted on the web domain. If you change one, change the
    // other.
    expect(OAUTH_CALLBACK_PATH).toBe('/auth/callback');
  });
});

// ── Delivery assurance: ack piggyback + dedup ──────────────

interface MockWs extends WebSocket {
  sentMessages: string[];
  _receive: (data: unknown) => void;
}

async function nextTick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('transport delivery assurance', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useStore.getState().reset();
    window.history.replaceState({}, '', '/');
    vi.clearAllMocks();
  });

  async function setupConnectedTransport() {
    localStorage.setItem('kraki_device', JSON.stringify({ relay: 'ws://localhost:9999', deviceId: 'dev_test' }));
    const onParsedMessage = vi.fn();
    const transport = new KrakiTransport({
      onOpen: async () => {},
      onParsedMessage,
    });
    transport.connect();
    await nextTick();
    transport.setAuthenticated(true);
    const ws = (transport as unknown as { ws: MockWs }).ws;
    return { transport, ws, onParsedMessage };
  }

  it('injects ack on outbound send after receiving a relaySeq', async () => {
    const { transport, ws } = await setupConnectedTransport();

    ws._receive({ type: 'broadcast', blob: 'x', keys: {}, relaySeq: 7 });
    await nextTick();

    transport.send({ type: 'unicast', to: 'dev-t', blob: 'y', keys: {} });

    // After the initial auth message, the second sent message is the unicast.
    const sentUnicast = ws.sentMessages.map((s) => JSON.parse(s)).find((m) => m.type === 'unicast');
    expect(sentUnicast).toBeDefined();
    expect(sentUnicast.ack).toBe(7);
  });

  it('does not inject ack when nothing has been received yet', async () => {
    const { transport, ws } = await setupConnectedTransport();

    transport.send({ type: 'unicast', to: 'dev-t', blob: 'y', keys: {} });

    const sentUnicast = ws.sentMessages.map((s) => JSON.parse(s)).find((m) => m.type === 'unicast');
    expect(sentUnicast).toBeDefined();
    expect(sentUnicast.ack).toBeUndefined();
  });

  it('tracks highest relaySeq across multiple inbound messages', async () => {
    const { transport, ws } = await setupConnectedTransport();

    ws._receive({ type: 'broadcast', blob: 'a', keys: {}, relaySeq: 3 });
    ws._receive({ type: 'broadcast', blob: 'b', keys: {}, relaySeq: 5 });
    ws._receive({ type: 'broadcast', blob: 'c', keys: {}, relaySeq: 4 }); // out of order
    await nextTick();

    transport.send({ type: 'ping' });

    const sentPing = ws.sentMessages.map((s) => JSON.parse(s)).find((m) => m.type === 'ping');
    expect(sentPing).toBeDefined();
    expect(sentPing.ack).toBe(5);
  });

  it('dedups duplicate inbound relaySeqs — handler not called twice', async () => {
    const { ws, onParsedMessage } = await setupConnectedTransport();

    ws._receive({ type: 'broadcast', blob: 'x', keys: {}, relaySeq: 1 });
    ws._receive({ type: 'broadcast', blob: 'x', keys: {}, relaySeq: 1 }); // duplicate retry
    await nextTick();

    const broadcastCalls = onParsedMessage.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type: string }).type === 'broadcast',
    );
    expect(broadcastCalls.length).toBe(1);
  });

  it('forwards messages without relaySeq normally (old relay compat)', async () => {
    const { ws, onParsedMessage } = await setupConnectedTransport();

    ws._receive({ type: 'broadcast', blob: 'x', keys: {} });
    ws._receive({ type: 'broadcast', blob: 'y', keys: {} });
    await nextTick();

    const broadcastCalls = onParsedMessage.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type: string }).type === 'broadcast',
    );
    expect(broadcastCalls.length).toBe(2);
  });

  it('resets ack tracking on disconnect (fresh state for new connection)', async () => {
    const { transport, ws } = await setupConnectedTransport();

    ws._receive({ type: 'broadcast', blob: 'x', keys: {}, relaySeq: 99 });
    await nextTick();

    transport.disconnect();
    await nextTick();

    transport.connect();
    await nextTick();
    transport.setAuthenticated(true);
    const ws2 = (transport as unknown as { ws: MockWs }).ws;

    transport.send({ type: 'ping' });

    const sentPing = ws2.sentMessages.map((s) => JSON.parse(s)).find((m) => m.type === 'ping');
    expect(sentPing).toBeDefined();
    expect(sentPing.ack).toBeUndefined(); // reset to 0, no ack
  });
});
