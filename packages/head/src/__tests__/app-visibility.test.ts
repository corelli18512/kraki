import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Storage } from '../storage.js';
import { firePushPreview, handleControlMessage } from '../server/account-control.js';
import type { ClientState } from '../server/shared.js';
import type { HeadServer } from '../server.js';

function clientState(deviceId: string): ClientState {
  return { deviceId, userId: 'u1', authenticated: true, isAlive: true, pongOverdueAt: null, pendingLivenessBroadcast: false };
}

describe('app_visibility', () => {
  let storage: Storage;
  let server: HeadServer;
  let phoneState: ClientState;
  let sendToOfflineDevices: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    storage = new Storage(':memory:');
    storage.upsertUser('u1', 'alice');
    storage.upsertDevice('dev-phone', 'u1', 'Phone', 'app', 'ios');
    storage.upsertDevice('dev-mac', 'u1', 'Mac', 'tentacle', 'desktop');
    phoneState = clientState('dev-phone');
    const phoneWs = { readyState: 1 } as never;
    const macWs = { readyState: 1 } as never;
    sendToOfflineDevices = vi.fn(async () => {});
    server = {
      storage,
      connections: new Map([['dev-phone', phoneWs], ['dev-mac', macWs]]),
      clients: new Map([[phoneWs, phoneState], [macWs, clientState('dev-mac')]]),
      options: { pushManager: { sendToOfflineDevices } },
      sendControlToDevice: vi.fn(),
      sendError: vi.fn(),
    } as unknown as HeadServer;
  });

  afterEach(() => storage.close());

  const preview = { blob: 'b', keys: { 'dev-phone': 'k' } };

  it('treats a visible connected app as online (no push)', () => {
    firePushPreview(server, clientState('dev-mac'), preview);
    expect(sendToOfflineDevices).toHaveBeenCalledWith('u1', ['dev-mac', 'dev-phone'], preview);
  });

  it('pushes to a hidden app whose socket is still open', () => {
    expect(handleControlMessage(server, {} as never, phoneState, { type: 'app_visibility', visible: false })).toBe(true);
    expect(phoneState.hidden).toBe(true);
    firePushPreview(server, clientState('dev-mac'), preview);
    expect(sendToOfflineDevices).toHaveBeenCalledWith('u1', ['dev-mac'], preview);

    handleControlMessage(server, {} as never, phoneState, { type: 'app_visibility', visible: true });
    expect(phoneState.hidden).toBe(false);
  });
});
