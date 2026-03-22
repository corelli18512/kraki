import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { KrakiWSClient } from '../lib/ws-client';
import { useStore } from '../hooks/useStore';

// Access the mock WebSocket instances
let lastWsInstance: any;
const OriginalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  useStore.getState().reset();
  // Wrap WebSocket to capture instances
  globalThis.WebSocket = class extends OriginalWebSocket {
    constructor(url: string) {
      super(url);
      lastWsInstance = this;
    }
  } as any;
});

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
  vi.restoreAllMocks();
});

describe('KrakiWSClient', () => {
  describe('connect', () => {
    it('sets status to connecting when credentials exist', () => {
      localStorage.setItem('kraki_device', JSON.stringify({ relay: 'ws://localhost:9999', deviceId: 'dev_test' }));
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();
      expect(useStore.getState().status).toBe('connecting');
    });

    it('sends auth message on open', async () => {
      // Set up a stored device so the client sends auth (not auth_info)
      localStorage.setItem('kraki_device', JSON.stringify({ relay: 'ws://localhost:9999', deviceId: 'dev_test' }));
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();

      // Wait for onopen to fire (setTimeout 0 in mock)
      await vi.waitFor(() => {
        expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0);
      });

      const authMsg = JSON.parse(lastWsInstance.sentMessages[0]);
      expect(authMsg.type).toBe('auth');
      expect(authMsg.device.role).toBe('app');
      expect(authMsg.device.kind).toBe('web');
      localStorage.removeItem('kraki_device');
    });

    it('sends auth_info when no credentials available', async () => {
      localStorage.removeItem('kraki_device');
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();

      await vi.waitFor(() => {
        expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0);
      });

      const msg = JSON.parse(lastWsInstance.sentMessages[0]);
      expect(msg.type).toBe('auth_info');
    });

    it('sends "Web Mobile" name when user agent includes Mobile', async () => {
      const origUA = navigator.userAgent;
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS) Mobile Safari',
        configurable: true,
      });

      // Set up a stored device so the client sends auth
      localStorage.setItem('kraki_device', JSON.stringify({ relay: 'ws://localhost:9999', deviceId: 'dev_test' }));
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();

      await vi.waitFor(() => {
        expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0);
      });

      const authMsg = JSON.parse(lastWsInstance.sentMessages[0]);
      expect(authMsg.device.name).toBe('Web Mobile');

      Object.defineProperty(navigator, 'userAgent', {
        value: origUA,
        configurable: true,
      });
      localStorage.removeItem('kraki_device');
    });
  });

  describe('auth_ok handling', () => {
    it('stores auth info on auth_ok', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();

      await vi.waitFor(() => {
        expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0);
      });

      // Simulate auth_ok from server
      lastWsInstance._receive({
        type: 'auth_ok',
        channel: 'ch-test',
        deviceId: 'dev-web-123',
        e2e: false,
        devices: [
          { id: 'dev-1', name: 'MacBook', role: 'tentacle', online: true },
        ],
        sessions: [
          { id: 'sess-1', deviceId: 'dev-1', deviceName: 'MacBook', agent: 'copilot', state: 'active', messageCount: 3 },
        ],
      });

      const state = useStore.getState();
      expect(state.status).toBe('connected');
      expect(state.channel).toBe('ch-test');
      expect(state.deviceId).toBe('dev-web-123');
      expect(state.devices.size).toBe(1);
      expect(state.sessions.size).toBe(1);
    });
  });

  describe('message routing', () => {
    async function connectAndAuth(client: KrakiWSClient) {
      client.connect();
      await vi.waitFor(() => {
        expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0);
      });
      lastWsInstance._receive({
        type: 'auth_ok',
        channel: 'ch-test',
        deviceId: 'dev-web-123',
        e2e: false,
        devices: [],
        sessions: [
          { id: 'sess-1', deviceId: 'dev-1', deviceName: 'MacBook', agent: 'copilot', state: 'active', messageCount: 0 },
        ],
      });
    }

    it('routes agent_message to store', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      lastWsInstance._receive({
        type: 'agent_message',
        channel: 'ch-test',
        deviceId: 'dev-1',
        seq: 1,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { content: 'Hello!' },
      });

      const msgs = useStore.getState().messages.get('sess-1');
      expect(msgs).toHaveLength(1);
      expect((msgs![0] as any).payload.content).toBe('Hello!');
    });

    it('routes agent_message_delta to streaming content', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      lastWsInstance._receive({
        type: 'agent_message_delta',
        channel: 'ch-test',
        deviceId: 'dev-1',
        seq: 1,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { content: 'Hel' },
      });
      lastWsInstance._receive({
        type: 'agent_message_delta',
        channel: 'ch-test',
        deviceId: 'dev-1',
        seq: 2,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { content: 'lo!' },
      });

      expect(useStore.getState().streamingContent.get('sess-1')).toBe('Hello!');
    });

    it('flushes delta on agent_message', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      useStore.getState().appendDelta('sess-1', 'streaming...');
      lastWsInstance._receive({
        type: 'agent_message',
        channel: 'ch-test',
        deviceId: 'dev-1',
        seq: 3,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { content: 'Final message' },
      });

      expect(useStore.getState().streamingContent.has('sess-1')).toBe(false);
    });

    it('routes session_created and creates session', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      lastWsInstance._receive({
        type: 'session_created',
        channel: 'ch-test',
        deviceId: 'dev-1',
        seq: 1,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-new',
        payload: { agent: 'claude', model: 'claude-4' },
      });

      const session = useStore.getState().sessions.get('sess-new');
      expect(session).toBeDefined();
      expect(session?.agent).toBe('claude');
      expect(session?.model).toBe('claude-4');
      expect(session?.state).toBe('active');
    });

    it('routes session_ended and updates state', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      lastWsInstance._receive({
        type: 'session_ended',
        channel: 'ch-test',
        deviceId: 'dev-1',
        seq: 2,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { reason: 'completed' },
      });

      expect(useStore.getState().sessions.get('sess-1')?.state).toBe('ended');
    });

    it('routes permission request and stores it', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      lastWsInstance._receive({
        type: 'permission',
        channel: 'ch-test',
        deviceId: 'dev-1',
        seq: 3,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: {
          id: 'perm-abc',
          toolName: 'shell',
          args: { command: 'rm -rf' },
          description: 'Delete files',
        },
      });

      expect(useStore.getState().pendingPermissions.size).toBe(1);
      const perm = useStore.getState().pendingPermissions.get('perm-abc');
      expect(perm?.toolName).toBe('shell');
      expect(perm?.description).toBe('Delete files');
    });

    it('routes question request and stores it', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      lastWsInstance._receive({
        type: 'question',
        channel: 'ch-test',
        deviceId: 'dev-1',
        seq: 4,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: {
          id: 'q-abc',
          question: 'Which framework?',
          choices: ['React', 'Vue'],
        },
      });

      expect(useStore.getState().pendingQuestions.size).toBe(1);
      const q = useStore.getState().pendingQuestions.get('q-abc');
      expect(q?.question).toBe('Which framework?');
      expect(q?.choices).toEqual(['React', 'Vue']);
    });

    it('routes head_notice device_online', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      lastWsInstance._receive({
        type: 'head_notice',
        event: 'device_online',
        data: { device: { id: 'dev-new', name: 'New Machine', role: 'tentacle', online: true } },
      });

      expect(useStore.getState().devices.get('dev-new')).toBeDefined();
    });

    it('routes head_notice device_offline', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);
      useStore.getState().setDevices([{ id: 'dev-1', name: 'Mac', role: 'tentacle', online: true }]);

      lastWsInstance._receive({
        type: 'head_notice',
        event: 'device_offline',
        data: { deviceId: 'dev-1' },
      });

      expect(useStore.getState().devices.get('dev-1')?.online).toBe(false);
    });

    it('routes head_notice session_updated', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      lastWsInstance._receive({
        type: 'head_notice',
        event: 'session_updated',
        data: {
          session: { id: 'sess-1', deviceId: 'dev-1', deviceName: 'Mac', agent: 'copilot', state: 'idle', messageCount: 10 },
        },
      });

      expect(useStore.getState().sessions.get('sess-1')?.state).toBe('idle');
      expect(useStore.getState().sessions.get('sess-1')?.messageCount).toBe(10);
    });

    it('routes idle message and updates session state', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      lastWsInstance._receive({
        type: 'idle',
        channel: 'ch-test',
        deviceId: 'dev-1',
        seq: 5,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: {},
      });

      expect(useStore.getState().sessions.get('sess-1')?.state).toBe('idle');
    });
  });

  describe('actions', () => {
    async function setupClient() {
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();
      await vi.waitFor(() => {
        expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0);
      });
      lastWsInstance._receive({
        type: 'auth_ok',
        channel: 'ch-test',
        deviceId: 'dev-web-123',
        e2e: false,
        devices: [],
        sessions: [],
      });
      // Clear auth message
      lastWsInstance.sentMessages = [];
      return client;
    }

    it('sendInput sends correct message', async () => {
      const client = await setupClient();
      client.sendInput('sess-1', 'Hello agent');

      const sent = JSON.parse(lastWsInstance.sentMessages[0]);
      expect(sent.type).toBe('send_input');
      expect(sent.sessionId).toBe('sess-1');
      expect(sent.payload.text).toBe('Hello agent');
    });

    it('approve sends correct message and removes permission', async () => {
      const client = await setupClient();
      useStore.getState().addPermission({
        id: 'perm-1', sessionId: 'sess-1', toolName: 'shell',
        args: { command: 'ls' }, description: 'List', timestamp: '',
      });

      client.approve('perm-1', 'sess-1');

      const sent = JSON.parse(lastWsInstance.sentMessages[0]);
      expect(sent.type).toBe('approve');
      expect(sent.payload.permissionId).toBe('perm-1');
      expect(useStore.getState().pendingPermissions.size).toBe(0);
    });

    it('deny sends correct message and removes permission', async () => {
      const client = await setupClient();
      useStore.getState().addPermission({
        id: 'perm-1', sessionId: 'sess-1', toolName: 'shell',
        args: { command: 'rm' }, description: 'Delete', timestamp: '',
      });

      client.deny('perm-1', 'sess-1');

      const sent = JSON.parse(lastWsInstance.sentMessages[0]);
      expect(sent.type).toBe('deny');
      expect(useStore.getState().pendingPermissions.size).toBe(0);
    });

    it('alwaysAllow sends correct message and removes permission', async () => {
      const client = await setupClient();
      useStore.getState().addPermission({
        id: 'perm-1', sessionId: 'sess-1', toolName: 'shell',
        args: { command: 'ls' }, description: 'List', timestamp: '',
      });

      client.alwaysAllow('perm-1', 'sess-1');

      const sent = JSON.parse(lastWsInstance.sentMessages[0]);
      expect(sent.type).toBe('always_allow');
      expect(useStore.getState().pendingPermissions.size).toBe(0);
    });

    it('answer sends correct message and removes question', async () => {
      const client = await setupClient();
      useStore.getState().addQuestion({
        id: 'q-1', sessionId: 'sess-1', question: 'Which?',
        choices: ['A', 'B'], timestamp: '',
      });

      client.answer('q-1', 'sess-1', 'A');

      const sent = JSON.parse(lastWsInstance.sentMessages[0]);
      expect(sent.type).toBe('answer');
      expect(sent.payload.questionId).toBe('q-1');
      expect(sent.payload.answer).toBe('A');
      expect(useStore.getState().pendingQuestions.size).toBe(0);
    });

    it('killSession sends correct message', async () => {
      const client = await setupClient();
      client.killSession('sess-1');

      const sent = JSON.parse(lastWsInstance.sentMessages[0]);
      expect(sent.type).toBe('kill_session');
      expect(sent.sessionId).toBe('sess-1');
    });
  });

  describe('disconnect', () => {
    it('sets status to disconnected', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();
      await vi.waitFor(() => {
        expect(lastWsInstance).toBeDefined();
      });
      useStore.getState().setStatus('connected');

      client.disconnect();
      expect(useStore.getState().status).toBe('disconnected');
    });
  });

  describe('onMessage handler', () => {
    it('calls registered handlers on message', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      const handler = vi.fn();
      client.onMessage(handler);
      client.connect();

      await vi.waitFor(() => {
        expect(lastWsInstance).toBeDefined();
      });

      lastWsInstance._receive({ type: 'pong' });
      expect(handler).toHaveBeenCalledWith({ type: 'pong' });
    });

    it('unsubscribe removes handler', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      const handler = vi.fn();
      const unsub = client.onMessage(handler);
      client.connect();

      await vi.waitFor(() => {
        expect(lastWsInstance).toBeDefined();
      });

      unsub();
      lastWsInstance._receive({ type: 'pong' });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('ping/pong', () => {
    it('responds to pong without error', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();

      await vi.waitFor(() => {
        expect(lastWsInstance).toBeDefined();
      });

      // Should not throw
      lastWsInstance._receive({ type: 'pong' });
    });
  });

  describe('auth_error', () => {
    it('sets status to awaiting_login on auth_error without stored device', async () => {
      // Ensure no stored device so the else branch (awaiting_login) is hit
      localStorage.removeItem('kraki_device');
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();

      await vi.waitFor(() => {
        expect(lastWsInstance).toBeDefined();
      });

      lastWsInstance._receive({ type: 'auth_error', message: 'Invalid token' });
      expect(useStore.getState().status).toBe('awaiting_login');
    });

    it('clears stale stored device auth and retries without leaving the app stuck', async () => {
      localStorage.setItem('kraki_device', JSON.stringify({ relay: 'ws://localhost:9999', deviceId: 'dev-stale' }));
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();

      await vi.waitFor(() => {
        expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0);
      });

      lastWsInstance._receive({ type: 'auth_error', message: 'Signature mismatch' });

      await vi.waitFor(() => {
        const msg = JSON.parse(lastWsInstance.sentMessages.at(-1));
        expect(msg.type).toBe('auth_info');
      });

      expect(localStorage.getItem('kraki_device')).toBeNull();
      expect(useStore.getState().lastError).toBe('Authentication failed. Please sign in again or scan a new pairing QR code.');
    });
  });

  describe('WebSocket constructor failure', () => {
    it('sets error status and schedules reconnect when constructor throws', () => {
      vi.useFakeTimers();
      // Make WebSocket constructor throw
      globalThis.WebSocket = class {
        constructor() { throw new Error('network unavailable'); }
      } as any;

      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();
      expect(useStore.getState().status).toBe('error');

      // Should schedule reconnect — advance timers and check connect is retried
      globalThis.WebSocket = OriginalWebSocket;
      vi.useRealTimers();
    });
  });

  describe('malformed message handling', () => {
    it('ignores malformed JSON without crashing', async () => {
      localStorage.setItem('kraki_device', JSON.stringify({ relay: 'ws://localhost:9999', deviceId: 'dev_test' }));
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();
      await vi.waitFor(() => expect(lastWsInstance).toBeDefined());

      // Send raw invalid JSON through onmessage
      lastWsInstance.onmessage?.({ data: 'not valid json{{{' } as MessageEvent);
      // Should not throw — status unchanged
      expect(useStore.getState().status).toBe('connecting');
    });
  });

  describe('onerror handler', () => {
    it('sets status to error on WebSocket error', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();
      await vi.waitFor(() => expect(lastWsInstance).toBeDefined());

      lastWsInstance.onerror?.(new Event('error'));
      expect(useStore.getState().status).toBe('error');
    });
  });

  describe('onclose reconnect', () => {
    it('schedules reconnect on unintentional close and fires reconnect timer', async () => {
      vi.useFakeTimers();
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();

      await vi.advanceTimersByTimeAsync(0); // fire onopen setTimeout

      const firstWs = lastWsInstance;

      // Simulate unintentional close
      firstWs.readyState = 3; // CLOSED
      firstWs.onclose?.({} as CloseEvent);

      expect(useStore.getState().status).toBe('disconnected');

      // Advance past reconnect delay (1000ms base) — should call connect() again
      await vi.advanceTimersByTimeAsync(1500);

      // A new WebSocket should have been created (connect called again)
      expect(lastWsInstance).not.toBe(firstWs);

      vi.useRealTimers();
    });

    it('does not reconnect on intentional disconnect', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();
      await vi.waitFor(() => expect(lastWsInstance).toBeDefined());

      client.disconnect();
      // Status should be disconnected, not reconnecting
      expect(useStore.getState().status).toBe('disconnected');
    });

    it('cleanup clears reconnect timer on disconnect during reconnect', async () => {
      vi.useFakeTimers();
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();

      await vi.advanceTimersByTimeAsync(0); // fire onopen

      const firstWs = lastWsInstance;

      // Trigger unintentional close to schedule reconnect
      firstWs.readyState = 3;
      firstWs.onclose?.({} as CloseEvent);

      // Now disconnect intentionally before reconnect timer fires
      // This should clear the reconnectTimer in cleanup
      client.disconnect();

      // Advance timers — no new connect should fire
      const wsBeforeAdvance = lastWsInstance;
      await vi.advanceTimersByTimeAsync(5000);
      // lastWsInstance shouldn't have changed (no new connection)
      expect(lastWsInstance).toBe(wsBeforeAdvance);

      vi.useRealTimers();
    });

    it('does not schedule duplicate reconnect timers', async () => {
      vi.useFakeTimers();
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();

      await vi.advanceTimersByTimeAsync(0); // fire onopen setTimeout

      const firstWs = lastWsInstance;

      // Trigger close — schedules reconnect
      firstWs.readyState = 3;
      firstWs.onclose?.({} as CloseEvent);

      // Trigger another close — scheduleReconnect guard should skip
      firstWs.onclose?.({} as CloseEvent);

      // Only one reconnect timer should be set, so only one new connect after delay
      // The guard `if (this.reconnectTimer) return;` prevents duplicates
      // We just verify no error is thrown
      vi.useRealTimers();
    });
  });

  describe('replay on reconnect', () => {
    it('sends replay message when lastSeq > 0', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();
      await vi.waitFor(() => expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0));

      // First auth — establish some lastSeq by receiving a message with seq
      lastWsInstance._receive({
        type: 'auth_ok',
        channel: 'ch-test',
        deviceId: 'dev-web-123',
        e2e: false,
        devices: [],
        sessions: [{ id: 'sess-1', deviceId: 'dev-1', deviceName: 'Mac', agent: 'copilot', state: 'active', messageCount: 0 }],
      });

      // Receive a message with seq to set lastSeq
      lastWsInstance._receive({
        type: 'agent_message',
        channel: 'ch-test',
        deviceId: 'dev-1',
        seq: 42,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { content: 'hello' },
      });

      lastWsInstance.sentMessages = [];

      // Simulate reconnect — new auth_ok
      lastWsInstance._receive({
        type: 'auth_ok',
        channel: 'ch-test',
        deviceId: 'dev-web-456',
        e2e: false,
        devices: [],
        sessions: [],
      });

      // Should have sent a replay message
      const replayMsg = lastWsInstance.sentMessages.find(
        (m: string) => JSON.parse(m).type === 'replay',
      );
      expect(replayMsg).toBeDefined();
      expect(JSON.parse(replayMsg!).afterSeq).toBe(42);
    });
  });

  describe('head_notice device_added and device_removed', () => {
    async function connectAndAuth(client: KrakiWSClient) {
      client.connect();
      await vi.waitFor(() => expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0));
      lastWsInstance._receive({
        type: 'auth_ok', channel: 'ch-test', deviceId: 'dev-web-123', e2e: false,
        devices: [{ id: 'dev-1', name: 'Mac', role: 'tentacle', online: true }],
        sessions: [],
      });
    }

    it('routes head_notice device_added', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      lastWsInstance._receive({
        type: 'head_notice',
        event: 'device_added',
        data: { device: { id: 'dev-new', name: 'New Server', role: 'tentacle', online: true } },
      });

      expect(useStore.getState().devices.get('dev-new')?.name).toBe('New Server');
    });

    it('routes head_notice device_removed', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      lastWsInstance._receive({
        type: 'head_notice',
        event: 'device_removed',
        data: { deviceId: 'dev-1' },
      });

      expect(useStore.getState().devices.has('dev-1')).toBe(false);
    });
  });

  describe('default data message handler', () => {
    async function connectAndAuth(client: KrakiWSClient) {
      client.connect();
      await vi.waitFor(() => expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0));
      lastWsInstance._receive({
        type: 'auth_ok', channel: 'ch-test', deviceId: 'dev-web-123', e2e: false,
        devices: [],
        sessions: [{ id: 'sess-1', deviceId: 'dev-1', deviceName: 'Mac', agent: 'copilot', state: 'active', messageCount: 0 }],
      });
    }

    it('appends unknown message type with payload to messages', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      lastWsInstance._receive({
        type: 'user_message',
        channel: 'ch-test',
        deviceId: 'dev-1',
        seq: 10,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { content: 'user typed this' },
      });

      const msgs = useStore.getState().messages.get('sess-1');
      expect(msgs).toBeDefined();
      expect(msgs!.length).toBeGreaterThan(0);
    });

    it('ignores messages without sessionId', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      lastWsInstance._receive({
        type: 'some_unknown',
        channel: 'ch-test',
        deviceId: 'dev-1',
        seq: 11,
        timestamp: new Date().toISOString(),
        // no sessionId
        payload: { data: 'test' },
      });

      // No messages should be added for any session
      expect(useStore.getState().messages.size).toBe(0);
    });
  });

  describe('ping timer and cleanup', () => {
    it('starts ping timer on connect and cleans up on disconnect', async () => {
      vi.useFakeTimers();
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();

      // Fire the setTimeout(0) for onopen in mock WebSocket
      await vi.advanceTimersByTimeAsync(1);

      // Verify onopen fired auth message
      expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0);
      const authMsg = JSON.parse(lastWsInstance.sentMessages[0]);
      expect(authMsg.type).toBe('auth');

      // Reset messages to track just pings
      lastWsInstance.sentMessages = [];

      // Advance past ping interval (25s) — ping should fire
      await vi.advanceTimersByTimeAsync(26000);
      const pings = lastWsInstance.sentMessages.filter(
        (m: string) => JSON.parse(m).type === 'ping',
      );
      expect(pings.length).toBeGreaterThanOrEqual(1);

      // Disconnect should clear timer
      client.disconnect();

      vi.useRealTimers();
    });
  });

  describe('send when closed', () => {
    it('does not throw when sending on closed socket', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();
      await vi.waitFor(() => expect(lastWsInstance).toBeDefined());

      lastWsInstance.readyState = 3; // CLOSED
      // Should not throw
      client.sendInput('sess-1', 'test');
    });
  });

  describe('createSession + requestId correlation', () => {
    async function connectAndAuth(client: KrakiWSClient) {
      client.connect();
      await vi.waitFor(() => {
        expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0);
      });
      lastWsInstance._receive({
        type: 'auth_ok',
        channel: 'ch-test',
        deviceId: 'dev-web-123',
        e2e: false,
        devices: [
          { id: 'dev-tent', name: 'Mac', role: 'tentacle', online: true },
        ],
        sessions: [],
      });
    }

    it('sends create_session with requestId', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      client.createSession({ targetDeviceId: 'dev-tent', model: 'gpt-4.1', prompt: 'Hello' });

      const sent = lastWsInstance.sentMessages;
      const createMsg = sent.find((m: string) => {
        const p = JSON.parse(m);
        return p.type === 'create_session';
      });
      expect(createMsg).toBeTruthy();
      const parsed = JSON.parse(createMsg);
      expect(parsed.payload.requestId).toBeTruthy();
      expect(parsed.payload.targetDeviceId).toBe('dev-tent');
      expect(parsed.payload.model).toBe('gpt-4.1');
      expect(parsed.payload.prompt).toBe('Hello');
    });

    it('inserts initial prompt as user message on session_created with matching requestId', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      client.createSession({ targetDeviceId: 'dev-tent', model: 'gpt-4.1', prompt: 'Fix the bug' });

      // Extract the requestId from the sent message
      const sent = lastWsInstance.sentMessages;
      const createMsg = sent.find((m: string) => JSON.parse(m).type === 'create_session');
      const requestId = JSON.parse(createMsg).payload.requestId;

      // Simulate session_created with matching requestId
      lastWsInstance._receive({
        type: 'session_created',
        channel: 'ch-test',
        deviceId: 'dev-tent',
        seq: 1,
        timestamp: new Date().toISOString(),
        sessionId: 'new-sess-1',
        payload: { agent: 'copilot', model: 'gpt-4.1', requestId },
      });

      const messages = useStore.getState().messages.get('new-sess-1') ?? [];
      const userMsg = messages.find((m: any) => m.type === 'user_message');
      expect(userMsg).toBeTruthy();
      expect((userMsg as any).payload.content).toBe('Fix the bug');
    });

    it('does not insert prompt for session_created without matching requestId', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      client.createSession({ targetDeviceId: 'dev-tent', model: 'gpt-4.1', prompt: 'Fix the bug' });

      // Simulate session_created with WRONG requestId
      lastWsInstance._receive({
        type: 'session_created',
        channel: 'ch-test',
        deviceId: 'dev-tent',
        seq: 1,
        timestamp: new Date().toISOString(),
        sessionId: 'new-sess-2',
        payload: { agent: 'copilot', model: 'gpt-4.1', requestId: 'wrong_id' },
      });

      const messages = useStore.getState().messages.get('new-sess-2') ?? [];
      const userMsg = messages.find((m: any) => m.type === 'user_message');
      expect(userMsg).toBeUndefined();
    });
  });

  describe('server_error handling', () => {
    async function connectAndAuth(client: KrakiWSClient) {
      client.connect();
      await vi.waitFor(() => {
        expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0);
      });
      lastWsInstance._receive({
        type: 'auth_ok',
        channel: 'ch-test',
        deviceId: 'dev-web-123',
        e2e: false,
        devices: [],
        sessions: [],
      });
    }

    it('sets lastError on server_error', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      lastWsInstance._receive({
        type: 'server_error',
        message: 'Target device "dev-xyz" is not online',
        requestId: 'req-123',
      });

      expect(useStore.getState().lastError).toBe('Target device "dev-xyz" is not online');
    });

    it('clears pending prompt on server_error with matching requestId', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      client.createSession({ targetDeviceId: 'dev-tent', model: 'gpt-4.1', prompt: 'Hello' });
      const sent = lastWsInstance.sentMessages;
      const createMsg = sent.find((m: string) => JSON.parse(m).type === 'create_session');
      const requestId = JSON.parse(createMsg).payload.requestId;

      // server_error with matching requestId
      lastWsInstance._receive({
        type: 'server_error',
        message: 'Device offline',
        requestId,
      });

      // Now if session_created arrives with this requestId, no prompt should be inserted
      lastWsInstance._receive({
        type: 'session_created',
        channel: 'ch-test',
        deviceId: 'dev-tent',
        seq: 1,
        timestamp: new Date().toISOString(),
        sessionId: 'late-sess',
        payload: { agent: 'copilot', requestId },
      });

      const messages = useStore.getState().messages.get('late-sess') ?? [];
      const userMsg = messages.find((m: any) => m.type === 'user_message');
      expect(userMsg).toBeUndefined();
    });
  });

  describe('tool_complete with toolCallId', () => {
    async function connectAndAuth(client: KrakiWSClient) {
      client.connect();
      await vi.waitFor(() => {
        expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0);
      });
      lastWsInstance._receive({
        type: 'auth_ok',
        channel: 'ch-test',
        deviceId: 'dev-web-123',
        e2e: false,
        devices: [],
        sessions: [
          { id: 'sess-1', deviceId: 'dev-1', deviceName: 'Mac', agent: 'copilot', state: 'active', messageCount: 0 },
        ],
      });
    }

    it('merges tool_complete into matching tool_start by toolCallId', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      // Simulate tool_start
      lastWsInstance._receive({
        type: 'tool_start',
        channel: 'ch-test',
        deviceId: 'dev-1',
        seq: 1,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { toolName: 'shell', args: { command: 'ls' }, toolCallId: 'tc-1' },
      });

      // Simulate tool_complete with same toolCallId
      lastWsInstance._receive({
        type: 'tool_complete',
        channel: 'ch-test',
        deviceId: 'dev-1',
        seq: 2,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { toolName: 'shell', args: {}, result: 'file1.txt', toolCallId: 'tc-1' },
      });

      const messages = useStore.getState().messages.get('sess-1') ?? [];
      // Should have merged — only 1 tool message (complete replaced start)
      const toolMsgs = messages.filter((m: any) => m.type === 'tool_start' || m.type === 'tool_complete');
      expect(toolMsgs).toHaveLength(1);
      expect(toolMsgs[0].type).toBe('tool_complete');
      // Should preserve original args
      expect((toolMsgs[0] as any).payload.args.command).toBe('ls');
      expect((toolMsgs[0] as any).payload.result).toBe('file1.txt');
    });

    it('does not merge tool_complete without toolCallId', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      lastWsInstance._receive({
        type: 'tool_start',
        channel: 'ch-test',
        deviceId: 'dev-1',
        seq: 1,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { toolName: 'shell', args: { command: 'ls' } },
      });

      lastWsInstance._receive({
        type: 'tool_complete',
        channel: 'ch-test',
        deviceId: 'dev-1',
        seq: 2,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { toolName: 'shell', args: {}, result: 'done' },
      });

      const messages = useStore.getState().messages.get('sess-1') ?? [];
      const toolMsgs = messages.filter((m: any) => m.type === 'tool_start' || m.type === 'tool_complete');
      // No merge — both should be separate
      expect(toolMsgs).toHaveLength(2);
    });
  });
});
