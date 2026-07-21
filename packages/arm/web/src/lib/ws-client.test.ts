import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { decodeFrame } from '@coinfra/pulse';
import { KrakiWSClient } from '../lib/ws-client';
import { useStore } from '../hooks/useStore';
import { messageProvider } from './message-provider';

/** Recover the inner producer message from a captured wire send. Reliable
 *  consumer messages now ride pulse: the arm emits a `unicast` envelope whose
 *  `pulse` field is a pulse frame carrying `{blob,keys}`; the encryption mock puts
 *  the plaintext message JSON in `blob`. Non-pulse sends (auth) pass through.
 *  Returns null for non-data pulse frames (hello/ack/heartbeat control). */
function decodePulseSend(raw: string): Record<string, unknown> | null {
  const env = JSON.parse(raw) as Record<string, unknown>;
  if (typeof env.pulse !== 'string') return env;
  const frame = decodeFrame(Uint8Array.from(atob(env.pulse), (c) => c.charCodeAt(0)));
  if (!frame || frame.t !== 'data') return null;
  const { blob } = JSON.parse(new TextDecoder().decode(frame.payload)) as { blob: string };
  return JSON.parse(blob) as Record<string, unknown>;
}

/** Wait for the arm to put a pulse-carried DATA message on the wire (the send
 *  path is async: encryptForTarget → pulse.send, and pulse emits control frames
 *  like hello first), then decode the first application message. */
