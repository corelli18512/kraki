import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KrakiTransport, OAUTH_STATE_KEY, consumeOAuthState, storeOAuthState } from './transport';
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
});
