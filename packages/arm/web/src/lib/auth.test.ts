import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the browser globals + store adapter processAuthError touches.
const localStorageMock = (() => {
  let store = new Map<string, string>();
  return {
    getItem: vi.fn((k: string) => store.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => { store.set(k, v); }),
    removeItem: vi.fn((k: string) => { store.delete(k); }),
    clear: () => { store = new Map(); },
    _seed: (k: string, v: string) => store.set(k, v),
  };
})();
vi.stubGlobal('localStorage', localStorageMock);
vi.stubGlobal('window', { location: { reload: vi.fn() } });

// Stub the modules auth.ts imports, BEFORE importing it.
vi.mock('../store-adapter', () => ({
  getStore: vi.fn(() => ({
    githubClientId: undefined,
    setLastError: vi.fn(),
    setReconnectState: vi.fn(),
    setStatus: vi.fn(),
  })),
}));
vi.mock('../oauth', () => ({ supportsOAuthLogin: () => false }));
vi.mock('../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }), setDebugLogging: vi.fn() }));
vi.mock('../transport', () => ({ saveStoredDevice: vi.fn(), STORAGE_KEY: 'kraki_device' }));
vi.mock('../../hooks/useTheme', () => ({ setTheme: vi.fn() }));

import { processAuthError } from './auth';

function deps() {
  return {
    clearStoredDeviceId: vi.fn(),
    setStoredDeviceId: vi.fn(),
    disconnect: vi.fn(),
    connect: vi.fn(),
    redirectToRelay: vi.fn(),
  };
}

describe('processAuthError: credential wipe policy', () => {
  beforeEach(() => { localStorageMock.clear(); });

  it('KEEPS credentials on auth_unavailable (transient backend outage)', () => {
    localStorageMock._seed('kraki_device', JSON.stringify({ relay: 'wss://r', deviceId: 'dev_x' }));
    const d = deps();
    processAuthError({ code: 'auth_unavailable', message: 'Authentication service unavailable' }, 'dev_x', d);
    expect(d.clearStoredDeviceId).not.toHaveBeenCalled();
    expect(localStorageMock.removeItem).not.toHaveBeenCalledWith('kraki_device');
    // It reconnects to retry.
    expect(d.disconnect).toHaveBeenCalled();
    expect(d.connect).toHaveBeenCalled();
  });

  it('KEEPS credentials on service_unavailable (real RemoteAuthBackend timeout code)', () => {
    // RemoteAuthBackend.post() catches fetch failures and returns
    // { ok:false, code:'service_unavailable' }; Head forwards that code. The
    // arm must treat it as transient and keep the paired identity.
    localStorageMock._seed('kraki_device', JSON.stringify({ relay: 'wss://r', deviceId: 'dev_x' }));
    const d = deps();
    processAuthError({ code: 'service_unavailable', message: 'Account service unavailable' }, 'dev_x', d);
    expect(d.clearStoredDeviceId).not.toHaveBeenCalled();
    expect(localStorageMock.removeItem).not.toHaveBeenCalledWith('kraki_device');
    expect(d.connect).toHaveBeenCalled();
  });

  it('KEEPS credentials on a generic auth_rejected (may be transient)', () => {
    localStorageMock._seed('kraki_device', JSON.stringify({ relay: 'wss://r', deviceId: 'dev_x' }));
    const d = deps();
    processAuthError({ code: 'auth_rejected', message: 'x' }, 'dev_x', d);
    expect(d.clearStoredDeviceId).not.toHaveBeenCalled();
    expect(localStorageMock.removeItem).not.toHaveBeenCalledWith('kraki_device');
  });

  it('CLEARS credentials on invalid_signature (deterministic)', () => {
    localStorageMock._seed('kraki_device', JSON.stringify({ relay: 'wss://r', deviceId: 'dev_x' }));
    const d = deps();
    processAuthError({ code: 'invalid_signature', message: 'Invalid signature' }, 'dev_x', d);
    expect(d.clearStoredDeviceId).toHaveBeenCalled();
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('kraki_device');
  });

  it('CLEARS credentials on device_not_found (deterministic)', () => {
    localStorageMock._seed('kraki_device', JSON.stringify({ relay: 'wss://r', deviceId: 'dev_x' }));
    const d = deps();
    processAuthError({ code: 'device_not_found', message: 'Device not found' }, 'dev_x', d);
    expect(d.clearStoredDeviceId).toHaveBeenCalled();
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('kraki_device');
  });

  it('CLEARS credentials on user_not_found (deterministic)', () => {
    localStorageMock._seed('kraki_device', JSON.stringify({ relay: 'wss://r', deviceId: 'dev_x' }));
    const d = deps();
    processAuthError({ code: 'user_not_found', message: 'User not found' }, 'dev_x', d);
    expect(d.clearStoredDeviceId).toHaveBeenCalled();
  });

  it('still redirects to the assigned region on wrong_region', () => {
    localStorageMock._seed('kraki_device', JSON.stringify({ relay: 'wss://cn.relay', deviceId: 'dev_x' }));
    const d = deps();
    processAuthError({ code: 'wrong_region', redirect: 'wss://relay.kraki.chat', deviceId: 'dev_x' }, 'dev_x', d);
    expect(window.location.reload).toHaveBeenCalled();
  });
});

describe('browserDeviceName', () => {
  it('names the browser and the system', async () => {
    const { browserDeviceName } = await import('./auth');
    expect(browserDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toBe('Safari on Mac');
    expect(browserDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0')).toBe('Edge on Windows');
    expect(browserDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1')).toBe('Chrome on iPhone');
    expect(browserDeviceName('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36')).toBe('Chrome on Android');
  });
});

describe('channel preference', () => {
  it('never reloads inside Kraki for Windows, nor when the channel cookie does not stick', async () => {
    const { applyPreferences } = await import('./auth');
    const reload = vi.fn();
    const loc = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...loc, reload } });
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    try {
      // Desktop app: ignored entirely.
      (window as unknown as { krakiDesktop?: unknown }).krakiDesktop = {};
      applyPreferences({ channel: 'beta' });
      expect(reload).not.toHaveBeenCalled();
      delete (window as unknown as { krakiDesktop?: unknown }).krakiDesktop;
      // Cookie that never sticks (custom scheme): no reload loop.
      Object.defineProperty(document, 'cookie', { configurable: true, get: () => '', set: () => {} });
      applyPreferences({ channel: 'beta' });
      expect(reload).not.toHaveBeenCalled();
      // Normal web: switches once.
      let jar = '';
      Object.defineProperty(document, 'cookie', { configurable: true, get: () => jar, set: (v: string) => { jar = v.split(';')[0]; } });
      applyPreferences({ channel: 'beta' });
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: loc });
      delete (document as unknown as { cookie?: string }).cookie;
      Object.defineProperty(Document.prototype, 'cookie', cookie);
    }
  });
});
