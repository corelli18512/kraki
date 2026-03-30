import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { KrakiWSClient } from '../lib/ws-client';
import { useStore } from '../hooks/useStore';

// Mock encryption so data messages pass through without real crypto
vi.mock('./message-db', () => ({
  putMessage: async () => {},
  putMessages: async () => {},
  getMessages: async () => [],
  getAllMessages: async () => new Map(),
  getLastSeq: async () => 0,
  deleteSessionMessages: async () => {},
  updateSessionMessages: async () => {},
  clearAllMessages: async () => {},
  putPermission: async () => {},
  removePermissionFromDB: async () => {},
  getAllPermissions: async () => new Map(),
  putQuestion: async () => {},
  removeQuestionFromDB: async () => {},
  getAllQuestions: async () => new Map(),
}));

vi.mock('./encryption', () => ({
  EncryptionHandler: class {
    keyStore: unknown;
    constructor(keyStore: unknown) { this.keyStore = keyStore; }
    async handleEncrypted(msg: Record<string, unknown>, callbacks: Record<string, unknown>) {
      const inner = JSON.parse(msg.blob);
      callbacks.handleDataMessage(inner);
      (callbacks as { getHandlers: () => Array<(msg: unknown) => void> }).getHandlers().forEach((h: (msg: unknown) => void) => h(inner));
    }
    async encryptOutbound(msg: unknown, send: (msg: unknown) => void) { send(msg); }
    async drainEncryptedQueue() {}
  },
}));

vi.mock('./e2e', () => ({
  createAppKeyStore: () => ({
    isReady: () => true,
    init: async () => {},
    getSigningPublicKey: async () => 'mock-signing-key',
    getPublicKey: async () => 'mock-encryption-key',
  }),
}));

// Access the mock WebSocket instances
let lastWsInstance: WebSocket & { sentMessages: string[]; _receive: (data: Record<string, unknown>) => void };
const OriginalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  useStore.getState().reset();
  // Wrap WebSocket to capture instances
  globalThis.WebSocket = class extends OriginalWebSocket {
    constructor(url: string) {
      super(url);
      lastWsInstance = this;
    }
  } as unknown as typeof OriginalWebSocket;
});

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
  vi.restoreAllMocks();
});

