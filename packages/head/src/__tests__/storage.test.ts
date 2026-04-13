import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Storage } from '../storage.js';

describe('Storage', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = new Storage(':memory:');
  });

  afterEach(() => {
    storage.close();
  });

  // --- Users ---

  describe('users', () => {
    it('should create and retrieve a user', () => {
      const user = storage.upsertUser('123', 'corelli');
      expect(user.userId).toBe('123');
      expect(user.username).toBe('corelli');
      expect(user.provider).toBe('open');
      expect(user.createdAt).toBeTruthy();
    });

    it('should create a user with provider and email', () => {
      const user = storage.upsertUser('456', 'alice', 'github', 'alice@example.com');
      expect(user.provider).toBe('github');
      expect(user.email).toBe('alice@example.com');
    });

    it('should update username on upsert', () => {
      storage.upsertUser('123', 'old_name');
      const user = storage.upsertUser('123', 'new_name');
      expect(user.username).toBe('new_name');
    });

    it('should update provider and email on upsert', () => {
      storage.upsertUser('123', 'corelli', 'open');
      const user = storage.upsertUser('123', 'corelli', 'github', 'corelli@example.com');
      expect(user.provider).toBe('github');
      expect(user.email).toBe('corelli@example.com');
    });

    it('should return undefined for non-existent user', () => {
      expect(storage.getUser('nonexistent')).toBeUndefined();
    });
  });

  // --- Devices ---

  describe('devices', () => {
    beforeEach(() => {
      storage.upsertUser('user1', 'testuser');
    });

    it('should create and retrieve a device', () => {
      const dev = storage.upsertDevice('dev_1', 'user1', 'Laptop', 'tentacle', 'desktop');
      expect(dev.id).toBe('dev_1');
      expect(dev.userId).toBe('user1');
      expect(dev.name).toBe('Laptop');
      expect(dev.role).toBe('tentacle');
      expect(dev.kind).toBe('desktop');
    });

    it('should update device on upsert', () => {
      storage.upsertDevice('dev_1', 'user1', 'Old Name', 'tentacle');
      const dev = storage.upsertDevice('dev_1', 'user1', 'New Name', 'app', 'web');
      expect(dev.name).toBe('New Name');
      expect(dev.role).toBe('app');
      expect(dev.kind).toBe('web');
    });

    it('should store public key', () => {
      const dev = storage.upsertDevice('dev_1', 'user1', 'Phone', 'app', 'ios', 'MIIBIjAN...');
      expect(dev.publicKey).toBe('MIIBIjAN...');
    });

    it('should store encryption key', () => {
      const dev = storage.upsertDevice('dev_1', 'user1', 'Phone', 'app', 'ios', 'pub_key', 'enc_key');
      expect(dev.encryptionKey).toBe('enc_key');
    });

    it('should list devices by user', () => {
      storage.upsertDevice('dev_1', 'user1', 'Laptop', 'tentacle');
      storage.upsertDevice('dev_2', 'user1', 'Phone', 'app');
      const devices = storage.getDevicesByUser('user1');
      expect(devices).toHaveLength(2);
      expect(devices.map(d => d.name).sort()).toEqual(['Laptop', 'Phone']);
    });

    it('should return empty array for user with no devices', () => {
      expect(storage.getDevicesByUser('user1')).toHaveLength(0);
    });

    it('should return undefined for non-existent device', () => {
      expect(storage.getDevice('nonexistent')).toBeUndefined();
    });

    it('should reject device for non-existent user (foreign key)', () => {
      expect(() => {
        storage.upsertDevice('dev_1', 'nonexistent_user', 'Laptop', 'tentacle');
      }).toThrow();
    });

    it('should reject device belonging to a different user', () => {
      storage.upsertUser('user2', 'otheruser');
      storage.upsertDevice('dev_1', 'user1', 'Laptop', 'tentacle');
      expect(() => {
        storage.upsertDevice('dev_1', 'user2', 'Laptop', 'tentacle');
      }).toThrow(/belongs to user/);
    });

    it('should not mix devices between users', () => {
      storage.upsertUser('user2', 'otheruser');
      storage.upsertDevice('dev_1', 'user1', 'Laptop', 'tentacle');
      storage.upsertDevice('dev_2', 'user2', 'Desktop', 'tentacle');

      const user1Devices = storage.getDevicesByUser('user1');
      const user2Devices = storage.getDevicesByUser('user2');
      expect(user1Devices).toHaveLength(1);
      expect(user1Devices[0].name).toBe('Laptop');
      expect(user2Devices).toHaveLength(1);
      expect(user2Devices[0].name).toBe('Desktop');
    });
  });

  // --- Pending messages ---

  describe('pending messages', () => {
    beforeEach(() => {
      storage.upsertUser('u1', 'alice');
      storage.upsertDevice('dev-1', 'u1', 'Laptop', 'tentacle');
    });

    it('inserts and flushes pending messages', () => {
      storage.insertPending('dev-1', 'u1', '{"type":"unicast","to":"dev-1","blob":"a"}');
      storage.insertPending('dev-1', 'u1', '{"type":"unicast","to":"dev-1","blob":"b"}');

      const flushed = storage.flushPending('dev-1');
      expect(flushed).toHaveLength(2);
      expect(JSON.parse(flushed[0]).blob).toBe('a');
      expect(JSON.parse(flushed[1]).blob).toBe('b');

      // Second flush returns empty
      expect(storage.flushPending('dev-1')).toHaveLength(0);
    });

    it('does not return messages for other devices', () => {
      storage.upsertDevice('dev-2', 'u1', 'Desktop', 'tentacle');
      storage.insertPending('dev-1', 'u1', '{"blob":"for-dev1"}');
      storage.insertPending('dev-2', 'u1', '{"blob":"for-dev2"}');

      const flushed = storage.flushPending('dev-1');
      expect(flushed).toHaveLength(1);
      expect(JSON.parse(flushed[0]).blob).toBe('for-dev1');
    });

    it('enforces per-device cap by dropping oldest', () => {
      for (let i = 0; i < 205; i++) {
        storage.insertPending('dev-1', 'u1', `{"i":${i}}`);
      }

      const flushed = storage.flushPending('dev-1');
      expect(flushed).toHaveLength(200);
      // Oldest 5 were dropped
      expect(JSON.parse(flushed[0]).i).toBe(5);
      expect(JSON.parse(flushed[199]).i).toBe(204);
    });

    it('deletes pending messages when device is removed', () => {
      storage.insertPending('dev-1', 'u1', '{"blob":"queued"}');
      storage.deletePendingForDevice('dev-1');

      expect(storage.flushPending('dev-1')).toHaveLength(0);
    });

    it('expires old messages', () => {
      storage.insertPending('dev-1', 'u1', '{"blob":"old"}');
      // Manually backdate the entry
      // @ts-expect-error — accessing private db for test
      storage['db'].prepare(
        "UPDATE pending_messages SET created_at = datetime('now', '-31 days')"
      ).run();

      const expired = storage.expirePending();
      expect(expired).toBe(1);
      expect(storage.flushPending('dev-1')).toHaveLength(0);
    });
  });

  // --- Push tokens ---

  describe('push tokens', () => {
    beforeEach(() => {
      storage.upsertUser('u1', 'alice');
      storage.upsertDevice('dev-1', 'u1', 'Phone', 'app', 'ios');
      storage.upsertDevice('dev-2', 'u1', 'Laptop', 'tentacle', 'desktop');
    });

    it('upserts and retrieves a push token', () => {
      storage.upsertPushToken('dev-1', 'apns', 'token_abc', 'production', 'com.kraki');
      const tokens = storage.getPushTokensForOfflineDevices('u1', []);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].deviceId).toBe('dev-1');
      expect(tokens[0].provider).toBe('apns');
      expect(tokens[0].token).toBe('token_abc');
      expect(tokens[0].environment).toBe('production');
      expect(tokens[0].bundleId).toBe('com.kraki');
    });

    it('upsert replaces existing token for same device+provider', () => {
      storage.upsertPushToken('dev-1', 'apns', 'old_token');
      storage.upsertPushToken('dev-1', 'apns', 'new_token');
      const tokens = storage.getPushTokensForOfflineDevices('u1', []);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].token).toBe('new_token');
    });

    it('supports multiple providers per device', () => {
      storage.upsertPushToken('dev-1', 'apns', 'apns_token');
      storage.upsertPushToken('dev-1', 'fcm', 'fcm_token');
      const tokens = storage.getPushTokensForOfflineDevices('u1', []);
      expect(tokens).toHaveLength(2);
      expect(tokens.map(t => t.provider).sort()).toEqual(['apns', 'fcm']);
    });

    it('deletes a push token by device+provider', () => {
      storage.upsertPushToken('dev-1', 'apns', 'token_abc');
      expect(storage.deletePushToken('dev-1', 'apns')).toBe(true);
      expect(storage.getPushTokensForOfflineDevices('u1', [])).toHaveLength(0);
    });

    it('returns false when deleting non-existent token', () => {
      expect(storage.deletePushToken('dev-1', 'apns')).toBe(false);
    });

    it('deletes all tokens for a device', () => {
      storage.upsertPushToken('dev-1', 'apns', 'token_1');
      storage.upsertPushToken('dev-1', 'fcm', 'token_2');
      storage.deletePushTokensForDevice('dev-1');
      expect(storage.getPushTokensForOfflineDevices('u1', [])).toHaveLength(0);
    });

    it('excludes online devices from offline query', () => {
      storage.upsertPushToken('dev-1', 'apns', 'phone_token');
      storage.upsertPushToken('dev-2', 'apns', 'laptop_token');
      const tokens = storage.getPushTokensForOfflineDevices('u1', ['dev-1']);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].deviceId).toBe('dev-2');
    });

    it('returns all tokens when no devices are online', () => {
      storage.upsertPushToken('dev-1', 'apns', 'phone_token');
      storage.upsertPushToken('dev-2', 'apns', 'laptop_token');
      const tokens = storage.getPushTokensForOfflineDevices('u1', []);
      expect(tokens).toHaveLength(2);
    });

    it('returns empty when all devices are online', () => {
      storage.upsertPushToken('dev-1', 'apns', 'phone_token');
      const tokens = storage.getPushTokensForOfflineDevices('u1', ['dev-1', 'dev-2']);
      expect(tokens).toHaveLength(0);
    });

    it('cascades on device delete', () => {
      storage.upsertPushToken('dev-1', 'apns', 'token_abc');
      storage.deleteDevice('dev-1');
      expect(storage.getPushTokensForOfflineDevices('u1', [])).toHaveLength(0);
    });

    it('does not return tokens for other users', () => {
      storage.upsertUser('u2', 'bob');
      storage.upsertDevice('dev-3', 'u2', 'Bob Phone', 'app', 'ios');
      storage.upsertPushToken('dev-1', 'apns', 'alice_token');
      storage.upsertPushToken('dev-3', 'apns', 'bob_token');

      const aliceTokens = storage.getPushTokensForOfflineDevices('u1', []);
      expect(aliceTokens).toHaveLength(1);
      expect(aliceTokens[0].token).toBe('alice_token');

      const bobTokens = storage.getPushTokensForOfflineDevices('u2', []);
      expect(bobTokens).toHaveLength(1);
      expect(bobTokens[0].token).toBe('bob_token');
    });
  });

  // --- Counts ---

  describe('counts', () => {
    it('should return zero counts for empty database', () => {
      expect(storage.getUserCount()).toBe(0);
      expect(storage.getDeviceCount()).toBe(0);
    });

    it('should count users and devices', () => {
      storage.upsertUser('u1', 'alice');
      storage.upsertUser('u2', 'bob');
      storage.upsertDevice('d1', 'u1', 'laptop', 'tentacle');
      storage.upsertDevice('d2', 'u1', 'phone', 'app');
      storage.upsertDevice('d3', 'u2', 'desktop', 'tentacle');

      expect(storage.getUserCount()).toBe(2);
      expect(storage.getDeviceCount()).toBe(3);
    });
  });
});
