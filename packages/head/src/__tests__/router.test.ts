import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ProducerMessage, ConsumerMessage } from '@kraki/protocol';
import { Router } from '../router.js';
import { ChannelManager } from '../channel-manager.js';
import { Storage } from '../storage.js';

describe('Router', () => {
  let storage: Storage;
  let cm: ChannelManager;
  let router: Router;
  let channelId: string;

  // Mock send functions to capture what each device receives
  const laptopSend = vi.fn();
  const phoneSend = vi.fn();
  const browserSend = vi.fn();
  const workpcSend = vi.fn();

  beforeEach(() => {
    storage = new Storage(':memory:');
    cm = new ChannelManager(storage);
    router = new Router(cm);
    channelId = cm.getOrCreateChannel({ id: '123', login: 'corelli', provider: 'github' });

    laptopSend.mockClear();
    phoneSend.mockClear();
    browserSend.mockClear();
    workpcSend.mockClear();
  });

  afterEach(() => {
    storage.close();
  });

  function registerDevices() {
    const laptop = cm.registerDevice({ channelId, name: 'Laptop', role: 'tentacle', send: laptopSend, kind: 'desktop' });
    const phone = cm.registerDevice({ channelId, name: 'Phone', role: 'app', send: phoneSend, kind: 'ios' });
    const browser = cm.registerDevice({ channelId, name: 'Browser', role: 'app', send: browserSend, kind: 'web' });
    return { laptop, phone, browser };
  }

  describe('producer → apps routing', () => {
    it('should route tentacle messages to all apps', () => {
      const { laptop } = registerDevices();

      const msg: Partial<ProducerMessage> = {
        type: 'agent_message',
        sessionId: 'sess_1',
        payload: { content: 'hello world' },
      };

      router.handleMessage(laptop, msg as ProducerMessage);

      // Both apps should receive
      expect(phoneSend).toHaveBeenCalledTimes(1);
      expect(browserSend).toHaveBeenCalledTimes(1);
      // Tentacle should NOT receive its own message back
      expect(laptopSend).not.toHaveBeenCalled();
    });

    it('should assign seq and stamp envelope', () => {
      const { laptop } = registerDevices();

      router.handleMessage(laptop, {
        type: 'agent_message',
        sessionId: 'sess_1',
        payload: { content: 'test' },
      } as ProducerMessage);

      const sent = JSON.parse(phoneSend.mock.calls[0][0]);
      expect(sent.seq).toBe(1);
      expect(sent.channel).toBe(channelId);
      expect(sent.deviceId).toBe(laptop);
      expect(sent.timestamp).toBeTruthy();
    });

    it('should increment seq across messages', () => {
      const { laptop } = registerDevices();

      router.handleMessage(laptop, {
        type: 'user_message', sessionId: 'sess_1', payload: { content: 'a' },
      } as ProducerMessage);
      router.handleMessage(laptop, {
        type: 'agent_message', sessionId: 'sess_1', payload: { content: 'b' },
      } as ProducerMessage);

      const msg1 = JSON.parse(phoneSend.mock.calls[0][0]);
      const msg2 = JSON.parse(phoneSend.mock.calls[1][0]);
      expect(msg1.seq).toBe(1);
      expect(msg2.seq).toBe(2);
    });

    it('should store storable messages', () => {
      const { laptop } = registerDevices();

      router.handleMessage(laptop, {
        type: 'agent_message', sessionId: 'sess_1', payload: { content: 'stored' },
      } as ProducerMessage);

      const stored = storage.getMessagesAfterSeq(channelId, 0);
      expect(stored).toHaveLength(1);
      expect(stored[0].type).toBe('agent_message');
    });

    it('should NOT store transient messages (delta, idle)', () => {
      const { laptop } = registerDevices();

      router.handleMessage(laptop, {
        type: 'agent_message_delta', sessionId: 'sess_1', payload: { content: 'chunk' },
      } as ProducerMessage);
      router.handleMessage(laptop, {
        type: 'idle', sessionId: 'sess_1', payload: {},
      } as ProducerMessage);

      const stored = storage.getMessagesAfterSeq(channelId, 0);
      expect(stored).toHaveLength(0);

      // But they should still be forwarded
      expect(phoneSend).toHaveBeenCalledTimes(2);
    });

    it('should register session owner on session_created', () => {
      const { laptop } = registerDevices();

      router.handleMessage(laptop, {
        type: 'session_created', sessionId: 'sess_1', payload: { agent: 'copilot' },
      } as ProducerMessage);

      expect(cm.getSessionOwner('sess_1')).toBe(laptop);
    });
  });

  describe('consumer → tentacle routing', () => {
    it('should route app messages to the session owner tentacle', () => {
      const { laptop, phone } = registerDevices();

      // Laptop creates a session
      router.handleMessage(laptop, {
        type: 'session_created', sessionId: 'sess_1', payload: { agent: 'copilot' },
      } as ProducerMessage);

      // Phone approves a permission for that session
      router.handleMessage(phone, {
        type: 'approve', sessionId: 'sess_1', payload: { permissionId: 'perm_1' },
      } as ConsumerMessage);

      // Laptop should receive the approval
      expect(laptopSend).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(laptopSend.mock.calls[0][0]);
      expect(sent.type).toBe('approve');
      expect(sent.payload.permissionId).toBe('perm_1');
    });

    it('should store consumer actions', () => {
      const { laptop, phone } = registerDevices();

      router.handleMessage(laptop, {
        type: 'session_created', sessionId: 'sess_1', payload: { agent: 'copilot' },
      } as ProducerMessage);

      router.handleMessage(phone, {
        type: 'approve', sessionId: 'sess_1', payload: { permissionId: 'perm_1' },
      } as ConsumerMessage);

      const stored = storage.getMessagesAfterSeq(channelId, 0);
      const approveMsg = stored.find(m => m.type === 'approve');
      expect(approveMsg).toBeTruthy();
    });

    it('should NOT route if session owner is unknown', () => {
      const { phone } = registerDevices();

      // No session created, try to approve
      router.handleMessage(phone, {
        type: 'approve', sessionId: 'sess_unknown', payload: { permissionId: 'perm_1' },
      } as ConsumerMessage);

      // Nobody receives it
      expect(laptopSend).not.toHaveBeenCalled();
    });

    it('should route to correct tentacle with multiple tentacles', () => {
      const { laptop, phone } = registerDevices();
      const workpc = cm.registerDevice({ channelId, name: 'Work PC', role: 'tentacle', send: workpcSend, kind: 'desktop' });

      // Laptop owns sess_1, Work PC owns sess_2
      router.handleMessage(laptop, {
        type: 'session_created', sessionId: 'sess_1', payload: { agent: 'copilot' },
      } as ProducerMessage);
      router.handleMessage(workpc, {
        type: 'session_created', sessionId: 'sess_2', payload: { agent: 'claude' },
      } as ProducerMessage);

      // Clear mock calls from session_created routing
      laptopSend.mockClear();
      workpcSend.mockClear();

      // Phone sends input to sess_2 → should go to Work PC only
      router.handleMessage(phone, {
        type: 'send_input', sessionId: 'sess_2', payload: { text: 'hello' },
      } as ConsumerMessage);

      expect(workpcSend).toHaveBeenCalledTimes(1);
      expect(laptopSend).not.toHaveBeenCalled();
    });
  });

  describe('replay', () => {
    it('should replay stored messages to a device', () => {
      const { laptop, phone } = registerDevices();

      // Send some messages
      router.handleMessage(laptop, {
        type: 'user_message', sessionId: 'sess_1', payload: { content: 'a' },
      } as ProducerMessage);
      router.handleMessage(laptop, {
        type: 'agent_message', sessionId: 'sess_1', payload: { content: 'b' },
      } as ProducerMessage);
      router.handleMessage(laptop, {
        type: 'agent_message', sessionId: 'sess_1', payload: { content: 'c' },
      } as ProducerMessage);

      phoneSend.mockClear();

      // Phone requests replay after seq 1
      router.replay(phone, 1);

      // Should get messages 2 and 3 + replay_complete
      expect(phoneSend).toHaveBeenCalledTimes(3);
      const msg1 = JSON.parse(phoneSend.mock.calls[0][0]);
      const msg2 = JSON.parse(phoneSend.mock.calls[1][0]);
      expect(msg1.seq).toBe(2);
      expect(msg2.seq).toBe(3);
      const complete = JSON.parse(phoneSend.mock.calls[2][0]);
      expect(complete.type).toBe('replay_complete');
      expect(complete.lastSeq).toBe(3);
    });

    it('should replay filtered by session', () => {
      const { laptop, phone } = registerDevices();

      router.handleMessage(laptop, {
        type: 'agent_message', sessionId: 'sess_1', payload: { content: 'a' },
      } as ProducerMessage);
      router.handleMessage(laptop, {
        type: 'agent_message', sessionId: 'sess_2', payload: { content: 'b' },
      } as ProducerMessage);

      phoneSend.mockClear();

      router.replay(phone, 0, 'sess_1');
      expect(phoneSend).toHaveBeenCalledTimes(2); // 1 message + replay_complete
      const msg = JSON.parse(phoneSend.mock.calls[0][0]);
      expect(msg.sessionId).toBe('sess_1');
    });

    it('should replay nothing when afterSeq is beyond stored messages', () => {
      const { laptop, phone } = registerDevices();

      router.handleMessage(laptop, {
        type: 'agent_message', sessionId: 'sess_1', payload: { content: 'a' },
      } as ProducerMessage);

      phoneSend.mockClear();

      router.replay(phone, 100);
      expect(phoneSend).toHaveBeenCalledTimes(1); // only replay_complete
      const complete = JSON.parse(phoneSend.mock.calls[0][0]);
      expect(complete.type).toBe('replay_complete');
    });
  });

  describe('broadcastNotice', () => {
    it('should send notice to all connected devices', () => {
      registerDevices();

      router.broadcastNotice(channelId, {
        type: 'head_notice',
        event: 'device_online',
        data: { device: { id: 'dev_x', name: 'X', role: 'app', online: true } },
      });

      expect(laptopSend).toHaveBeenCalledTimes(1);
      expect(phoneSend).toHaveBeenCalledTimes(1);
      expect(browserSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('create_session routing', () => {
    it('should route create_session from app to target tentacle', () => {
      const { laptop, phone } = registerDevices();

      router.handleMessage(phone, {
        type: 'create_session',
        payload: { targetDeviceId: laptop, model: 'claude-sonnet-4' },
      } as any);

      expect(laptopSend).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(laptopSend.mock.calls[0][0]);
      expect(sent.type).toBe('create_session');
      expect(sent.payload.model).toBe('claude-sonnet-4');
      expect(sent.payload.targetDeviceId).toBe(laptop);
    });

    it('should include prompt and cwd in create_session', () => {
      const { laptop, phone } = registerDevices();

      router.handleMessage(phone, {
        type: 'create_session',
        payload: {
          targetDeviceId: laptop,
          model: 'gpt-4.1',
          prompt: 'Fix the login bug',
          cwd: '/home/user/project',
        },
      } as any);

      const sent = JSON.parse(laptopSend.mock.calls[0][0]);
      expect(sent.payload.prompt).toBe('Fix the login bug');
      expect(sent.payload.cwd).toBe('/home/user/project');
    });

    it('should route create_session to correct tentacle among multiple', () => {
      const { laptop, phone } = registerDevices();
      const workpc = cm.registerDevice({ channelId, name: 'Work PC', role: 'tentacle', send: workpcSend, kind: 'desktop' });

      router.handleMessage(phone, {
        type: 'create_session',
        payload: { targetDeviceId: workpc, model: 'claude-sonnet-4' },
      } as any);

      expect(workpcSend).toHaveBeenCalledTimes(1);
      expect(laptopSend).not.toHaveBeenCalled();
    });

    it('should not route create_session to offline/unknown device', () => {
      const { phone } = registerDevices();

      router.handleMessage(phone, {
        type: 'create_session',
        payload: { targetDeviceId: 'dev_nonexistent', model: 'claude-sonnet-4' },
      } as any);

      expect(laptopSend).not.toHaveBeenCalled();
    });

    it('should not route create_session to an app device', () => {
      const { phone, browser } = registerDevices();

      router.handleMessage(phone, {
        type: 'create_session',
        payload: { targetDeviceId: browser, model: 'claude-sonnet-4' },
      } as any);

      // Browser is an app, not a tentacle — should not receive
      expect(browserSend).not.toHaveBeenCalled();
    });

    it('should not store create_session (transient message)', () => {
      const { laptop, phone } = registerDevices();

      router.handleMessage(phone, {
        type: 'create_session',
        payload: { targetDeviceId: laptop, model: 'claude-sonnet-4' },
      } as any);

      const stored = storage.getMessagesAfterSeq(channelId, 0);
      expect(stored).toHaveLength(0);
    });

    it('should stamp seq and envelope on create_session', () => {
      const { laptop, phone } = registerDevices();

      router.handleMessage(phone, {
        type: 'create_session',
        payload: { targetDeviceId: laptop, model: 'claude-sonnet-4' },
      } as any);

      const sent = JSON.parse(laptopSend.mock.calls[0][0]);
      expect(sent.seq).toBe(1);
      expect(sent.channel).toBe(channelId);
      expect(sent.deviceId).toBe(phone);
      expect(sent.timestamp).toBeTruthy();
    });

    it('should not forward create_session to apps', () => {
      const { laptop, phone } = registerDevices();

      router.handleMessage(phone, {
        type: 'create_session',
        payload: { targetDeviceId: laptop, model: 'claude-sonnet-4' },
      } as any);

      // Only the target tentacle receives it, not the other app
      expect(browserSend).not.toHaveBeenCalled();
      // Phone (sender) shouldn't get it back either
      expect(phoneSend).not.toHaveBeenCalled();
    });
  });

  describe('ignored messages from unknown devices', () => {
    it('should silently ignore messages from unregistered devices', () => {
      registerDevices();

      router.handleMessage('dev_unknown', {
        type: 'agent_message', sessionId: 'sess_1', payload: { content: 'hello' },
      } as ProducerMessage);

      expect(phoneSend).not.toHaveBeenCalled();
      expect(browserSend).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should replay to unknown device without error', () => {
      registerDevices();
      // Should not throw
      router.replay('dev_nonexistent', 0);
    });

    it('should handle consumer message with no sessionId', () => {
      const { laptop, phone } = registerDevices();

      // App sends message without sessionId — should not route to any tentacle
      router.handleMessage(phone, {
        type: 'send_input', payload: { text: 'hello' },
      } as any);

      expect(laptopSend).not.toHaveBeenCalled();
    });

    it('should handle producer message without sessionId (stores with null)', () => {
      const { laptop } = registerDevices();

      router.handleMessage(laptop, {
        type: 'error', payload: { message: 'something broke' },
      } as ProducerMessage);

      const stored = storage.getMessagesAfterSeq(channelId, 0);
      expect(stored).toHaveLength(1);
      expect(stored[0].sessionId).toBeNull();
    });

    it('should skip corrupt messages during replay gracefully', () => {
      const { laptop, phone } = registerDevices();

      // Store a valid message
      router.handleMessage(laptop, {
        type: 'user_message', sessionId: 'sess_1', payload: { content: 'good' },
      } as ProducerMessage);

      // Manually insert a corrupt payload directly into storage
      storage.storeMessage({
        channelId,
        deviceId: laptop,
        sessionId: 'sess_1',
        seq: cm.nextSeq(channelId),
        type: 'agent_message',
        payload: 'NOT VALID JSON {{{',
      });

      // Store another valid message
      router.handleMessage(laptop, {
        type: 'agent_message', sessionId: 'sess_1', payload: { content: 'also good' },
      } as ProducerMessage);

      phoneSend.mockClear();

      // Replay should skip the corrupt one, send the two valid ones + replay_complete
      router.replay(phone, 0);
      expect(phoneSend).toHaveBeenCalledTimes(3);
    });
  });

  describe('channel isolation', () => {
    it('should not route create_session to a tentacle in another channel', () => {
      const { phone } = registerDevices();
      // Create a second channel with a different user
      const otherChannel = cm.getOrCreateChannel({ id: '456', login: 'other', provider: 'github' });
      const otherTentacleSend = vi.fn();
      const otherTentacle = cm.registerDevice({ channelId: otherChannel, name: 'Other Laptop', role: 'tentacle', send: otherTentacleSend });

      router.handleMessage(phone, {
        type: 'create_session',
        payload: { requestId: 'req_cross', targetDeviceId: otherTentacle, model: 'test' },
      } as any);

      // Other channel's tentacle should NOT receive the message
      expect(otherTentacleSend).not.toHaveBeenCalled();
      // Sender should get server_error
      expect(phoneSend).toHaveBeenCalledTimes(1);
      const err = JSON.parse(phoneSend.mock.calls[0][0]);
      expect(err.type).toBe('server_error');
      expect(err.message).toContain('different channel');
    });

    it('should reject cross-channel device ID collision in storage', () => {
      const ch1 = cm.getOrCreateChannel({ id: '100', login: 'user1', provider: 'github' });
      const ch2 = cm.getOrCreateChannel({ id: '200', login: 'user2', provider: 'github' });
      cm.registerDevice({ channelId: ch1, name: 'Device', role: 'tentacle', send: vi.fn(), clientDeviceId: 'shared_id' });
      // Same deviceId in different channel should throw
      expect(() => {
        cm.registerDevice({ channelId: ch2, name: 'Device', role: 'tentacle', send: vi.fn(), clientDeviceId: 'shared_id' });
      }).toThrow(/belongs to channel/);
    });

    it('should allow same-channel reconnect with stable deviceId', () => {
      const { laptop } = registerDevices();
      cm.disconnectDevice(laptop);
      // Reconnect same device in same channel
      const reconnected = cm.registerDevice({ channelId, name: 'Laptop', role: 'tentacle', send: laptopSend, clientDeviceId: laptop });
      expect(reconnected).toBe(laptop);
      expect(cm.getConnection(laptop)).toBeTruthy();
    });
  });
});