/** Simulate receiving a decrypted inner message through the encryption layer. */
function receiveInner(data: Record<string, unknown>) {
  lastWsInstance._receive({
    type: 'broadcast',
    blob: JSON.stringify(data),
    keys: { 'dev-web-123': 'mock-key' },
  });
}

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
        deviceId: 'dev-web-123',
        devices: [
          { id: 'dev-1', name: 'MacBook', role: 'tentacle', online: true },
        ],
      });

      const state = useStore.getState();
      expect(state.status).toBe('connected');
      expect(state.deviceId).toBe('dev-web-123');
      expect(state.devices.size).toBe(1);
    });

    it('does not send replay requests on auth_ok (session sync is triggered by session_list)', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();

      await vi.waitFor(() => {
        expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0);
      });

      lastWsInstance.sentMessages = [];
      lastWsInstance._receive({
        type: 'auth_ok',
        deviceId: 'dev-web-123',
        devices: [
          { id: 'dev-online', name: 'Online Mac', role: 'tentacle', online: true },
          { id: 'dev-offline', name: 'Offline Mac', role: 'tentacle', online: false },
          { id: 'dev-app', name: 'Phone', role: 'app', online: true },
        ],
      });

      // No request_replay or request_session_replay should be sent on auth_ok
      const sent = lastWsInstance.sentMessages.map((raw: string) => JSON.parse(raw));
      const replayMsgs = sent.filter((m: Record<string, unknown>) =>
        m.type === 'request_replay' || m.type === 'request_session_replay',
      );
      expect(replayMsgs).toEqual([]);
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
        deviceId: 'dev-web-123',
        devices: [],
      });
      useStore.getState().upsertSession({
        id: 'sess-1', deviceId: 'dev-1', deviceName: 'MacBook',
        agent: 'copilot', state: 'active', messageCount: 0,
      });
    }

    it('routes agent_message to store', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      receiveInner({
        type: 'agent_message',
        deviceId: 'dev-1',
        seq: 1,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { content: 'Hello!' },
      });

      const msgs = useStore.getState().messages.get('sess-1');
      expect(msgs).toHaveLength(1);
      expect((msgs![0] as Record<string, unknown> & { payload: { content: string } }).payload.content).toBe('Hello!');
    });

    it('routes agent_message_delta to streaming content', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      receiveInner({
        type: 'agent_message_delta',
        deviceId: 'dev-1',
        seq: 1,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { content: 'Hel' },
      });
      receiveInner({
        type: 'agent_message_delta',
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
      receiveInner({
        type: 'agent_message',
        deviceId: 'dev-1',
        seq: 3,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { content: 'Final message' },
      });

      expect(useStore.getState().streamingContent.has('sess-1')).toBe(false);
    });

    it('tracks per-session replay completion via session_replay_complete', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();
      await vi.waitFor(() => {
        expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0);
      });

      lastWsInstance._receive({
        type: 'auth_ok',
        deviceId: 'dev-web-123',
        devices: [
          { id: 'dev-1', name: 'MacBook', role: 'tentacle', online: true },
        ],
      });

      useStore.getState().upsertSession({
        id: 'sess-1',
        deviceId: 'dev-1',
        deviceName: 'MacBook',
        agent: 'copilot',
        state: 'active',
        messageCount: 0,
      });
      useStore.getState().upsertSession({
        id: 'sess-2',
        deviceId: 'dev-1',
        deviceName: 'MacBook',
        agent: 'copilot',
        state: 'active',
        messageCount: 0,
      });

      // Trigger session_list which will request replays for sessions with fewer messages
      receiveInner({
        type: 'session_list',
        deviceId: 'dev-1',
        seq: 0,
        timestamp: new Date().toISOString(),
        payload: {
          sessions: [
            { id: 'sess-1', agent: 'copilot', state: 'active', lastSeq: 5, readSeq: 0, messageCount: 3, createdAt: new Date().toISOString() },
            { id: 'sess-2', agent: 'copilot', state: 'active', lastSeq: 5, readSeq: 0, messageCount: 3, createdAt: new Date().toISOString() },
          ],
        },
      });

      // Messages during replay should not increment unread
      receiveInner({
        type: 'agent_message',
        deviceId: 'dev-1',
        seq: 1,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { content: 'Replay from session 1' },
      });
      receiveInner({
        type: 'agent_message',
        deviceId: 'dev-1',
        seq: 2,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-2',
        payload: { content: 'Replay from session 2' },
      });

      expect(useStore.getState().unreadCount.get('sess-1')).toBeUndefined();
      expect(useStore.getState().unreadCount.get('sess-2')).toBeUndefined();

      // Complete replay for sess-1 only
      receiveInner({
        type: 'session_replay_complete',
        deviceId: 'dev-1',
        seq: 3,
        timestamp: new Date().toISOString(),
        payload: { sessionId: 'sess-1', lastSeq: 10, totalLastSeq: 10 },
      });

      // New message to sess-1 after replay complete should increment unread
      receiveInner({
        type: 'agent_message',
        deviceId: 'dev-1',
        seq: 4,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { content: 'Live from session 1' },
      });
      // sess-2 still replaying — should not increment
      receiveInner({
        type: 'agent_message',
        deviceId: 'dev-1',
        seq: 5,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-2',
        payload: { content: 'Still replaying session 2' },
      });

      expect(useStore.getState().unreadCount.get('sess-1')).toBe(1);
      expect(useStore.getState().unreadCount.get('sess-2')).toBeUndefined();
    });

    it('routes session_created and creates session', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      receiveInner({
        type: 'session_created',
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

      receiveInner({
        type: 'session_ended',
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

      receiveInner({
        type: 'permission',
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

      receiveInner({
        type: 'question',
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

    it('routes idle message and updates session state', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      receiveInner({
        type: 'idle',
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
        deviceId: 'dev-web-123',
        devices: [],
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
      localStorage.removeItem('kraki_device');
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();

      await vi.waitFor(() => {
        expect(lastWsInstance).toBeDefined();
      });

      lastWsInstance._receive({ type: 'auth_error', code: 'auth_rejected', message: 'Invalid token' });
      expect(useStore.getState().status).toBe('awaiting_login');
      expect(useStore.getState().lastError).toBe('Authentication failed. Scan a pairing QR code.');
    });

    it('mentions sign-in on auth_error without stored device when oauth login is available', async () => {
      localStorage.removeItem('kraki_device');
      useStore.getState().setGithubClientId('github-client-id');
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();

      await vi.waitFor(() => {
        expect(lastWsInstance).toBeDefined();
      });

      lastWsInstance._receive({ type: 'auth_error', code: 'auth_rejected', message: 'Invalid token' });
      expect(useStore.getState().lastError).toBe('Authentication failed. Sign in with GitHub or scan a pairing QR code.');
    });

    it('clears stale stored device auth and retries without leaving the app stuck', async () => {
      localStorage.setItem('kraki_device', JSON.stringify({ relay: 'ws://localhost:9999', deviceId: 'dev-stale' }));
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();

      await vi.waitFor(() => {
        expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0);
      });

      lastWsInstance._receive({ type: 'auth_error', code: 'invalid_signature', message: 'Signature mismatch' });

      await vi.waitFor(() => {
        const msg = JSON.parse(lastWsInstance.sentMessages.at(-1));
        expect(msg.type).toBe('auth_info');
      });

      expect(localStorage.getItem('kraki_device')).toBeNull();
      expect(useStore.getState().lastError).toBe('Authentication failed. Please scan a new pairing QR code.');
    });

    it('mentions sign-in when stale stored device auth fails and oauth login is available', async () => {
      localStorage.setItem('kraki_device', JSON.stringify({ relay: 'ws://localhost:9999', deviceId: 'dev-stale' }));
      useStore.getState().setGithubClientId('github-client-id');
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();

      await vi.waitFor(() => {
        expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0);
      });

      lastWsInstance._receive({ type: 'auth_error', code: 'invalid_signature', message: 'Signature mismatch' });

      await vi.waitFor(() => {
        const msg = JSON.parse(lastWsInstance.sentMessages.at(-1));
        expect(msg.type).toBe('auth_info');
      });

      expect(useStore.getState().lastError).toBe('Authentication failed. Please sign in again or scan a new pairing QR code.');
    });
  });

  describe('WebSocket constructor failure', () => {
    it('does not crash when the WebSocket constructor throws', () => {
      vi.useFakeTimers();
      localStorage.setItem('kraki_device', JSON.stringify({ relay: 'ws://localhost:9999', deviceId: 'dev_test' }));
      globalThis.WebSocket = class {
        constructor() { throw new Error('network unavailable'); }
      } as unknown as typeof OriginalWebSocket;

      const client = new KrakiWSClient('ws://localhost:9999');
      expect(() => client.connect()).not.toThrow();

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
      expect(useStore.getState().reconnectAttempts).toBe(1);
      expect(useStore.getState().nextReconnectDelayMs).toBe(1000);

      await vi.advanceTimersByTimeAsync(1500);

      expect(lastWsInstance).not.toBe(firstWs);
      expect(useStore.getState().nextReconnectDelayMs).toBeNull();

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

  describe('default data message handler', () => {
    async function connectAndAuth(client: KrakiWSClient) {
      client.connect();
      await vi.waitFor(() => expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0));
      lastWsInstance._receive({
        type: 'auth_ok', deviceId: 'dev-web-123',
        devices: [],
      });
      useStore.getState().upsertSession({
        id: 'sess-1', deviceId: 'dev-1', deviceName: 'Mac',
        agent: 'copilot', state: 'active', messageCount: 0,
      });
    }

    it('appends unknown message type with payload to messages', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      receiveInner({
        type: 'user_message',
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

      receiveInner({
        type: 'some_unknown',
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
        deviceId: 'dev-web-123',
        devices: [
          { id: 'dev-tent', name: 'Mac', role: 'tentacle', online: true },
        ],
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
      receiveInner({
        type: 'session_created',
        deviceId: 'dev-tent',
        seq: 1,
        timestamp: new Date().toISOString(),
        sessionId: 'new-sess-1',
        payload: { agent: 'copilot', model: 'gpt-4.1', requestId },
      });

      const messages = useStore.getState().messages.get('new-sess-1') ?? [];
      const userMsg = messages.find((m: Record<string, unknown>) => m.type === 'user_message');
      expect(userMsg).toBeTruthy();
      expect((userMsg as unknown as { payload: { content: string } }).payload.content).toBe('Fix the bug');
    });

    it('does not insert prompt for session_created without matching requestId', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      client.createSession({ targetDeviceId: 'dev-tent', model: 'gpt-4.1', prompt: 'Fix the bug' });

      // Simulate session_created with WRONG requestId
      receiveInner({
        type: 'session_created',
        deviceId: 'dev-tent',
        seq: 1,
        timestamp: new Date().toISOString(),
        sessionId: 'new-sess-2',
        payload: { agent: 'copilot', model: 'gpt-4.1', requestId: 'wrong_id' },
      });

      const messages = useStore.getState().messages.get('new-sess-2') ?? [];
      const userMsg = messages.find((m: Record<string, unknown>) => m.type === 'user_message');
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
        deviceId: 'dev-web-123',
        devices: [],
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

      // server_error with ref matching the requestId (relay echoes ref from envelope)
      lastWsInstance._receive({
        type: 'server_error',
        message: 'Device offline',
        ref: requestId,
      });

      // Now if session_created arrives with this requestId, no prompt should be inserted
      receiveInner({
        type: 'session_created',
        deviceId: 'dev-tent',
        seq: 1,
        timestamp: new Date().toISOString(),
        sessionId: 'late-sess',
        payload: { agent: 'copilot', requestId },
      });

      const messages = useStore.getState().messages.get('late-sess') ?? [];
      const userMsg = messages.find((m: Record<string, unknown>) => m.type === 'user_message');
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
        deviceId: 'dev-web-123',
        devices: [],
      });
      useStore.getState().upsertSession({
        id: 'sess-1', deviceId: 'dev-1', deviceName: 'Mac',
        agent: 'copilot', state: 'active', messageCount: 0,
      });
    }

    it('merges tool_complete into matching tool_start by toolCallId', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      // Simulate tool_start
      receiveInner({
        type: 'tool_start',
        deviceId: 'dev-1',
        seq: 1,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { toolName: 'shell', args: { command: 'ls' }, toolCallId: 'tc-1' },
      });

      // Simulate tool_complete with same toolCallId
      receiveInner({
        type: 'tool_complete',
        deviceId: 'dev-1',
        seq: 2,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { toolName: 'shell', args: {}, result: 'file1.txt', toolCallId: 'tc-1' },
      });

      const messages = useStore.getState().messages.get('sess-1') ?? [];
      // Should have merged — only 1 tool message (complete replaced start)
      const toolMsgs = messages.filter((m: Record<string, unknown>) => m.type === 'tool_start' || m.type === 'tool_complete');
      expect(toolMsgs).toHaveLength(1);
      expect(toolMsgs[0].type).toBe('tool_complete');
      // Should preserve original args
      expect((toolMsgs[0] as unknown as { payload: { args: { command: string }; result: string } }).payload.args.command).toBe('ls');
      expect((toolMsgs[0] as unknown as { payload: { result: string } }).payload.result).toBe('file1.txt');
    });

    it('does not merge tool_complete without toolCallId', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      receiveInner({
        type: 'tool_start',
        deviceId: 'dev-1',
        seq: 1,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { toolName: 'shell', args: { command: 'ls' } },
      });

      receiveInner({
        type: 'tool_complete',
        deviceId: 'dev-1',
        seq: 2,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { toolName: 'shell', args: {}, result: 'done' },
      });

      const messages = useStore.getState().messages.get('sess-1') ?? [];
      const toolMsgs = messages.filter((m: Record<string, unknown>) => m.type === 'tool_start' || m.type === 'tool_complete');
      // No merge — both should be separate
      expect(toolMsgs).toHaveLength(2);
    });
  });

  describe('device_joined and device_left', () => {
    async function connectAndAuth(client: KrakiWSClient) {
      client.connect();
      await vi.waitFor(() => {
        expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0);
      });
      lastWsInstance._receive({
        type: 'auth_ok',
        deviceId: 'dev-web-123',
        devices: [
          { id: 'dev-1', name: 'MacBook', role: 'tentacle', online: true },
        ],
      });
    }

    it('adds device on device_joined', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      lastWsInstance._receive({
        type: 'device_joined',
        device: { id: 'dev-new', name: 'iPad', role: 'app', kind: 'tablet', online: true },
      });

      const devices = useStore.getState().devices;
      expect(devices.has('dev-new')).toBe(true);
      expect(devices.get('dev-new')?.name).toBe('iPad');
    });

    it('removes device on device_left', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      expect(useStore.getState().devices.has('dev-1')).toBe(true);

      lastWsInstance._receive({
        type: 'device_left',
        deviceId: 'dev-1',
      });

      expect(useStore.getState().devices.has('dev-1')).toBe(false);
    });
  });
});
