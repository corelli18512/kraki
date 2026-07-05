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
