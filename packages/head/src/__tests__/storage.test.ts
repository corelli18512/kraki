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
});