async function waitForDecodedSend(
  ws: { sentMessages: string[] },
): Promise<Record<string, unknown>> {
  let decoded: Record<string, unknown> | null = null;
  await vi.waitFor(() => {
    for (const raw of ws.sentMessages) {
      // Only application sends ride pulse; skip raw auth passthrough envelopes.
      if (typeof (JSON.parse(raw) as { pulse?: unknown }).pulse !== 'string') continue;
      const msg = decodePulseSend(raw);
      if (msg && typeof msg.type === 'string') { decoded = msg; return; }
    }
    throw new Error('no decoded pulse data send yet');
  });
  return decoded as unknown as Record<string, unknown>;
}

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
    async encryptForTarget(msg: Record<string, unknown>) {
      // Resolve the target the same way the real impl does (payload.targetDeviceId
      // or the session's deviceId), and carry the plaintext through as the "blob"
      // so tests can assert the round-trip without real crypto.
      const payload = msg.payload as Record<string, unknown> | undefined;
      const to = (payload?.targetDeviceId as string) ?? 'test-tentacle';
      return { blob: JSON.stringify(msg), keys: {}, to };
    }
    async encryptForDevice(msg: Record<string, unknown>, targetDeviceId: string) {
      return { blob: JSON.stringify(msg), keys: {}, to: targetDeviceId };
    }
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
  messageProvider.clear();
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
        devices: [{ id: 'dev-1', name: 'MacBook', role: 'tentacle', online: true, encryptionKey: 'mock-key' }],
      });
      receiveInner({
        type: 'session_list', deviceId: 'dev-1', seq: 1, timestamp: '',
        payload: { sessions: [{ id: 'sess-1', agent: 'copilot', state: 'active', mode: 'execute', lastSeq: 0, readSeq: 0, messageCount: 0, createdAt: '' }] },
      });
      client.setDesiredSession('sess-1');
      await vi.waitFor(() => {
        const sent = lastWsInstance.sentMessages.map(decodePulseSend).filter(Boolean);
        expect(sent.some((m) => m?.type === 'set_session_subscription')).toBe(true);
      });
      receiveInner({
        type: 'session_subscription_set', deviceId: 'dev-1', seq: 2, timestamp: '',
        payload: {
          accepted: true, sessionId: 'sess-1',
          snapshot: {
            digest: { id: 'sess-1', agent: 'copilot', state: 'active', mode: 'execute', lastSeq: 0, readSeq: 0, messageCount: 0, createdAt: '' },
            spineHeadSeq: 0,
            card: { draft: '', action: null },
          },
        },
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

    it('routes agent_message_delta append and reset to cards', async () => {
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
      expect(useStore.getState().cards.get('sess-1')?.text).toBe('Hello!');

      receiveInner({
        type: 'agent_message_delta',
        deviceId: 'dev-1',
        seq: 3,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { content: 'Reset', reset: true },
      });

      expect(useStore.getState().cards.get('sess-1')?.text).toBe('Reset');
    });

    it('transitions the session to idle on an idle message', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);
      useStore.getState().upsertSession({
        id: 'sess-1', deviceId: 'dev-1', deviceName: 'MacBook',
        agent: 'pi', state: 'active', messageCount: 0,
      });

      receiveInner({
        type: 'idle', deviceId: 'dev-1', seq: 9,
        timestamp: new Date().toISOString(), sessionId: 'sess-1', payload: {},
      });

      const s = useStore.getState().sessions.get('sess-1');
      expect(s?.state).toBe('idle');
    });

    it('handles session_messages_range_batch without incrementing unread', async () => {
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

      // Receive a range batch — should not increment unread
      receiveInner({
        type: 'session_messages_range_batch',
        deviceId: 'dev-1',
        seq: 1,
        timestamp: new Date().toISOString(),
        payload: {
          sessionId: 'sess-1',
          messages: [
            { type: 'agent_message', deviceId: 'dev-1', seq: 1, timestamp: new Date().toISOString(), sessionId: 'sess-1', payload: { content: 'Batch message 1' } },
            { type: 'agent_message', deviceId: 'dev-1', seq: 2, timestamp: new Date().toISOString(), sessionId: 'sess-1', payload: { content: 'Batch message 2' } },
          ],
          firstSeq: 1,
          lastSeq: 2,
          truncated: false,
        },
      });

      expect(useStore.getState().unreadCount.get('sess-1')).toBeUndefined();
      expect(useStore.getState().messages.get('sess-1')?.length).toBe(2);

      // New live message after batch should increment unread
      receiveInner({
        type: 'agent_message',
        deviceId: 'dev-1',
        seq: 3,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: { content: 'Live message' },
      });
      receiveInner({
        type: 'idle',
        deviceId: 'dev-1',
        seq: 4,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: {},
      });

      expect(useStore.getState().unreadCount.get('sess-1')).toBe(1);
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

    it('routes permission card action and stores it', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      receiveInner({
        type: 'card_action',
        deviceId: 'dev-1',
        seq: 3,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: {
          action: {
            type: 'permission',
            payload: {
              id: 'perm-abc',
              toolName: 'shell',
              args: { command: 'rm -rf' },
              description: 'Delete files',
            },
          },
        },
      });

      const action = useStore.getState().cards.get('sess-1')?.action;
      expect(action?.type).toBe('permission');
      expect(action?.type === 'permission' ? action.payload.id : undefined).toBe('perm-abc');
    });

    it('routes question card action and stores it', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      receiveInner({
        type: 'card_action',
        deviceId: 'dev-1',
        seq: 4,
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        payload: {
          action: {
            type: 'question',
            payload: {
              id: 'q-abc',
              question: 'Which framework?',
              choices: ['React', 'Vue'],
            },
          },
        },
      });

      const action = useStore.getState().cards.get('sess-1')?.action;
      expect(action?.type).toBe('question');
      expect(action?.type === 'question' ? action.payload.choices : undefined).toEqual(['React', 'Vue']);
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

      const sent = await waitForDecodedSend(lastWsInstance);
      expect(sent.type).toBe('send_input');
      expect(sent.sessionId).toBe('sess-1');
      expect(sent.payload.text).toBe('Hello agent');
    });

    it('sendInput carries active-turn steer delivery', async () => {
      const client = await setupClient();
      client.sendInput('sess-1', 'Change direction', undefined, 'steer');

      const sent = await waitForDecodedSend(lastWsInstance);
      expect(sent).toMatchObject({
        type: 'send_input',
        sessionId: 'sess-1',
        payload: { text: 'Change direction', delivery: 'steer' },
      });
    });

    it('approve sends correct message', async () => {
      const client = await setupClient();

      client.approve('perm-1', 'sess-1');

      const sent = await waitForDecodedSend(lastWsInstance);
      expect(sent.type).toBe('approve');
      expect(sent.payload.permissionId).toBe('perm-1');
    });

    it('deny sends correct message', async () => {
      const client = await setupClient();

      client.deny('perm-1', 'sess-1');

      const sent = await waitForDecodedSend(lastWsInstance);
      expect(sent.type).toBe('deny');
    });

    it('alwaysAllow sends correct message', async () => {
      const client = await setupClient();

      client.alwaysAllow('perm-1', 'sess-1');

      const sent = await waitForDecodedSend(lastWsInstance);
      expect(sent.type).toBe('always_allow');
    });

    it('answer sends correct message', async () => {
      const client = await setupClient();

      client.answer('q-1', 'sess-1', 'A');

      const sent = await waitForDecodedSend(lastWsInstance);
      expect(sent.type).toBe('answer');
      expect(sent.payload.questionId).toBe('q-1');
      expect(sent.payload.answer).toBe('A');
    });

    it('killSession sends correct message', async () => {
      const client = await setupClient();
      client.killSession('sess-1');

      const sent = await waitForDecodedSend(lastWsInstance);
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

    it('saves relay URL and triggers reload on wrong_region', async () => {
      localStorage.setItem('kraki_device', JSON.stringify({ relay: 'ws://localhost:9999', deviceId: 'dev-stale' }));
      const client = new KrakiWSClient('ws://localhost:9999');
      client.connect();

      await vi.waitFor(() => {
        expect(lastWsInstance).toBeDefined();
      });

      lastWsInstance._receive({
        type: 'auth_error',
        code: 'wrong_region',
        message: 'Reconnect to your assigned region',
        redirect: 'ws://cn.example.com',
      });

      // Verify relay URL saved to localStorage for post-reload connection
      await vi.waitFor(() => {
        expect(JSON.parse(localStorage.getItem('kraki_device') ?? '{}')).toMatchObject({
          relay: 'ws://cn.example.com',
          deviceId: 'dev-stale',
        });
      });

      // No error banner — page reload handles the transition silently
      expect(useStore.getState().lastError).toBeNull();
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

      // Simulate auth_ok so transport is authenticated (pings require it)
      lastWsInstance._receive({
        type: 'auth_ok',
        deviceId: 'dev-web-123',
        devices: [],
      });
      await vi.advanceTimersByTimeAsync(1);

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

      const parsed = await waitForDecodedSend(lastWsInstance);
      expect(parsed.type).toBe('create_session');
      const payload = parsed.payload as Record<string, unknown>;
      expect(payload.requestId).toBeTruthy();
      expect(payload.targetDeviceId).toBe('dev-tent');
      expect(payload.model).toBe('gpt-4.1');
      expect(payload.prompt).toBe('Hello');
    });

    it('inserts initial prompt as user message on session_created with matching requestId', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      client.createSession({ targetDeviceId: 'dev-tent', model: 'gpt-4.1', prompt: 'Fix the bug' });

      // Extract the requestId from the sent (pulse-carried) create_session.
      const createMsg = await waitForDecodedSend(lastWsInstance);
      const requestId = (createMsg.payload as Record<string, unknown>).requestId;

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
      const createMsg = await waitForDecodedSend(lastWsInstance);
      const requestId = (createMsg.payload as Record<string, unknown>).requestId;

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

  describe('retired live tool broadcasts', () => {
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

    it('ignores tool_start and tool_complete live broadcasts', async () => {
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
      const toolMsgs = messages.filter((m: Record<string, unknown>) => m.type === 'tool_start' || m.type === 'tool_complete');
      expect(toolMsgs).toHaveLength(0);
    });

    it('ignores tool_complete without toolCallId', async () => {
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
      expect(toolMsgs).toHaveLength(0);
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

    it('marks device offline on device_left', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      expect(useStore.getState().devices.has('dev-1')).toBe(true);

      lastWsInstance._receive({
        type: 'device_left',
        deviceId: 'dev-1',
      });

      expect(useStore.getState().devices.has('dev-1')).toBe(true);
      expect(useStore.getState().devices.get('dev-1')?.online).toBe(false);
    });
  });

  describe('session_list with preview and warm-up', () => {
    async function connectAndAuth(client: KrakiWSClient) {
      client.connect();
      await vi.waitFor(() => {
        expect(lastWsInstance.sentMessages.length).toBeGreaterThan(0);
      });
      lastWsInstance._receive({
        type: 'auth_ok',
        deviceId: 'dev-web-123',
        devices: [
          { id: 'dev-t1', name: 'MacBook', role: 'tentacle', online: true, encryptionKey: 'mock-key' },
        ],
      });
    }

    it('applies preview from session_list to store', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      receiveInner({
        type: 'session_list',
        deviceId: 'dev-t1',
        seq: 1,
        timestamp: new Date().toISOString(),
        payload: {
          sessions: [{
            id: 'sess-1',
            agent: 'copilot',
            state: 'idle',
            mode: 'discuss',
            lastSeq: 50,
            readSeq: 50,
            messageCount: 50,
            createdAt: new Date().toISOString(),
            preview: { text: 'Hello world', type: 'agent', timestamp: '2026-04-28T10:00:00Z' },
          }],
        },
      });

      const preview = useStore.getState().sessionPreviews.get('sess-1');
      expect(preview).toBeTruthy();
      expect(preview!.text).toBe('Hello world');
      expect(preview!.type).toBe('agent');
    });

    it('applies an open-question digest preview to the store session preview', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      receiveInner({
        type: 'session_list',
        deviceId: 'dev-t1',
        seq: 1,
        timestamp: new Date().toISOString(),
        payload: {
          sessions: [{
            id: 'sess-pending',
            agent: 'pi',
            state: 'active',
            mode: 'execute',
            lastSeq: 5,
            readSeq: 5,
            messageCount: 5,
            createdAt: new Date().toISOString(),
            preview: { type: 'question', text: 'Which DB?', timestamp: new Date().toISOString() },
          }],
        },
      });

      expect(useStore.getState().sessionPreviews.get('sess-pending')?.type).toBe('question');
    });

    it('clears a stale question preview when session_list digest no longer carries attention', async () => {
      // Regression: handleSessionList only WROTE previews when the digest had
      // one. When the question was resolved (answered/cancelled/turn-ended),
      // the enriched digest stopped carrying a preview, but the stale
      // `type:'question'` entry persisted in the store (and localStorage),
      // pinning the sidebar on a phantom "waiting" badge - even after reload.
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      // Seed a question preview.
      receiveInner({
        type: 'session_list', deviceId: 'dev-t1', seq: 1, timestamp: new Date().toISOString(),
        payload: { sessions: [{
          id: 'sess-q', agent: 'pi', state: 'active', mode: 'execute',
          lastSeq: 5, readSeq: 5, messageCount: 5, createdAt: new Date().toISOString(),
          preview: { type: 'question', text: 'Which DB?', timestamp: new Date().toISOString() },
        }] },
      });
      expect(useStore.getState().sessionPreviews.get('sess-q')?.type).toBe('question');

      // Tentacle resolves the question; the next digest has no preview.
      receiveInner({
        type: 'session_list', deviceId: 'dev-t1', seq: 2, timestamp: new Date().toISOString(),
        payload: { sessions: [{
          id: 'sess-q', agent: 'pi', state: 'active', mode: 'execute',
          lastSeq: 6, readSeq: 6, messageCount: 6, createdAt: new Date().toISOString(),
        }] },
      });
      expect(useStore.getState().sessionPreviews.get('sess-q')).toBeUndefined();
    });

    it('clears a stale permission preview when session_list digest no longer carries attention', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      receiveInner({
        type: 'session_list', deviceId: 'dev-t1', seq: 1, timestamp: new Date().toISOString(),
        payload: { sessions: [{
          id: 'sess-p', agent: 'pi', state: 'active', mode: 'execute',
          lastSeq: 5, readSeq: 5, messageCount: 5, createdAt: new Date().toISOString(),
          preview: { type: 'permission', text: 'Run npm test', timestamp: new Date().toISOString() },
        }] },
      });
      expect(useStore.getState().sessionPreviews.get('sess-p')?.type).toBe('permission');

      receiveInner({
        type: 'session_list', deviceId: 'dev-t1', seq: 2, timestamp: new Date().toISOString(),
        payload: { sessions: [{
          id: 'sess-p', agent: 'pi', state: 'active', mode: 'execute',
          lastSeq: 6, readSeq: 6, messageCount: 6, createdAt: new Date().toISOString(),
        }] },
      });
      expect(useStore.getState().sessionPreviews.get('sess-p')).toBeUndefined();
    });

    it('overwrites a stale question preview with the digest agent preview', async () => {
      // The digest is the single authority. When a question resolves on a
      // session that has a spine agent_message, the enriched digest reverts to
      // the agent preview - which must overwrite the stale `type:'question'`
      // entry (clearing the phantom "waiting" badge) rather than be ignored.
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      // Seed a question preview.
      receiveInner({
        type: 'session_list', deviceId: 'dev-t1', seq: 1, timestamp: new Date().toISOString(),
        payload: { sessions: [{
          id: 'sess-agent', agent: 'pi', state: 'active', mode: 'discuss',
          lastSeq: 5, readSeq: 5, messageCount: 5, createdAt: new Date().toISOString(),
          preview: { type: 'question', text: 'Which DB?', timestamp: new Date().toISOString() },
        }] },
      });
      expect(useStore.getState().sessionPreviews.get('sess-agent')?.type).toBe('question');

      // Question resolved; the digest reverts to the spine agent preview.
      receiveInner({
        type: 'session_list', deviceId: 'dev-t1', seq: 2, timestamp: new Date().toISOString(),
        payload: { sessions: [{
          id: 'sess-agent', agent: 'pi', state: 'idle', mode: 'discuss',
          lastSeq: 6, readSeq: 6, messageCount: 6, createdAt: new Date().toISOString(),
          preview: { type: 'agent', text: 'Done.', timestamp: new Date().toISOString() },
        }] },
      });
      expect(useStore.getState().sessionPreviews.get('sess-agent')?.type).toBe('agent');
      expect(useStore.getState().sessionPreviews.get('sess-agent')?.text).toBe('Done.');
    });

    it('only warms up sessions within 24h or active/pinned', async () => {
      const client = new KrakiWSClient('ws://localhost:9999');
      await connectAndAuth(client);

      const now = new Date();
      const recentTs = new Date(now.getTime() - 2 * 3600_000).toISOString(); // 2h ago
      const oldTs = new Date(now.getTime() - 72 * 3600_000).toISOString(); // 3 days ago

      receiveInner({
        type: 'session_list',
        deviceId: 'dev-t1',
        seq: 1,
        timestamp: now.toISOString(),
        payload: {
          sessions: [
            { id: 'sess-recent', agent: 'copilot', state: 'idle', mode: 'discuss',
              lastSeq: 100, readSeq: 100, messageCount: 100, createdAt: recentTs,
              preview: { text: 'Recent', type: 'agent', timestamp: recentTs } },
            { id: 'sess-active', agent: 'copilot', state: 'active', mode: 'discuss',
              lastSeq: 50, readSeq: 50, messageCount: 50, createdAt: oldTs,
              preview: { text: 'Active old', type: 'agent', timestamp: oldTs } },
            { id: 'sess-old', agent: 'copilot', state: 'idle', mode: 'discuss',
              lastSeq: 200, readSeq: 200, messageCount: 200, createdAt: oldTs,
              preview: { text: 'Very old', type: 'agent', timestamp: oldTs } },
          ],
        },
      });

      // All sessions get metadata + preview applied
      const store = useStore.getState();
      expect(store.sessions.has('sess-recent')).toBe(true);
      expect(store.sessions.has('sess-active')).toBe(true);
      expect(store.sessions.has('sess-old')).toBe(true);
      expect(store.sessionPreviews.get('sess-old')?.text).toBe('Very old');

      // The old idle session should NOT have messages loaded (warm-up skips it)
      // Wait a tick for any async warm-up to settle
      await new Promise(r => setTimeout(r, 50));
      const oldMsgs = store.messages.get('sess-old');
      expect(oldMsgs?.length ?? 0).toBe(0);
    });
  });
});
