import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./store-adapter', () => ({ getStore: () => ({ setLastError: vi.fn(), setReconnectState: vi.fn(), setStatus: vi.fn() }) }));
vi.mock('./oauth', () => ({ supportsOAuthLogin: () => false }));
vi.mock('./logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }), setDebugLogging: vi.fn() }));
vi.mock('./transport', () => ({ saveStoredDevice: vi.fn(), STORAGE_KEY: 'kraki_device' }));
vi.mock('../hooks/useTheme', () => ({ setTheme: vi.fn() }));
import { processAuthError } from './auth';

beforeEach(() => { localStorage.clear(); localStorage.setItem('kraki_device', JSON.stringify({ relay: 'wss://relay.kraki.chat', deviceId: 'r2-web' })); });
function deps() { return { clearStoredDeviceId: vi.fn(), setStoredDeviceId: vi.fn(), disconnect: vi.fn(), connect: vi.fn(), redirectToRelay: vi.fn() }; }

describe('PR577 round3 retryable foreground epoch veto', () => {
  it('service_unavailable preserves paired identity and reconnects without showing a permanent logout', () => {
    const d = deps();
    processAuthError({ code: 'service_unavailable', message: 'Device changed during sign-in, try again' }, 'r2-web', d);
    expect(d.clearStoredDeviceId).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('kraki_device')!).deviceId).toBe('r2-web');
    expect(d.disconnect).toHaveBeenCalledOnce(); expect(d.connect).toHaveBeenCalledOnce();
    expect(d.setStoredDeviceId).not.toHaveBeenCalled();
  });
  it('a first-pairing veto with no stored identity returns to login without replaying a single-use credential', () => {
    localStorage.clear(); const d = deps();
    processAuthError({ code: 'service_unavailable', message: 'Device changed during sign-in, try again' }, undefined, d);
    expect(d.clearStoredDeviceId).not.toHaveBeenCalled(); expect(d.connect).not.toHaveBeenCalled();
    expect(d.setStoredDeviceId).not.toHaveBeenCalled();
  });
});
