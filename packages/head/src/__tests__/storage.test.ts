import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Storage, shouldStore } from '../storage.js';

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
      expect(user.createdAt).toBeTruthy();
    });

    it('should update username on upsert', () => {
      storage.upsertUser('123', 'old_name');
      const user = storage.upsertUser('123', 'new_name');
      expect(user.username).toBe('new_name');
    });

    it('should return undefined for non-existent user', () => {
      expect(storage.getUser('nonexistent')).toBeUndefined();
    });
  });

  // --- Channels ---

  describe('channels', () => {
    beforeEach(() => {
      storage.upsertUser('user1', 'testuser');
    });

    it('should create and retrieve a channel', () => {
      const ch = storage.createChannel('ch_1', 'user1', 'My Channel');
      expect(ch.id).toBe('ch_1');
      expect(ch.ownerId).toBe('user1');
      expect(ch.name).toBe('My Channel');
    });

    it('should create channel without name', () => {
      const ch = storage.createChannel('ch_2', 'user1');
      expect(ch.name).toBeNull();
    });

    it('should find channel by owner', () => {
      storage.createChannel('ch_1', 'user1');
      const ch = storage.getChannelByOwner('user1');
      expect(ch?.id).toBe('ch_1');
    });

    it('should return undefined for non-existent channel', () => {
      expect(storage.getChannel('nonexistent')).toBeUndefined();
    });
  });

  // --- Devices ---

  describe('devices', () => {
    beforeEach(() => {
      storage.upsertUser('user1', 'testuser');
      storage.createChannel('ch_1', 'user1');
    });

    it('should create and retrieve a device', () => {
      const dev = storage.upsertDevice('dev_1', 'ch_1', 'Laptop', 'tentacle', 'desktop');
      expect(dev.id).toBe('dev_1');
      expect(dev.channelId).toBe('ch_1');
      expect(dev.name).toBe('Laptop');
      expect(dev.role).toBe('tentacle');
      expect(dev.kind).toBe('desktop');
    });

    it('should update device on upsert', () => {
      storage.upsertDevice('dev_1', 'ch_1', 'Old Name', 'tentacle');
      const dev = storage.upsertDevice('dev_1', 'ch_1', 'New Name', 'app', 'web');
      expect(dev.name).toBe('New Name');
      expect(dev.role).toBe('app');
      expect(dev.kind).toBe('web');
    });

    it('should store public key for E2E', () => {
      const dev = storage.upsertDevice('dev_1', 'ch_1', 'Phone', 'app', 'ios', 'MIIBIjAN...');
      expect(dev.publicKey).toBe('MIIBIjAN...');
    });

    it('should list devices by channel', () => {
      storage.upsertDevice('dev_1', 'ch_1', 'Laptop', 'tentacle');
      storage.upsertDevice('dev_2', 'ch_1', 'Phone', 'app');
      const devices = storage.getDevicesByChannel('ch_1');
      expect(devices).toHaveLength(2);
      expect(devices.map(d => d.name).sort()).toEqual(['Laptop', 'Phone']);
    });

    it('should remove a device', () => {
      storage.upsertDevice('dev_1', 'ch_1', 'Laptop', 'tentacle');
      storage.removeDevice('dev_1');
      expect(storage.getDevice('dev_1')).toBeUndefined();
    });

    it('should touch device last_seen', () => {
      storage.upsertDevice('dev_1', 'ch_1', 'Laptop', 'tentacle');
      const before = storage.getDevice('dev_1')!.lastSeen;
      storage.touchDevice('dev_1');
      const after = storage.getDevice('dev_1')!.lastSeen;
      expect(after).toBeTruthy();
      // last_seen should be updated (or same if within same second)
      expect(after >= before).toBe(true);
    });
  });

  // --- Messages ---

  describe('messages', () => {
    beforeEach(() => {
      storage.upsertUser('user1', 'testuser');
      storage.createChannel('ch_1', 'user1');
    });

    it('should store and retrieve a message', () => {
      storage.storeMessage({ channelId: 'ch_1', deviceId: 'dev_1', sessionId: 'sess_1', seq: 1, type: 'agent_message', payload: '{"content":"hello"}' });
      const msgs = storage.getMessagesAfterSeq('ch_1', 0);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].seq).toBe(1);
      expect(msgs[0].type).toBe('agent_message');
      expect(msgs[0].payload).toBe('{"content":"hello"}');
    });

    it('should retrieve messages after a given seq', () => {
      storage.storeMessage({ channelId: 'ch_1', deviceId: 'dev_1', sessionId: 'sess_1', seq: 1, type: 'user_message', payload: '{"content":"a"}' });
      storage.storeMessage({ channelId: 'ch_1', deviceId: 'dev_1', sessionId: 'sess_1', seq: 2, type: 'agent_message', payload: '{"content":"b"}' });
      storage.storeMessage({ channelId: 'ch_1', deviceId: 'dev_1', sessionId: 'sess_1', seq: 3, type: 'agent_message', payload: '{"content":"c"}' });

      const msgs = storage.getMessagesAfterSeq('ch_1', 1);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].seq).toBe(2);
      expect(msgs[1].seq).toBe(3);
    });

    it('should filter messages by session', () => {
      storage.storeMessage({ channelId: 'ch_1', deviceId: 'dev_1', sessionId: 'sess_1', seq: 1, type: 'agent_message', payload: '{"content":"a"}' });
      storage.storeMessage({ channelId: 'ch_1', deviceId: 'dev_2', sessionId: 'sess_2', seq: 2, type: 'agent_message', payload: '{"content":"b"}' });

      const msgs = storage.getMessagesAfterSeq('ch_1', 0, 'sess_1');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].sessionId).toBe('sess_1');
    });

    it('should store messages without sessionId', () => {
      storage.storeMessage({ channelId: 'ch_1', deviceId: 'dev_1', sessionId: null, seq: 1, type: 'error', payload: '{"message":"crash"}' });
      const msgs = storage.getMessagesAfterSeq('ch_1', 0);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].sessionId).toBeNull();
    });

    it('should return correct max seq', () => {
      expect(storage.getMaxSeq('ch_1')).toBe(0);
      storage.storeMessage({ channelId: 'ch_1', deviceId: 'dev_1', sessionId: 'sess_1', seq: 1, type: 'user_message', payload: '{}' });
      storage.storeMessage({ channelId: 'ch_1', deviceId: 'dev_1', sessionId: 'sess_1', seq: 2, type: 'agent_message', payload: '{}' });
      storage.storeMessage({ channelId: 'ch_1', deviceId: 'dev_1', sessionId: 'sess_1', seq: 5, type: 'agent_message', payload: '{}' });
      expect(storage.getMaxSeq('ch_1')).toBe(5);
    });

    it('should return empty array when no messages after seq', () => {
      storage.storeMessage({ channelId: 'ch_1', deviceId: 'dev_1', sessionId: 'sess_1', seq: 1, type: 'user_message', payload: '{}' });
      const msgs = storage.getMessagesAfterSeq('ch_1', 10);
      expect(msgs).toHaveLength(0);
    });
  });
});

describe('shouldStore', () => {
  it('should return true for stored message types', () => {
    expect(shouldStore('agent_message')).toBe(true);
    expect(shouldStore('user_message')).toBe(true);
    expect(shouldStore('permission')).toBe(true);
    expect(shouldStore('approve')).toBe(true);
    expect(shouldStore('kill_session')).toBe(true);
    expect(shouldStore('tool_start')).toBe(true);
    expect(shouldStore('tool_complete')).toBe(true);
  });

  it('should return false for transient message types', () => {
    expect(shouldStore('agent_message_delta')).toBe(false);
    expect(shouldStore('idle')).toBe(false);
  });

  it('should return false for unknown types', () => {
    expect(shouldStore('something_random')).toBe(false);
  });
});
