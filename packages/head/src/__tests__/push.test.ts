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

describe('Storage.deleteStaleUserPushTokens', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = new Storage(':memory:');
    storage.upsertUser('u1', 'alice');
  });

  afterEach(() => {
    storage.close();
  });

  it('prunes push tokens from offline devices with stale last_seen', () => {
    // Create a stale device (last_seen 48h ago) and a current device
    storage.upsertDevice('dev-old', 'u1', 'Old Phone', 'app', 'web');
    storage.upsertDevice('dev-new', 'u1', 'New Phone', 'app', 'web');

    // Backdate the old device's last_seen
    (storage as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare("UPDATE devices SET last_seen = datetime('now', '-48 hours') WHERE id = ?")
      .run('dev-old');

    storage.upsertPushToken('dev-old', 'web_push', 'old_token');
    storage.upsertPushToken('dev-new', 'web_push', 'new_token');

    // dev-new is registering, no devices are online except dev-new
    const pruned = storage.deleteStaleUserPushTokens('u1', 'dev-new', ['dev-new']);
    expect(pruned).toBe(1);

    // Only new token remains
    const remaining = storage.getPushTokensForOfflineDevices('u1', []);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].deviceId).toBe('dev-new');
  });

  it('does not prune tokens from online devices even if last_seen is old', () => {
    storage.upsertDevice('dev-online', 'u1', 'Online Phone', 'app', 'web');
    storage.upsertDevice('dev-new', 'u1', 'New Phone', 'app', 'web');

    // Backdate the online device
    (storage as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare("UPDATE devices SET last_seen = datetime('now', '-48 hours') WHERE id = ?")
      .run('dev-online');

    storage.upsertPushToken('dev-online', 'web_push', 'online_token');

    // dev-online is in the online set — should be protected
    const pruned = storage.deleteStaleUserPushTokens('u1', 'dev-new', ['dev-new', 'dev-online']);
    expect(pruned).toBe(0);

    const remaining = storage.getPushTokensForOfflineDevices('u1', []);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].deviceId).toBe('dev-online');
  });

  it('does not prune tokens from recently-seen offline devices', () => {
    storage.upsertDevice('dev-recent', 'u1', 'Recent Phone', 'app', 'web');
    storage.upsertDevice('dev-new', 'u1', 'New Phone', 'app', 'web');

    // dev-recent was just created so last_seen is now — within 24h
    storage.upsertPushToken('dev-recent', 'web_push', 'recent_token');

    const pruned = storage.deleteStaleUserPushTokens('u1', 'dev-new', ['dev-new']);
    expect(pruned).toBe(0);

    const remaining = storage.getPushTokensForOfflineDevices('u1', []);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].deviceId).toBe('dev-recent');
  });

  it('does not prune the registering device own token', () => {
    storage.upsertDevice('dev-self', 'u1', 'Self', 'app', 'web');

    // Backdate own device (edge case)
    (storage as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare("UPDATE devices SET last_seen = datetime('now', '-48 hours') WHERE id = ?")
      .run('dev-self');

    storage.upsertPushToken('dev-self', 'web_push', 'self_token');

    const pruned = storage.deleteStaleUserPushTokens('u1', 'dev-self', []);
    expect(pruned).toBe(0);
  });

  it('does not touch tokens from other users', () => {
    storage.upsertUser('u2', 'bob');
    storage.upsertDevice('dev-a', 'u1', 'Alice Phone', 'app', 'web');
    storage.upsertDevice('dev-b', 'u2', 'Bob Phone', 'app', 'web');

    // Backdate both
    (storage as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare("UPDATE devices SET last_seen = datetime('now', '-48 hours') WHERE id IN ('dev-a', 'dev-b')")
      .run();

    storage.upsertPushToken('dev-a', 'web_push', 'alice_tok');
    storage.upsertPushToken('dev-b', 'web_push', 'bob_tok');

    storage.upsertDevice('dev-new', 'u1', 'Alice New', 'app', 'web');
    const pruned = storage.deleteStaleUserPushTokens('u1', 'dev-new', ['dev-new']);
    expect(pruned).toBe(1); // only alice's old token

    // Bob's token untouched
    const bobTokens = storage.getPushTokensForOfflineDevices('u2', []);
    expect(bobTokens).toHaveLength(1);
    expect(bobTokens[0].deviceId).toBe('dev-b');
  });
});

describe('Storage.touchDeviceLastSeen', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = new Storage(':memory:');
    storage.upsertUser('u1', 'alice');
  });

  afterEach(() => {
    storage.close();
  });

  it('updates last_seen to current time', () => {
    storage.upsertDevice('dev-1', 'u1', 'Phone', 'app', 'web');

    // Backdate
    (storage as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare("UPDATE devices SET last_seen = datetime('now', '-7 days') WHERE id = ?")
      .run('dev-1');

    const before = storage.getDevice('dev-1')!;
    storage.touchDeviceLastSeen('dev-1');
    const after = storage.getDevice('dev-1')!;

    expect(new Date(after.lastSeen).getTime()).toBeGreaterThan(new Date(before.lastSeen).getTime());
  });
});
