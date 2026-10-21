import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./store-adapter', () => ({ getStore: () => ({ setLastError: vi.fn(), setReconnectState: vi.fn(), setStatus: vi.fn() }) }));
vi.mock('./oauth', () => ({ supportsOAuthLogin: () => false }));
vi.mock('./logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }), setDebugLogging: vi.fn() }));
vi.mock('./transport', () => ({ saveStoredDevice: vi.fn(), STORAGE_KEY: 'kraki_device' }));
vi.mock('../hooks/useTheme', () => ({ setTheme: vi.fn() }));
import { processAuthError } from './auth';

beforeEach(() => { localStorage.clear(); localStorage.setItem('kraki_device', JSON.stringify({ relay: 'wss://relay.kraki.chat', deviceId: 'r2-web' })); });
function deps() { return { clearStoredDeviceId: vi.fn(), setStoredDeviceId: vi.fn(), disconnect: vi.fn(), connect: vi.fn(), redirectToRelay: vi.fn() }; }

describe('PR577 round2 Web revocation policy', () => {
  it('key_changed is a retry, never a pairing wipe', () => {
    const d = deps(); processAuthError({ code: 'key_changed', message: 'refresh signing key' }, 'r2-web', d);
    expect(d.clearStoredDeviceId).not.toHaveBeenCalled();
    expect(localStorage.getItem('kraki_device')).not.toBeNull();
    expect(d.disconnect).toHaveBeenCalledOnce(); expect(d.connect).toHaveBeenCalledOnce();
  });
  it('unknown_device clears a removed identity and does not silently recreate it', () => {
    const d = deps(); processAuthError({ code: 'unknown_device', message: 'removed' }, 'r2-web', d);
    expect(d.clearStoredDeviceId).toHaveBeenCalledOnce();
    expect(localStorage.getItem('kraki_device')).toBeNull();
    // Reopen the login-screen transport only AFTER clearing the identity.
    expect(d.clearStoredDeviceId.mock.invocationCallOrder[0]).toBeLessThan(d.connect.mock.invocationCallOrder[0]);
    expect(d.setStoredDeviceId).not.toHaveBeenCalled();
  });
});
