import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';
import { Storage } from '../storage.js';
import { PushManager } from '../push/index.js';
import { WebPushProvider, isAllowedWebPushEndpoint } from '../push/web-push.js';
import { handleRegisterPushToken } from '../server/account-control.js';
import type { HeadServer } from '../server.js';
import type { ClientState } from '../server/shared.js';
import type { WebSocket } from 'ws';

const subscription = (endpoint: string) => JSON.stringify({ endpoint, expirationTime: null, keys: { p256dh: 'BPk', auth: 'aa' } });

describe('Web Push endpoint allowlist', () => {
  it('accepts the endpoints browsers actually produce', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc:APA91b',
      'https://fcm.googleapis.com/wp/abc',
      'https://android.googleapis.com/gcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAA',
      'https://web.push.apple.com/QGuQ',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
      'https://FCM.googleapis.com:443/fcm/send/abc',
    ]) expect(isAllowedWebPushEndpoint(endpoint), endpoint).toBe(true);
  });

  it('refuses private, non-https and unknown endpoints', () => {
    for (const endpoint of [
      'https://10.0.0.5:8443/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://localhost/x',
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://user:pw@fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilnotify.windows.com/x',
      'https://example.com/x',
      'not a url',
      42,
    ]) expect(isAllowedWebPushEndpoint(endpoint), String(endpoint)).toBe(false);
  });
});

describe('register_push_token validates Web Push subscriptions', () => {
  let storage: Storage;
  let server: HeadServer;
  let sendError: ReturnType<typeof vi.fn>;
  const state = { userId: 'u1', deviceId: 'dev-web', authenticated: true } as ClientState;
  const ws = {} as WebSocket;

  beforeEach(() => {
    storage = new Storage(':memory:');
    storage.upsertUser('u1', 'alice');
    storage.upsertDevice('dev-web', 'u1', 'Browser', 'app', 'web');
    sendError = vi.fn();
    server = { storage, connections: new Map(), sendError, sendControlToDevice: vi.fn() } as unknown as HeadServer;
  });
  afterEach(() => storage.close());

  const register = (provider: string, token: string) =>
    handleRegisterPushToken(server, ws, state, { type: 'register_push_token', payload: { provider, token } });

  it('stores a subscription on a known push service', () => {
    register('web_push', subscription('https://fcm.googleapis.com/fcm/send/abc'));
    expect(sendError).not.toHaveBeenCalled();
    expect(storage.getPushTokensForOfflineDevices('u1', [])).toHaveLength(1);
  });

  it('refuses a subscription pointing anywhere else, and one that is not JSON', () => {
    register('web_push', subscription('https://10.0.0.5:8443/x'));
    register('web_push', 'not json');
    expect(sendError).toHaveBeenCalledTimes(2);
    expect(storage.getPushTokensForOfflineDevices('u1', [])).toHaveLength(0);
  });

  it('leaves native token providers untouched', () => {
    register('apns', 'a1b2c3d4e5f6');
    expect(sendError).not.toHaveBeenCalled();
    expect(storage.getPushTokensForOfflineDevices('u1', []).map((t) => t.provider)).toEqual(['apns']);
  });
});

describe('WebPushProvider at send time', () => {
  it('drops a stored subscription whose endpoint is not a push service, without sending', async () => {
    const storage = new Storage(':memory:');
    storage.upsertUser('u1', 'alice');
    storage.upsertDevice('dev-web', 'u1', 'Browser', 'app', 'web');
    // A row registered before the endpoint was checked.
    storage.upsertPushToken('dev-web', 'web_push', subscription('https://10.0.0.5:8443/x'));
    const keys = webpush.generateVAPIDKeys();
    const send = vi.spyOn(webpush, 'sendNotification');
    const provider = new WebPushProvider({ vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, vapidEmail: 'mailto:test@example.com' });
    const manager = new PushManager(storage, [provider]);

    await manager.sendToOfflineDevices('u1', [], { blob: 'blob', keys: { 'dev-web': 'key' } });

    expect(send).not.toHaveBeenCalled();
    expect(storage.getPushTokensForOfflineDevices('u1', [])).toHaveLength(0);
    send.mockRestore();
    storage.close();
  });
});
