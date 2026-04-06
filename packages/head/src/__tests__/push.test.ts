import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Storage } from '../storage.js';
import { PushManager } from '../push/index.js';
import type { PushProvider, PushPayload, PushResult } from '../push/index.js';

class MockPushProvider implements PushProvider {
  readonly name: string;
  sent: Array<{ token: string; payload: PushPayload; opts?: Record<string, unknown> }> = [];
  nextResult: PushResult = { success: true };

  constructor(name = 'apns') {
    this.name = name;
  }

  async send(token: string, payload: PushPayload, opts?: Record<string, unknown>): Promise<PushResult> {
    this.sent.push({ token, payload, opts });
    return this.nextResult;
  }
}

describe('PushManager', () => {
  let storage: Storage;
  let provider: MockPushProvider;
  let manager: PushManager;

  beforeEach(() => {
    storage = new Storage(':memory:');
    storage.upsertUser('u1', 'alice');
    storage.upsertDevice('dev-phone', 'u1', 'Phone', 'app', 'ios');
    storage.upsertDevice('dev-laptop', 'u1', 'Laptop', 'tentacle', 'desktop');
    storage.upsertDevice('dev-tablet', 'u1', 'Tablet', 'app', 'ios');

    provider = new MockPushProvider('apns');
    manager = new PushManager(storage, [provider]);
  });

  afterEach(() => {
    storage.close();
  });

  it('sends push to offline devices with tokens', async () => {
    storage.upsertPushToken('dev-phone', 'apns', 'phone_tok', 'production', 'com.kraki');
    storage.upsertPushToken('dev-tablet', 'apns', 'tablet_tok', 'production', 'com.kraki');

    const pushPreview = {
      blob: 'encrypted_preview_blob',
      keys: {
        'dev-phone': 'wrapped_key_phone',
        'dev-tablet': 'wrapped_key_tablet',
      },
    };

    // dev-laptop is online (sender), phone and tablet are offline
    await manager.sendToOfflineDevices('u1', ['dev-laptop'], pushPreview);

    expect(provider.sent).toHaveLength(2);
    expect(provider.sent[0].token).toBe('phone_tok');
    expect(provider.sent[0].payload.blob).toBe('encrypted_preview_blob');
    expect(provider.sent[0].payload.key).toBe('wrapped_key_phone');
    expect(provider.sent[1].token).toBe('tablet_tok');
    expect(provider.sent[1].payload.key).toBe('wrapped_key_tablet');
  });

  it('does not send push to online devices', async () => {
    storage.upsertPushToken('dev-phone', 'apns', 'phone_tok');

    const pushPreview = {
      blob: 'blob',
      keys: { 'dev-phone': 'key' },
    };

    // dev-phone is online
    await manager.sendToOfflineDevices('u1', ['dev-laptop', 'dev-phone'], pushPreview);

    expect(provider.sent).toHaveLength(0);
  });

  it('skips devices without matching key in pushPreview', async () => {
    storage.upsertPushToken('dev-phone', 'apns', 'phone_tok');
    storage.upsertPushToken('dev-tablet', 'apns', 'tablet_tok');

    const pushPreview = {
      blob: 'blob',
      keys: { 'dev-phone': 'key_phone' }, // no key for dev-tablet
    };

    await manager.sendToOfflineDevices('u1', ['dev-laptop'], pushPreview);

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].token).toBe('phone_tok');
  });

  it('deletes token when provider returns gone', async () => {
    storage.upsertPushToken('dev-phone', 'apns', 'stale_tok');
    provider.nextResult = { success: false, gone: true, error: 'Token no longer valid' };

    const pushPreview = {
      blob: 'blob',
      keys: { 'dev-phone': 'key' },
    };

    await manager.sendToOfflineDevices('u1', ['dev-laptop'], pushPreview);

    expect(provider.sent).toHaveLength(1);
    // Token should be deleted from storage
    const remaining = storage.getPushTokensForOfflineDevices('u1', []);
    expect(remaining).toHaveLength(0);
  });

  it('skips unknown provider types gracefully', async () => {
    storage.upsertPushToken('dev-phone', 'web_push', 'vapid_tok');

    const pushPreview = {
      blob: 'blob',
      keys: { 'dev-phone': 'key' },
    };

    // manager only has 'apns' provider, not 'web_push'
    await manager.sendToOfflineDevices('u1', ['dev-laptop'], pushPreview);

    expect(provider.sent).toHaveLength(0);
  });

  it('does nothing when no tokens exist', async () => {
    const pushPreview = {
      blob: 'blob',
      keys: { 'dev-phone': 'key' },
    };

    await manager.sendToOfflineDevices('u1', ['dev-laptop'], pushPreview);

    expect(provider.sent).toHaveLength(0);
  });

  it('passes environment and bundleId to provider', async () => {
    storage.upsertPushToken('dev-phone', 'apns', 'tok', 'sandbox', 'com.kraki.dev');

    const pushPreview = {
      blob: 'blob',
      keys: { 'dev-phone': 'key' },
    };

    await manager.sendToOfflineDevices('u1', ['dev-laptop'], pushPreview);

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].opts).toEqual({ environment: 'sandbox', bundleId: 'com.kraki.dev' });
  });
});
