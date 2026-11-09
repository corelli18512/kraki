import { beforeEach, describe, expect, it, vi } from 'vitest';

const ws = vi.hoisted(() => ({ disconnect: vi.fn(), unregisterPushToken: vi.fn(), forgetDeviceKeys: vi.fn() }));
const push = vi.hoisted(() => ({ isPushSupported: vi.fn(() => true), unsubscribeFromPush: vi.fn(async () => true) }));
vi.mock('../../lib/ws-client', () => ({ wsClient: ws }));
vi.mock('../../lib/push', () => push);
vi.mock('../../lib/message-db', () => ({ clearAllMessages: vi.fn(async () => {}) }));

import { signOut } from './ProfileBar';
import { useStore } from '../../hooks/useStore';
import { STORAGE_KEY } from '../../lib/transport';

// K-006: after Sign Out the browser stops receiving and decrypting the old
// account's pushes.
describe('signOut (web browser)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ relay: 'wss://relay.kraki.chat', deviceId: 'dev_1' }));
    useStore.getState().setStatus('connected');
  });

  it('unregisters and unsubscribes push and forgets the device keys', () => {
    signOut();
    expect(ws.unregisterPushToken).toHaveBeenCalledWith({ provider: 'web_push' }, { connectionScoped: true });
    expect(ws.unregisterPushToken.mock.invocationCallOrder[0]).toBeLessThan(ws.disconnect.mock.invocationCallOrder[0]);
    expect(push.unsubscribeFromPush).toHaveBeenCalled();
    expect(ws.forgetDeviceKeys).toHaveBeenCalledWith();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(useStore.getState().status).toBe('awaiting_login');
  });
});
