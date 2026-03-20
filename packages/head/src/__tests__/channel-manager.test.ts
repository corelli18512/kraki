import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChannelManager } from '../channel-manager.js';
import { Storage } from '../storage.js';

describe('ChannelManager', () => {
  let storage: Storage;
  let cm: ChannelManager;
  const mockSend = vi.fn();

  beforeEach(() => {
    storage = new Storage(':memory:');
    cm = new ChannelManager(storage);
    mockSend.mockClear();
  });

  afterEach(() => {
    storage.close();
  });

  describe('channels', () => {
    it('should create a channel for a new user', () => {
      const channelId = cm.getOrCreateChannel({ id: '123', login: 'corelli', provider: 'github' });
      expect(channelId).toMatch(/^ch_/);
    });

    it('should return same channel for same user', () => {
      const ch1 = cm.getOrCreateChannel({ id: '123', login: 'corelli', provider: 'github' });
      const ch2 = cm.getOrCreateChannel({ id: '123', login: 'corelli', provider: 'github' });
      expect(ch1).toBe(ch2);
    });

    it('should create different channels for different users', () => {
      const ch1 = cm.getOrCreateChannel({ id: '1', login: 'alice', provider: 'github' });
      const ch2 = cm.getOrCreateChannel({ id: '2', login: 'bob', provider: 'github' });
      expect(ch1).not.toBe(ch2);
    });
  });

  describe('devices', () => {
    let channelId: string;

    beforeEach(() => {
      channelId = cm.getOrCreateChannel({ id: '123', login: 'corelli', provider: 'github' });
    });

    it('should register a device and return deviceId', () => {
      const deviceId = cm.registerDevice({ channelId, name: 'Laptop', role: 'tentacle', send: mockSend, kind: 'desktop' });
      expect(deviceId).toMatch(/^dev_/);
    });

    it('should reuse client-provided deviceId', () => {
      const deviceId = cm.registerDevice({ channelId, name: 'Laptop', role: 'tentacle', send: mockSend, clientDeviceId: 'dev_my-laptop' });
      expect(deviceId).toBe('dev_my-laptop');
    });

    it('should not create ghost on reconnect with same clientDeviceId', () => {
      cm.registerDevice({ channelId, name: 'Laptop', role: 'tentacle', send: mockSend, clientDeviceId: 'dev_stable' });
      cm.disconnectDevice('dev_stable');
      cm.registerDevice({ channelId, name: 'Laptop', role: 'tentacle', send: mockSend, clientDeviceId: 'dev_stable' });
      const summaries = cm.getDeviceSummaries(channelId);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].id).toBe('dev_stable');
      expect(summaries[0].online).toBe(true);
    });

    it('should track connected devices', () => {
      cm.registerDevice({ channelId, name: 'Laptop', role: 'tentacle', send: mockSend, kind: 'desktop' });
      cm.registerDevice({ channelId, name: 'Phone', role: 'app', send: mockSend, kind: 'ios' });
      const devices = cm.getConnectedDevices(channelId);
      expect(devices).toHaveLength(2);
    });

    it('should filter by role', () => {
      cm.registerDevice({ channelId, name: 'Laptop', role: 'tentacle', send: mockSend });
      cm.registerDevice({ channelId, name: 'Phone', role: 'app', send: mockSend });
      cm.registerDevice({ channelId, name: 'Browser', role: 'app', send: mockSend });

      const tentacles = cm.getConnectedByRole(channelId, 'tentacle');
      expect(tentacles).toHaveLength(1);
      expect(tentacles[0].name).toBe('Laptop');

      const apps = cm.getConnectedByRole(channelId, 'app');
      expect(apps).toHaveLength(2);
    });

    it('should disconnect a device', () => {
      const deviceId = cm.registerDevice({ channelId, name: 'Laptop', role: 'tentacle', send: mockSend });
      const removed = cm.disconnectDevice(deviceId);
      expect(removed?.name).toBe('Laptop');
      expect(cm.getConnectedDevices(channelId)).toHaveLength(0);
    });

    it('should return undefined when disconnecting unknown device', () => {
      expect(cm.disconnectDevice('dev_nonexistent')).toBeUndefined();
    });

    it('should include online status in summaries', () => {
      const deviceId = cm.registerDevice({ channelId, name: 'Laptop', role: 'tentacle', send: mockSend });
      const summaries = cm.getDeviceSummaries(channelId);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].online).toBe(true);

      cm.disconnectDevice(deviceId);
      const after = cm.getDeviceSummaries(channelId);
      expect(after).toHaveLength(1);
      expect(after[0].online).toBe(false);
    });

    it('should include capabilities in summaries for online devices', () => {
      cm.registerDevice({
        channelId, name: 'Laptop', role: 'tentacle', send: mockSend,
        capabilities: { models: ['claude-sonnet-4', 'gpt-4.1'] },
      });
      const summaries = cm.getDeviceSummaries(channelId);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].capabilities).toEqual({ models: ['claude-sonnet-4', 'gpt-4.1'] });
    });

    it('should not include capabilities for offline devices', () => {
      const deviceId = cm.registerDevice({
        channelId, name: 'Laptop', role: 'tentacle', send: mockSend,
        capabilities: { models: ['claude-sonnet-4'] },
      });
      cm.disconnectDevice(deviceId);
      const summaries = cm.getDeviceSummaries(channelId);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].capabilities).toBeUndefined();
    });

    it('should preserve capabilities through reconnect with same deviceId', () => {
      cm.registerDevice({
        channelId, name: 'Laptop', role: 'tentacle', send: mockSend,
        clientDeviceId: 'dev_stable', capabilities: { models: ['model-a'] },
      });
      cm.disconnectDevice('dev_stable');
      cm.registerDevice({
        channelId, name: 'Laptop', role: 'tentacle', send: mockSend,
        clientDeviceId: 'dev_stable', capabilities: { models: ['model-a', 'model-b'] },
      });
      const summaries = cm.getDeviceSummaries(channelId);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].capabilities?.models).toEqual(['model-a', 'model-b']);
    });
  });

  describe('sessions', () => {
    let channelId: string;

    beforeEach(() => {
      channelId = cm.getOrCreateChannel({ id: '123', login: 'corelli', provider: 'github' });
    });

    it('should register and lookup session owner', () => {
      const deviceId = cm.registerDevice({ channelId, name: 'Laptop', role: 'tentacle', send: mockSend });
      cm.registerSession('sess_1', deviceId, { agent: 'copilot' });
      expect(cm.getSessionOwner('sess_1')).toBe(deviceId);
    });

    it('should return undefined for unknown session', () => {
      expect(cm.getSessionOwner('sess_unknown')).toBeUndefined();
    });

    it('should keep sessions after disconnect', () => {
      const deviceId = cm.registerDevice({ channelId, name: 'Laptop', role: 'tentacle', send: mockSend });
      cm.registerSession('sess_1', deviceId, { agent: 'copilot' });
      cm.registerSession('sess_2', deviceId, { agent: 'claude' });
      cm.disconnectDevice(deviceId);
      const summaries = cm.getSessionSummaries(channelId);
      expect(summaries).toHaveLength(2);
    });

    it('should list session summaries with correct metadata', () => {
      const deviceId = cm.registerDevice({ channelId, name: 'Laptop', role: 'tentacle', send: mockSend });
      cm.registerSession('sess_1', deviceId, { agent: 'copilot', model: 'gpt-4' });
      const summaries = cm.getSessionSummaries(channelId);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].id).toBe('sess_1');
      expect(summaries[0].deviceName).toBe('Laptop');
      expect(summaries[0].agent).toBe('copilot');
      expect(summaries[0].model).toBe('gpt-4');
    });
  });

  describe('seq', () => {
    let channelId: string;

    beforeEach(() => {
      channelId = cm.getOrCreateChannel({ id: '123', login: 'corelli', provider: 'github' });
    });

    it('should start at 1 for new channel', () => {
      expect(cm.nextSeq(channelId)).toBe(1);
    });

    it('should increment monotonically', () => {
      expect(cm.nextSeq(channelId)).toBe(1);
      expect(cm.nextSeq(channelId)).toBe(2);
      expect(cm.nextSeq(channelId)).toBe(3);
    });

    it('should resume from stored max seq', () => {
      storage.storeMessage({ channelId, deviceId: 'dev_1', sessionId: 'sess_1', seq: 10, type: 'agent_message', payload: '{}' });
      const cm2 = new ChannelManager(storage);
      expect(cm2.nextSeq(channelId)).toBe(11);
    });
  });
});
