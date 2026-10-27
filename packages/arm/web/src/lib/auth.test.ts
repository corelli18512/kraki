import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
    currentRelay: 'wss://relay.kraki.chat',
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

  it('ignores a wrong_region redirect to an untrusted relay and keeps credentials', () => {
    const stored = JSON.stringify({ relay: 'wss://relay.kraki.chat', deviceId: 'dev_x' });
    localStorageMock._seed('kraki_device', stored);
    vi.mocked(window.location.reload).mockClear();
    const d = deps();
    processAuthError({ code: 'wrong_region', redirect: 'wss://evil.example', deviceId: 'dev_x' }, 'dev_x', d);
    expect(window.location.reload).not.toHaveBeenCalled();
    expect(localStorageMock.getItem('kraki_device')).toBe(stored);
    expect(d.clearStoredDeviceId).not.toHaveBeenCalled();
    expect(d.connect).toHaveBeenCalled();
  });
});

describe('handleAuthChallenge: only Head nonces are signed', () => {
  function keyStore() {
    return { isReady: () => true, init: vi.fn(), signChallenge: vi.fn(async (m: string) => `sig:${m}`) };
  }

  it('signs the nonce every Head issues (32 random bytes, lowercase hex)', async () => {
    const { handleAuthChallenge } = await import('./auth');
    const ks = keyStore();
    const send = vi.fn();
    const nonce = 'a1'.repeat(32);
    await handleAuthChallenge(nonce, ks as never, 'dev_x', send);
    expect(ks.signChallenge).toHaveBeenCalledWith(nonce);
    expect(send).toHaveBeenCalledWith({ type: 'auth_response', deviceId: 'dev_x', signature: `sig:${nonce}` });
  });

  it('refuses local-link, diagnostics and other non-Head strings', async () => {
    const { handleAuthChallenge } = await import('./auth');
    for (const nonce of [
      'kraki-local-link/v1/app\nabc\ndev_t\ndev_x',
      'kraki-diag-v1\nPOST\n/api/diag/v1/batch\ndev_x\n1760000000000\nreq\n' + 'ab'.repeat(32),
      'A1'.repeat(32),
      'a1'.repeat(31),
      `${'a1'.repeat(32)}\n`,
      '',
    ]) {
      const ks = keyStore();
      const send = vi.fn();
      await handleAuthChallenge(nonce, ks as never, 'dev_x', send);
      expect(ks.signChallenge, nonce).not.toHaveBeenCalled();
      expect(send, nonce).not.toHaveBeenCalled();
    }
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

describe('release channel follows the account (internal = dogfood)', () => {
  /** A cookie jar that behaves like a browser for one cookie: max-age=0 deletes. */
  function installJar(initial: string, opts: { sticks?: boolean } = {}) {
    let jar = new Map<string, string>();
    for (const part of initial.split('; ').filter(Boolean)) {
      const [k, v] = part.split('=');
      jar.set(k, v);
    }
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      set: (raw: string) => {
        if (opts.sticks === false) return;
        const [pair, ...attrs] = raw.split(';');
        const [k, v] = pair.split('=');
        if (attrs.some((a) => a.trim() === 'max-age=0')) jar.delete(k);
        else jar = new Map(jar).set(k, v);
      },
    });
    return () => document.cookie;
  }

  const session = new Map<string, string>();
  let reload: ReturnType<typeof vi.fn>;
  const loc = window.location;
  beforeEach(() => {
    session.clear();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => { session.set(k, v); },
      removeItem: (k: string) => { session.delete(k); },
    });
    reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...loc, reload } });
    delete (window as unknown as { krakiDesktop?: unknown }).krakiDesktop;
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: loc });
    delete (document as unknown as { cookie?: string }).cookie;
    delete (window as unknown as { krakiDesktop?: unknown }).krakiDesktop;
  });

  it('maps the account to a channel', async () => {
    const { channelForAccount } = await import('./auth');
    expect(channelForAccount({ internal: true })).toBe('beta');
    expect(channelForAccount({ internal: false })).toBe('stable');
    expect(channelForAccount({ theme: 'dark' })).toBe('stable');
    expect(channelForAccount({ internal: 'true' })).toBe('stable');
    expect(channelForAccount({ internal: 1 })).toBe('stable');
    expect(channelForAccount(undefined)).toBe('stable');
    // The legacy self-chosen `channel` preference no longer counts.
    expect(channelForAccount({ channel: 'beta' })).toBe('stable');
  });

  it('stable account on stable: nothing happens', async () => {
    const { applyAccountChannel } = await import('./auth');
    const jar = installJar('other=1');
    applyAccountChannel({ theme: 'dark' });
    applyAccountChannel(undefined);
    applyAccountChannel({ channel: 'beta' });
    expect(jar()).toBe('other=1');
    expect(reload).not.toHaveBeenCalled();
  });

  it('internal account on stable: moves to dogfood once', async () => {
    const { applyAccountChannel, getCurrentChannel } = await import('./auth');
    const jar = installJar('');
    applyAccountChannel({ internal: true });
    expect(jar()).toBe('kraki_channel=beta');
    expect(getCurrentChannel()).toBe('beta');
    expect(reload).toHaveBeenCalledTimes(1);
    // After the reload the dogfood bundle signs in again: settled, no reload.
    applyAccountChannel({ internal: true });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(session.size).toBe(0);
  });

  it('stable account left on dogfood (revoked, or another account in this browser): back to stable', async () => {
    const { applyAccountChannel, getCurrentChannel } = await import('./auth');
    const jar = installJar('a=1; kraki_channel=beta');
    applyAccountChannel({ theme: 'light' });
    expect(jar()).toBe('a=1');
    expect(getCurrentChannel()).toBe('stable');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a self-set beta cookie does not give a stable account dogfood', async () => {
    const { applyAccountChannel } = await import('./auth');
    const jar = installJar('kraki_channel=beta');
    applyAccountChannel({ internal: false, channel: 'beta' });
    expect(jar()).toBe('');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('internal account already on dogfood: nothing happens', async () => {
    const { applyAccountChannel } = await import('./auth');
    installJar('kraki_channel=beta');
    applyAccountChannel({ internal: true, theme: 'dark' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('Kraki for Windows: never touches the cookie or reloads', async () => {
    const { applyAccountChannel } = await import('./auth');
    (window as unknown as { krakiDesktop?: unknown }).krakiDesktop = {};
    const jar = installJar('');
    applyAccountChannel({ internal: true });
    expect(jar()).toBe('');
    installJar('kraki_channel=beta');
    applyAccountChannel({});
    expect(reload).not.toHaveBeenCalled();
  });

  it('a cookie that does not stick never reloads', async () => {
    const { applyAccountChannel } = await import('./auth');
    installJar('', { sticks: false });
    applyAccountChannel({ internal: true });
    expect(reload).not.toHaveBeenCalled();
  });

  it('a server that ignores the cookie cannot cause a reload loop', async () => {
    const { applyAccountChannel } = await import('./auth');
    installJar('');
    applyAccountChannel({ internal: true });
    expect(reload).toHaveBeenCalledTimes(1);
    // The "reloaded" page was still the stable bundle, which lost the cookie
    // (e.g. cleared by an extension): it must not reload again this session.
    installJar('');
    applyAccountChannel({ internal: true });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('theme updates (preferences_updated) never change the channel', async () => {
    const { applyPreferences } = await import('./auth');
    const jar = installJar('kraki_channel=beta');
    applyPreferences({ theme: 'dark' });
    applyPreferences({ internal: false });
    expect(jar()).toBe('kraki_channel=beta');
    expect(reload).not.toHaveBeenCalled();
  });
});
