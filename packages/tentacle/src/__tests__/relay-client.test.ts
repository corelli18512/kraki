import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFrame } from '@coinfra/pulse';

const { sockets, MockSocket } = vi.hoisted(() => {
  const sockets: Array<{
    url: string;
    readyState: number;
    sent: string[];
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    send: (data: string) => void;
    close: () => void;
    emit: (event: string, ...args: unknown[]) => void;
  }> = [];

  class MockSocket {
    static OPEN = 1;

    readyState = MockSocket.OPEN;
    sent: string[] = [];
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(public url: string) {
      sockets.push(this);
    }

    on(event: string, cb: (...args: unknown[]) => void): void {
      const current = this.handlers.get(event) ?? [];
      current.push(cb);
      this.handlers.set(event, current);
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      this.readyState = 3;
      this.emit('close');
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }
  }

  return { sockets, MockSocket };
});

vi.mock('ws', () => ({
  WebSocket: MockSocket,
}));

vi.mock('../logger.js', () => ({
  createLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock crypto so tests can hand-craft "encrypted" envelopes without real keys.
// decryptFromBlob simply returns the blob string itself — tests treat the
// blob field as the raw plaintext JSON to inject. encryptToBlob mirrors it
// so outbound unicasts can be JSON.parsed straight out of `envelope.blob`.
vi.mock('@kraki/crypto', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@kraki/crypto');
  return {
    ...actual,
    decryptFromBlob: vi.fn((payload: { blob: string }) => payload.blob),
    encryptToBlob: vi.fn((plaintext: string) => ({ blob: plaintext, keys: {} })),
    importPublicKey: vi.fn(() => ({})),
  };
});

import { RelayClient } from '../relay-client.js';
import { AttachmentStore } from '../attachment-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Decode the messages a tentacle put on the wire. After the pulse migration,
 *  producer messages ride pulse frames ({type, pulse, blob:'', keys:{}}); this
 *  unwraps them back to the inner messages so tests can assert by type. Ignores
 *  non-data frames (hello/ack/heartbeat) and non-pulse envelopes. The crypto
 *  mock makes each frame payload `JSON.stringify({blob, keys})` where `blob` is
 *  the raw plaintext JSON of the message, so: decode frame → parse payload →
 *  `.blob` → parse = the inner message. Order is preserved. */
function decodePulseSends(sent: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of sent) {
    let env: Record<string, unknown>;
    try {
      env = JSON.parse(raw);
    } catch {
      continue;
    }
    // Non-pulse envelope (e.g. auth handshake) passes through unchanged.
    if (typeof env.pulse !== 'string') {
      out.push(env);
      continue;
    }
    const frame = decodeFrame(new Uint8Array(Buffer.from(env.pulse as string, 'base64')));
    if (!frame || frame.t !== 'data') continue;
    try {
      const { blob } = JSON.parse(new TextDecoder().decode(frame.payload)) as { blob: string };
      out.push(JSON.parse(blob) as Record<string, unknown>);
    } catch {
      /* skip frames whose payload isn't a {blob} message */
    }
  }
  return out;
}

function createAdapter(): Record<string, unknown> {
  return {
    onSessionCreated: null,
    onMessage: null,
    onMessageDelta: null,
    onPermissionRequest: null,
    onPermissionAutoResolved: null,
    onQuestionAutoResolved: null,
    onQuestionRequest: null,
    onToolStart: null,
    onToolComplete: null,
    onIdle: null,
    onError: null,
    onSessionEnded: null,
    onTitleChanged: null,
    onUsageUpdate: null,
    generateTitle: vi.fn(async () => null),
    setSessionMode: vi.fn(),
    getSessionUsage: vi.fn(() => null),
    setSessionUsage: vi.fn(),
    registerSessionAgent: vi.fn(),
  };
}

function createSessionManager(): Record<string, unknown> {
  return {
    getResumableSessions: vi.fn(() => []),
    resumeSession: vi.fn(() => null),
    createSession: vi.fn(),
    endSession: vi.fn(),
    markDisconnected: vi.fn(),
    markIdle: vi.fn(),
    markActive: vi.fn(),
    updateContext: vi.fn(),
    getContext: vi.fn(() => null),
    getMeta: vi.fn(() => null),
    setTitle: vi.fn(),
    setAutoTitle: vi.fn(),
    setMode: vi.fn(),
    deleteSession: vi.fn(),
    markRead: vi.fn(),
    getSessionList: vi.fn(() => []),
    getMessagesAfterSeq: vi.fn(() => []),
    appendMessage: vi.fn(() => 1),
    setUsage: vi.fn(),
    getAllLinks: vi.fn(() => []),
    getLink: vi.fn(() => null),
    removeLinkByKrakiId: vi.fn(),
  };
}

function createKeyManager(): Record<string, unknown> {
  return {
    getCompactPublicKey: vi.fn(() => 'pub-key'),
    getKeyPair: vi.fn(() => ({ privateKey: 'priv-key', publicKey: 'pub-key' })),
  };
}

describe('RelayClient auth negotiation', () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.useFakeTimers();
  });

  it('falls back from challenge to open auth when the relay does not know the device yet', async () => {
    const client = new RelayClient(
      createAdapter(),
      createSessionManager(),
      {
        relayUrl: 'ws://localhost:4000',
        authMethod: 'open',
        device: { name: 'Local Mac', role: 'tentacle', deviceId: 'dev_123' },
        reconnectDelay: 10,
      },
      createKeyManager(),
    );

    const fatal = vi.fn();
    client.onFatalError = fatal;

    client.connect();
    expect(sockets).toHaveLength(1);

    sockets[0].emit('open');
    const firstAuth = JSON.parse(sockets[0].sent[0]);
    expect(firstAuth.auth).toEqual({ method: 'challenge', deviceId: 'dev_123' });

    sockets[0].emit('message', Buffer.from(JSON.stringify({
      type: 'auth_error',
      code: 'unknown_device',
      message: 'Unknown device',
    })));
    await vi.advanceTimersByTimeAsync(20);

    expect(fatal).not.toHaveBeenCalled();
    expect(sockets.length).toBeGreaterThanOrEqual(2);

    const retrySocket = sockets.at(-1)!;
    retrySocket.emit('open');
    const retryAuth = JSON.parse(retrySocket.sent[0]);
    expect(retryAuth.auth).toEqual({ method: 'open' });
  });

  it('uses github_token auth when configured for GitHub', () => {
    const client = new RelayClient(
      createAdapter(),
      createSessionManager(),
      {
        relayUrl: 'ws://localhost:4000',
        authMethod: 'github_token',
        token: 'ghu_123',
        device: { name: 'Laptop', role: 'tentacle' },
        reconnectDelay: 10,
      },
      createKeyManager(),
    );

    client.connect();
    sockets[0].emit('open');

    const auth = JSON.parse(sockets[0].sent[0]);
    expect(auth.auth).toEqual({ method: 'github_token', token: 'ghu_123' });
  });

  it('maps channel-key auth to open auth with a shared key', () => {
    const client = new RelayClient(
      createAdapter(),
      createSessionManager(),
      {
        relayUrl: 'ws://localhost:4000',
        authMethod: 'channel-key',
        token: 'shared-secret',
        device: { name: 'Server', role: 'tentacle' },
        reconnectDelay: 10,
      },
      createKeyManager(),
    );

    client.connect();
    sockets[0].emit('open');

    const auth = JSON.parse(sockets[0].sent[0]);
    expect(auth.auth).toEqual({ method: 'open', sharedKey: 'shared-secret' });
  });

  it('follows wrong_region redirects without surfacing a fatal auth error', async () => {
    const client = new RelayClient(
      createAdapter(),
      createSessionManager(),
      {
        relayUrl: 'ws://localhost:4000',
        authMethod: 'open',
        device: { name: 'Local Mac', role: 'tentacle', deviceId: 'dev_123' },
        reconnectDelay: 10,
      },
      createKeyManager(),
    );

    const fatal = vi.fn();
    client.onFatalError = fatal;

    client.connect();
    sockets[0].emit('open');
    sockets[0].emit('message', Buffer.from(JSON.stringify({
      type: 'auth_error',
      code: 'wrong_region',
      message: 'Use the china relay',
      redirect: 'ws://cn.example.com',
    })));
    await vi.advanceTimersByTimeAsync(20);

    expect(fatal).not.toHaveBeenCalled();
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(sockets.at(-1)?.url).toBe('ws://cn.example.com');
  });
});

describe('RelayClient title generation', () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.useFakeTimers();
  });

  function connectClient() {
    const adapter = createAdapter();
    const sm = createSessionManager();
    const client = new RelayClient(
      adapter,
      sm,
      {
        relayUrl: 'ws://localhost:4000',
        authMethod: 'open',
        device: { name: 'Test', role: 'tentacle' },
        reconnectDelay: 10,
      },
      null, // no encryption for tests
    );
    client.connect();
    sockets[0].emit('open');
    // Complete auth
    sockets[0].emit('message', Buffer.from(JSON.stringify({
      type: 'auth_ok',
      deviceId: 'dev_1',
      authMethod: 'open',
      user: { id: 'u1', login: 'test', provider: 'local' },
      devices: [],
    })));
    return { adapter, sm, client };
  }

  it('triggers title generation on first idle', async () => {
    const { adapter, sm } = connectClient();
    const smMock = sm as Record<string, ReturnType<typeof vi.fn>>;
    smMock.getMeta.mockReturnValue({ id: 's1', state: 'idle' });
    smMock.getMessagesAfterSeq.mockReturnValue([
      { seq: 1, type: 'user_message', payload: JSON.stringify({ type: 'user_message', payload: { content: 'fix the login bug' } }), ts: '' },
    ]);
    (adapter.generateTitle as ReturnType<typeof vi.fn>).mockResolvedValue('Fix login authentication bug');

    // Fire idle
    const onIdle = adapter.onIdle as (sessionId: string) => void;
    onIdle('s1');
    await vi.advanceTimersByTimeAsync(1);

    expect(adapter.generateTitle).toHaveBeenCalledWith(
      expect.objectContaining({ lastUserMessage: 'fix the login bug' }),
    );
  });

  it('skips title generation when manual title is set', () => {
    const { adapter, sm } = connectClient();
    const smMock = sm as Record<string, ReturnType<typeof vi.fn>>;
    smMock.getMeta.mockReturnValue({ id: 's1', state: 'idle', title: 'My custom name' });

    const onIdle = adapter.onIdle as (sessionId: string) => void;
    onIdle('s1');

    expect(adapter.generateTitle).not.toHaveBeenCalled();
  });

  it('skips non-scheduled turns (turn 2-4)', () => {
    const { adapter, sm } = connectClient();
    const smMock = sm as Record<string, ReturnType<typeof vi.fn>>;
    smMock.getMeta.mockReturnValue({ id: 's1', state: 'idle' });
    smMock.getMessagesAfterSeq.mockReturnValue([
      { seq: 1, type: 'user_message', payload: JSON.stringify({ type: 'user_message', payload: { content: 'hello' } }), ts: '' },
    ]);
    (adapter.generateTitle as ReturnType<typeof vi.fn>).mockResolvedValue('Test title');

    const onIdle = adapter.onIdle as (sessionId: string) => void;
    onIdle('s1'); // turn 1 — should fire
    onIdle('s1'); // turn 2 — skip
    onIdle('s1'); // turn 3 — skip
    onIdle('s1'); // turn 4 — skip

    expect(adapter.generateTitle).toHaveBeenCalledTimes(1);
  });

  it('handles rename_session consumer message', () => {
    const { sm } = connectClient();
    const smMock = sm as Record<string, ReturnType<typeof vi.fn>>;
    smMock.getMeta.mockReturnValue({ id: 's1', title: 'New name', autoTitle: 'Auto' });

    const ws = sockets[0];
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'rename_session',
      sessionId: 's1',
      payload: { title: 'New name' },
    })));

    expect(smMock.setTitle).toHaveBeenCalledWith('s1', 'New name');
  });
});

describe('RelayClient set_session_model', () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.useFakeTimers();
  });

  function buildConnectedClient() {
    const adapter = {
      ...createAdapter(),
      setSessionModel: vi.fn(() => Promise.resolve()),
      setSessionMode: vi.fn(),
      sendMessage: vi.fn(() => Promise.resolve()),
      respondToPermission: vi.fn(() => Promise.resolve()),
      respondToQuestion: vi.fn(() => Promise.resolve()),
      killSession: vi.fn(() => Promise.resolve()),
      abortSession: vi.fn(() => Promise.resolve()),
      resumeSession: vi.fn(() => Promise.resolve({ sessionId: 'test' })),
      createSession: vi.fn(() => Promise.resolve({ sessionId: 'test' })),
      forkSession: vi.fn(() => Promise.resolve({ sessionId: 'test' })),
      listSessions: vi.fn(() => Promise.resolve([])),
      listModels: vi.fn(() => Promise.resolve([])),
      listModelDetails: vi.fn(() => Promise.resolve([])),
      start: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
    };
    const sm = {
      ...createSessionManager(),
      getMeta: vi.fn(() => ({ id: 'sess_1', model: 'old-model' })),
      setModel: vi.fn(),
      setPin: vi.fn(),
      setMode: vi.fn(),
      markIdle: vi.fn(),
      markActive: vi.fn(),
      markRead: vi.fn(),
      deleteSession: vi.fn(),
      removeLinkByKrakiId: vi.fn(),
      appendMessage: vi.fn(() => 1),
      getSessionList: vi.fn(() => []),
      getMessagesAfterSeq: vi.fn(() => []),
    };
    const client = new RelayClient(adapter, sm, {
      relayUrl: 'ws://localhost:4000',
      authMethod: 'open',
      device: { name: 'Test', role: 'tentacle' },
      reconnectDelay: 10,
    }, createKeyManager());
    client.connect();
    sockets[0].emit('open');
    // Complete auth so handleConsumerMessage can run
    sockets[0].emit('message', Buffer.from(JSON.stringify({
      type: 'auth_ok',
      deviceId: 'dev_1',
      authMethod: 'open',
      user: { id: 'u1', login: 'test', provider: 'open' },
      devices: [],
    })));
    // Register a consumer device so `consumerKeys` is populated — without it,
    // send() has no recipients and queues messages instead of putting them on
    // the wire (post-pulse-migration there is no plaintext fallback).
    sockets[0].emit('message', Buffer.from(JSON.stringify({
      type: 'device_joined',
      device: { id: 'consumer-dev', role: 'app', encryptionKey: 'consumer-pub' },
    })));
    return { adapter, sm, client };
  }

  it('calls adapter.setSessionModel and sessionManager.setModel on set_session_model', async () => {
    const { adapter, sm } = buildConnectedClient();
    const ws = sockets[0];

    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'set_session_model',
      sessionId: 'sess_1',
      deviceId: 'dev_1',
      seq: 1,
      timestamp: new Date().toISOString(),
      payload: { model: 'claude-opus-4' },
    })));

    // sessionManager.setModel is called synchronously (persist + ack first)
    expect(sm.setModel).toHaveBeenCalledWith('sess_1', 'claude-opus-4');
    // adapter.setSessionModel is chained behind ensureSessionResumed (which
    // resolves synchronously here because getMeta returns a non-disconnected
    // session, so the .then fires after a microtask).
    await vi.runAllTimersAsync();
    expect(adapter.setSessionModel).toHaveBeenCalledWith('sess_1', 'claude-opus-4', undefined, undefined);
  });

  it('broadcasts session_model_set after handling set_session_model', () => {
    buildConnectedClient();
    const ws = sockets[0];
    ws.sent.length = 0;

    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'set_session_model',
      sessionId: 'sess_1',
      deviceId: 'dev_1',
      seq: 1,
      timestamp: new Date().toISOString(),
      payload: { model: 'gpt-5', reasoningEffort: 'high' },
    })));

    // Find the session_model_set broadcast in sent messages
    const sent = decodePulseSends(ws.sent);
    const modelSet = sent.find(m => m.type === 'session_model_set');
    expect(modelSet).toBeDefined();
    expect(modelSet.payload.model).toBe('gpt-5');
    expect(modelSet.payload.reasoningEffort).toBe('high');
    expect(modelSet.sessionId).toBe('sess_1');
  });

  it('lazily resumes a disconnected session before delivering set_session_model', async () => {
    // Drive ensureSessionResumed through the disconnected → resumed path.
    const adapter = {
      onSessionEnded: undefined,
      sendMessage: vi.fn(() => Promise.resolve()),
      respondToPermission: vi.fn(() => Promise.resolve()),
      respondToQuestion: vi.fn(() => Promise.resolve()),
      killSession: vi.fn(() => Promise.resolve()),
      abortSession: vi.fn(() => Promise.resolve()),
      resumeSession: vi.fn(() => Promise.resolve({ sessionId: 'sess_d' })),
      createSession: vi.fn(() => Promise.resolve({ sessionId: 'sess_d' })),
      forkSession: vi.fn(() => Promise.resolve({ sessionId: 'sess_d' })),
      listSessions: vi.fn(() => Promise.resolve([])),
      listModels: vi.fn(() => Promise.resolve([])),
      listModelDetails: vi.fn(() => Promise.resolve([])),
      start: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
      setSessionModel: vi.fn(() => Promise.resolve()),
      setSessionMode: vi.fn(),
      setSessionUsage: vi.fn(),
      registerSessionAgent: vi.fn(),
    };
    const sm = {
      ...createSessionManager(),
      getMeta: vi.fn(() => ({ id: 'sess_d', state: 'disconnected', model: 'old', mode: 'execute', usage: { contextTokens: 100 } })),
      resumeSession: vi.fn(() => ({ runId: 'run_002', context: { summary: '', keyFiles: [], lastUserMessage: '', updatedAt: '' } })),
      setModel: vi.fn(),
      markDisconnected: vi.fn(),
      markIdle: vi.fn(),
      markActive: vi.fn(),
    };
    const client = new RelayClient(adapter as unknown as Parameters<typeof RelayClient>[0], sm as unknown as Parameters<typeof RelayClient>[1], {
      relayUrl: 'ws://localhost:4000',
      authMethod: 'open',
      device: { name: 'Test', role: 'tentacle' },
      reconnectDelay: 10,
    });
    client.connect();
    sockets[0].emit('open');
    sockets[0].emit('message', Buffer.from(JSON.stringify({
      type: 'auth_ok',
      deviceId: 'dev_1',
      authMethod: 'open',
      user: { id: 'u1', login: 'test', provider: 'open' },
      devices: [],
    })));

    sockets[0].emit('message', Buffer.from(JSON.stringify({
      type: 'set_session_model',
      sessionId: 'sess_d',
      deviceId: 'dev_1',
      seq: 1,
      timestamp: new Date().toISOString(),
      payload: { model: 'claude-opus-4' },
    })));

    // Persist + ack are synchronous.
    expect(sm.setModel).toHaveBeenCalledWith('sess_d', 'claude-opus-4');
    // The adapter call is chained behind ensureSessionResumed.
    await vi.runAllTimersAsync();
    expect(adapter.resumeSession).toHaveBeenCalledWith('sess_d', expect.anything());
    expect(adapter.setSessionModel).toHaveBeenCalledWith('sess_d', 'claude-opus-4', undefined, undefined);
  });

  it('de-duplicates concurrent lazy resumes for the same session (resume once, not twice)', async () => {
    // Two near-simultaneous send_input messages for the same disconnected
    // session must not trigger two SDK resumeSession calls.
    let inflight: ((v: { sessionId: string }) => void) | null = null;
    const resumePromise = new Promise<{ sessionId: string }>((resolve) => { inflight = resolve; });
    const adapter = {
      onSessionEnded: undefined,
      sendMessage: vi.fn(() => Promise.resolve()),
      respondToPermission: vi.fn(() => Promise.resolve()),
      respondToQuestion: vi.fn(() => Promise.resolve()),
      killSession: vi.fn(() => Promise.resolve()),
      abortSession: vi.fn(() => Promise.resolve()),
      resumeSession: vi.fn(() => resumePromise),
      createSession: vi.fn(() => Promise.resolve({ sessionId: 'sess_d' })),
      forkSession: vi.fn(() => Promise.resolve({ sessionId: 'sess_d' })),
      listSessions: vi.fn(() => Promise.resolve([])),
      listModels: vi.fn(() => Promise.resolve([])),
      listModelDetails: vi.fn(() => Promise.resolve([])),
      start: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
      setSessionMode: vi.fn(),
      setSessionUsage: vi.fn(),
      registerSessionAgent: vi.fn(),
    };
    const sm = {
      ...createSessionManager(),
      getMeta: vi.fn(() => ({ id: 'sess_d', state: 'disconnected' })),
      resumeSession: vi.fn(() => ({ runId: 'run_002', context: { summary: '', keyFiles: [], lastUserMessage: '', updatedAt: '' } })),
      markActive: vi.fn(),
      markIdle: vi.fn(),
    };
    const client = new RelayClient(adapter as unknown as Parameters<typeof RelayClient>[0], sm as unknown as Parameters<typeof RelayClient>[1], {
      relayUrl: 'ws://localhost:4000',
      authMethod: 'open',
      device: { name: 'Test', role: 'tentacle' },
      reconnectDelay: 10,
    });
    client.connect();
    sockets[0].emit('open');
    sockets[0].emit('message', Buffer.from(JSON.stringify({
      type: 'auth_ok',
      deviceId: 'dev_1',
      authMethod: 'open',
      user: { id: 'u1', login: 'test', provider: 'open' },
      devices: [],
    })));

    // Fire two send_inputs back-to-back for the same disconnected session
    for (let i = 0; i < 2; i++) {
      sockets[0].emit('message', Buffer.from(JSON.stringify({
        type: 'send_input',
        sessionId: 'sess_d',
        deviceId: 'dev_1',
        seq: i + 1,
        timestamp: new Date().toISOString(),
        payload: { text: `msg ${i}` },
      })));
    }

    // Let microtasks drain so both calls reach ensureSessionResumed.
    await Promise.resolve();
    await Promise.resolve();

    // Even though we fired two send_inputs, only ONE SDK resumeSession was made.
    expect(adapter.resumeSession).toHaveBeenCalledTimes(1);

    // Resolve the in-flight resume so subsequent test cleanup proceeds.
    inflight!({ sessionId: 'sess_d' });
    await vi.runAllTimersAsync();
  });

  it('send_input on disconnected session: ensureSessionResumed runs BEFORE markActive (regression for v0.21.1 state-race)', async () => {
    // Before the fix, markActive was called before ensureSessionResumed.
    // That flipped meta state from `disconnected` → `active`, defeating the
    // lazy-resume gate, so the session was never loaded and the very next
    // sendMessage call hit "Session not found" forever.
    const callOrder: string[] = [];
    const adapter = {
      onSessionEnded: undefined,
      sendMessage: vi.fn(() => { callOrder.push('sendMessage'); return Promise.resolve(); }),
      respondToPermission: vi.fn(() => Promise.resolve()),
      respondToQuestion: vi.fn(() => Promise.resolve()),
      killSession: vi.fn(() => Promise.resolve()),
      abortSession: vi.fn(() => Promise.resolve()),
      resumeSession: vi.fn(() => { callOrder.push('resumeSession'); return Promise.resolve({ sessionId: 'sess_d' }); }),
      createSession: vi.fn(() => Promise.resolve({ sessionId: 'sess_d' })),
      forkSession: vi.fn(() => Promise.resolve({ sessionId: 'sess_d' })),
      listSessions: vi.fn(() => Promise.resolve([])),
      listModels: vi.fn(() => Promise.resolve([])),
      listModelDetails: vi.fn(() => Promise.resolve([])),
      start: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
      setSessionMode: vi.fn(),
      setSessionUsage: vi.fn(),
      registerSessionAgent: vi.fn(),
    };
    const sm = {
      ...createSessionManager(),
      getMeta: vi.fn(() => ({ id: 'sess_d', state: 'disconnected' })),
      resumeSession: vi.fn(() => ({ runId: 'run_002', context: { summary: '', keyFiles: [], lastUserMessage: '', updatedAt: '' } })),
      markActive: vi.fn(() => { callOrder.push('markActive'); }),
      markIdle: vi.fn(),
      appendMessage: vi.fn(() => 1),
    };
    const client = new RelayClient(adapter as unknown as Parameters<typeof RelayClient>[0], sm as unknown as Parameters<typeof RelayClient>[1], {
      relayUrl: 'ws://localhost:4000',
      authMethod: 'open',
      device: { name: 'Test', role: 'tentacle' },
      reconnectDelay: 10,
    });
    client.connect();
    sockets[0].emit('open');
    sockets[0].emit('message', Buffer.from(JSON.stringify({
      type: 'auth_ok',
      deviceId: 'dev_1',
      authMethod: 'open',
      user: { id: 'u1', login: 'test', provider: 'open' },
      devices: [],
    })));

    sockets[0].emit('message', Buffer.from(JSON.stringify({
      type: 'send_input',
      sessionId: 'sess_d',
      deviceId: 'dev_1',
      seq: 1,
      timestamp: new Date().toISOString(),
      payload: { text: 'hi' },
    })));

    await vi.runAllTimersAsync();
    // resumeSession MUST come before markActive, and markActive before
    // sendMessage — otherwise the state-race bug returns.
    expect(callOrder).toEqual(['resumeSession', 'markActive', 'sendMessage']);
  });

  it('persists and broadcasts session_pinned on pin_session', () => {
    const { sm } = buildConnectedClient();
    const ws = sockets[0];
    ws.sent.length = 0;

    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'pin_session',
      sessionId: 'sess_1',
      deviceId: 'dev_1',
      seq: 1,
      timestamp: new Date().toISOString(),
      payload: { pinned: true },
    })));

    expect(sm.setPin).toHaveBeenCalledWith('sess_1', true);

    const sent = decodePulseSends(ws.sent);
    const pinned = sent.find(m => m.type === 'session_pinned');
    expect(pinned).toBeDefined();
    expect(pinned.payload.pinned).toBe(true);
    expect(pinned.sessionId).toBe('sess_1');
  });

  it('broadcasts session_read on mark_read', () => {
    const { sm } = buildConnectedClient();
    const ws = sockets[0];
    ws.sent.length = 0;

    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'mark_read',
      sessionId: 'sess_1',
      deviceId: 'dev_1',
      seq: 1,
      timestamp: new Date().toISOString(),
      payload: { seq: 42 },
    })));

    expect(sm.markRead).toHaveBeenCalledWith('sess_1', 42);

    const sent = decodePulseSends(ws.sent);
    const readMsg = sent.find(m => m.type === 'session_read');
    expect(readMsg).toBeDefined();
    expect(readMsg.payload.seq).toBe(42);
    expect(readMsg.sessionId).toBe('sess_1');
  });

  it('delete_session removes from sessionManager SYNCHRONOUSLY before any awaits', () => {
    // Regression for: pre-fix, session removal happened in adapter.killSession()'s
    // .finally(), so a broadcastSessionList fired immediately after would still see
    // the session and broadcast it back to arms. After the fix, deletion is
    // synchronous; the async killSession runs in the background.
    const { adapter, sm } = buildConnectedClient();
    const ws = sockets[0];
    ws.sent.length = 0;

    // Adapter's killSession returns a Promise that NEVER resolves — to prove
    // we don't depend on it.
    adapter.killSession = vi.fn(() => new Promise<void>(() => {}));

    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'delete_session',
      sessionId: 'sess_1',
      deviceId: 'dev_app',
      seq: 1,
      timestamp: new Date().toISOString(),
      payload: {},
    })));

    // SYNCHRONOUSLY: sessionManager state was cleaned up.
    expect(sm.deleteSession).toHaveBeenCalledWith('sess_1');
    expect(sm.removeLinkByKrakiId).toHaveBeenCalledWith('sess_1');

    // SYNCHRONOUSLY: session_deleted broadcast was sent.
    const sent = decodePulseSends(ws.sent);
    const deletedMsg = sent.find((m: { type: string }) => m.type === 'session_deleted');
    expect(deletedMsg).toBeDefined();
    expect(deletedMsg.sessionId).toBe('sess_1');

    // killSession was kicked off but we didn't wait for it.
    expect(adapter.killSession).toHaveBeenCalledWith('sess_1');
  });

  it('delete_session is robust to adapter.killSession failure', () => {
    const { adapter, sm } = buildConnectedClient();
    const ws = sockets[0];

    // Adapter rejects — but our local cleanup already ran, so this should
    // not affect the observable side effects.
    adapter.killSession = vi.fn(() => Promise.reject(new Error('adapter exploded')));

    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'delete_session',
      sessionId: 'sess_doomed',
      deviceId: 'dev_app',
      seq: 1,
      timestamp: new Date().toISOString(),
      payload: {},
    })));

    expect(sm.deleteSession).toHaveBeenCalledWith('sess_doomed');
    const sent = decodePulseSends(ws.sent);
    const deletedMsg = sent.find((m: { type: string }) => m.type === 'session_deleted');
    expect(deletedMsg).toBeDefined();
  });
});

describe('RelayClient tool message lazy-load shape', () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.useFakeTimers();
  });

  function buildClientWithStore() {
    const tmp = mkdtempSync(join(tmpdir(), 'kraki-lazy-test-'));
    const store = new AttachmentStore(tmp);

    const adapter = createAdapter();
    const sm = createSessionManager();
    // A keyManager makes producer messages ride encrypted pulse frames; the
    // wire shape is then read back via decodePulseSends (see helper up top).
    const client = new RelayClient(adapter, sm, {
      relayUrl: 'ws://localhost:4000',
      authMethod: 'open',
      device: { name: 'Test', role: 'tentacle' },
      reconnectDelay: 10,
    }, createKeyManager(), store);
    client.connect();
    sockets[0].emit('open');
    sockets[0].emit('message', Buffer.from(JSON.stringify({
      type: 'auth_ok',
      deviceId: 'dev_t',
      authMethod: 'open',
      user: { id: 'u1', login: 'test', provider: 'open' },
      devices: [],
    })));
    // Register a consumer device so `consumerKeys` is populated — otherwise
    // send() has no recipients and queues messages instead of putting them on
    // the wire.
    sockets[0].emit('message', Buffer.from(JSON.stringify({
      type: 'device_joined',
      device: { id: 'consumer-dev', role: 'app', encryptionKey: 'consumer-pub' },
    })));
    return { adapter, sm, client, ws: sockets[0], store, tmp, cleanup: () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } } };
  }

  it('tool_start carries headline + argsRef (when args ≥ floor), no inline args', () => {
    const { adapter, ws, cleanup } = buildClientWithStore();
    try {
      ws.sent.length = 0;
      const bigArgs = { command: 'echo ' + 'x'.repeat(400) };
      (adapter.onToolStart as ((sid: string, e: Record<string, unknown>) => void))('sess_1', {
        toolName: 'bash',
        args: bigArgs,
        toolCallId: 'tc1',
      });
      const start = decodePulseSends(ws.sent).find(m => m.type === 'tool_start');
      expect(start).toBeDefined();
      expect(start.payload.toolName).toBe('bash');
      expect(start.payload.headline).toMatch(/^\$ echo/);
      expect(start.payload.args).toBeUndefined();
      expect(start.payload.argsRef).toBeDefined();
      expect(start.payload.argsRef.mimeType).toBe('application/json');
      expect(start.payload.argsRef.size).toBeGreaterThan(256);
    } finally { cleanup(); }
  });

  it('tool_start with tiny args has headline and inline args but NO argsRef (below floor)', () => {
    const { adapter, ws, cleanup } = buildClientWithStore();
    try {
      ws.sent.length = 0;
      (adapter.onToolStart as ((sid: string, e: Record<string, unknown>) => void))('sess_1', {
        toolName: 'view',
        args: { path: '/foo.ts' },
        toolCallId: 'tc1',
      });
      const start = decodePulseSends(ws.sent).find(m => m.type === 'tool_start');
      expect(start.payload.headline).toBe('/foo.ts');
      expect(start.payload.argsRef).toBeUndefined();
      expect(start.payload.args).toEqual({ path: '/foo.ts' });
    } finally { cleanup(); }
  });

  it('tool_complete always ships resultRef (even tiny results) and no inline result', () => {
    const { adapter, ws, cleanup } = buildClientWithStore();
    try {
      ws.sent.length = 0;
      (adapter.onToolComplete as ((sid: string, e: Record<string, unknown>) => void))('sess_1', {
        toolName: 'bash',
        result: 'ok',
        toolCallId: 'tc1',
      });
      const complete = decodePulseSends(ws.sent).find(m => m.type === 'tool_complete');
      expect(complete.payload.toolName).toBe('bash');
      expect(complete.payload.result).toBeUndefined();
      expect(complete.payload.resultRef).toBeDefined();
      expect(complete.payload.resultRef.mimeType).toBe('text/plain');
      expect(complete.payload.resultRef.size).toBe(2);
    } finally { cleanup(); }
  });

  it('tool_complete pushes attachment_data chunks for resultRef after the message', () => {
    const { adapter, ws, cleanup } = buildClientWithStore();
    try {
      ws.sent.length = 0;
      (adapter.onToolComplete as ((sid: string, e: Record<string, unknown>) => void))('sess_1', {
        toolName: 'bash',
        result: 'hello world',
        toolCallId: 'tc1',
      });
      const sent = decodePulseSends(ws.sent);
      const completeIdx = sent.findIndex(m => m.type === 'tool_complete');
      const chunkIdx = sent.findIndex(m => m.type === 'attachment_data');
      expect(completeIdx).toBeGreaterThanOrEqual(0);
      expect(chunkIdx).toBeGreaterThanOrEqual(0);
      // Chunks ride after the tool_complete in send order
      expect(chunkIdx).toBeGreaterThan(completeIdx);
      const chunk = sent[chunkIdx];
      expect(chunk.payload.mimeType).toBe('text/plain');
      expect(Buffer.from(chunk.payload.data, 'base64').toString('utf-8')).toBe('hello world');
    } finally { cleanup(); }
  });

  it('tool_complete with no result has no resultRef', () => {
    const { adapter, ws, cleanup } = buildClientWithStore();
    try {
      ws.sent.length = 0;
      (adapter.onToolComplete as ((sid: string, e: Record<string, unknown>) => void))('sess_1', {
        toolName: 'noop',
        result: '',
        toolCallId: 'tc1',
      });
      const complete = decodePulseSends(ws.sent).find(m => m.type === 'tool_complete');
      expect(complete.payload.resultRef).toBeUndefined();
    } finally { cleanup(); }
  });

  it('purges lastArgs* + broadcastedAttachmentIds when a session ends with in-flight tool calls', () => {
    const { adapter, client, cleanup } = buildClientWithStore();
    try {
      const bigArgs = { command: 'echo ' + 'x'.repeat(400) };
      // Two tool_starts that never get a matching tool_complete (mimics
      // session being killed mid-tool).
      (adapter.onToolStart as ((sid: string, e: Record<string, unknown>) => void))('sess_1', {
        toolName: 'bash', args: bigArgs, toolCallId: 'leak-1',
      });
      (adapter.onToolStart as ((sid: string, e: Record<string, unknown>) => void))('sess_1', {
        toolName: 'bash', args: bigArgs, toolCallId: 'leak-2',
      });
      const c = client as unknown as {
        lastArgsByToolCallId: Map<string, unknown>;
        lastArgsRefByToolCallId: Map<string, unknown>;
        sessionToolCallIds: Map<string, Set<string>>;
        broadcastedAttachmentIds: Map<string, Set<string>>;
      };
      expect(c.lastArgsByToolCallId.size).toBe(2);
      expect(c.lastArgsRefByToolCallId.size).toBe(2);
      expect(c.sessionToolCallIds.get('sess_1')?.size).toBe(2);
      expect(c.broadcastedAttachmentIds.has('sess_1')).toBe(true);

      // Session ends.
      (adapter.onSessionEnded as ((sid: string, e: { reason: string }) => void))('sess_1', { reason: 'killed' });

      expect(c.lastArgsByToolCallId.size).toBe(0);
      expect(c.lastArgsRefByToolCallId.size).toBe(0);
      expect(c.sessionToolCallIds.has('sess_1')).toBe(false);
      expect(c.broadcastedAttachmentIds.has('sess_1')).toBe(false);
    } finally { cleanup(); }
  });
});

describe('RelayClient delta debounce', () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.useFakeTimers();
  });

  function connectClient() {
    const adapter = createAdapter();
    const sm = createSessionManager();
    const client = new RelayClient(
      adapter,
      sm,
      {
        relayUrl: 'ws://localhost:4000',
        authMethod: 'open',
        device: { name: 'Test', role: 'tentacle' },
        reconnectDelay: 10,
      },
      createKeyManager(),
    );
    client.connect();
    sockets[0].emit('open');
    sockets[0].emit('message', Buffer.from(JSON.stringify({
      type: 'auth_ok',
      deviceId: 'dev_1',
      authMethod: 'open',
      user: { id: 'u1', login: 'test', provider: 'local' },
      devices: [],
    })));
    // Register a consumer device so `consumerKeys` is populated — otherwise
    // send() has no recipients and queues deltas instead of putting the merged
    // pulse frame on the wire.
    sockets[0].emit('message', Buffer.from(JSON.stringify({
      type: 'device_joined',
      device: { id: 'consumer-dev', role: 'app', encryptionKey: 'consumer-pub' },
    })));
    sockets[0].sent.length = 0;
    return { adapter, sm, client };
  }

  it('coalesces a burst of agent_message_delta into one merged send after the debounce window', () => {
    const { adapter } = connectClient();
    const onDelta = adapter.onMessageDelta as (sid: string, e: { content: string }) => void;

    onDelta('s1', { content: 'Hel' });
    onDelta('s1', { content: 'lo, ' });
    onDelta('s1', { content: 'world!' });

    // Nothing on the wire yet — buffered.
    expect(decodePulseSends(sockets[0].sent).filter(m => m.type === 'agent_message_delta')).toHaveLength(0);

    vi.advanceTimersByTime(40);

    const deltas = decodePulseSends(sockets[0].sent)
      .filter(m => m.type === 'agent_message_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].payload.content).toBe('Hello, world!');
    expect(deltas[0].sessionId).toBe('s1');
  });

  it('flushes pending deltas before a non-delta message for the same session', () => {
    const { adapter } = connectClient();
    const onDelta = adapter.onMessageDelta as (sid: string, e: { content: string }) => void;
    const onMessage = adapter.onMessage as (sid: string, e: { content: string }) => void;

    onDelta('s1', { content: 'streaming ' });
    onDelta('s1', { content: 'text' });
    // Final message arrives before the timer fires — must trigger a sync flush.
    onMessage('s1', { content: 'final reply' });

    const decoded = decodePulseSends(sockets[0].sent);
    const types = decoded.map(m => m.type);
    const deltaIdx = types.indexOf('agent_message_delta');
    const finalIdx = types.indexOf('agent_message');
    expect(deltaIdx).toBeGreaterThanOrEqual(0);
    expect(finalIdx).toBeGreaterThan(deltaIdx);

    const delta = decoded[deltaIdx];
    expect(delta.payload.content).toBe('streaming text');
  });

  it('keeps separate buffers per session', () => {
    const { adapter } = connectClient();
    const onDelta = adapter.onMessageDelta as (sid: string, e: { content: string }) => void;

    onDelta('s1', { content: 'a' });
    onDelta('s2', { content: 'b' });
    onDelta('s1', { content: 'a' });

    vi.advanceTimersByTime(40);

    const deltas = decodePulseSends(sockets[0].sent)
      .filter(m => m.type === 'agent_message_delta');
    const bySession = new Map(deltas.map(d => [d.sessionId, d.payload.content]));
    expect(bySession.get('s1')).toBe('aa');
    expect(bySession.get('s2')).toBe('b');
  });

  it('disconnect() clears pending delta timers', () => {
    const { adapter, client } = connectClient();
    const onDelta = adapter.onMessageDelta as (sid: string, e: { content: string }) => void;
    onDelta('s1', { content: 'pending' });

    const c = client as unknown as { deltaBuffers: Map<string, unknown> };
    expect(c.deltaBuffers.size).toBe(1);

    client.disconnect();

    expect(c.deltaBuffers.size).toBe(0);
    // No socket traffic for the cleared delta after timer would have fired.
    vi.advanceTimersByTime(50);
    const deltasAfter = sockets[0].sent
      .map(s => JSON.parse(s))
      .filter(m => m.type === 'agent_message_delta');
    expect(deltasAfter).toHaveLength(0);
  });
});

describe('RelayClient handleSessionMessagesRange', () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.useFakeTimers();
  });

  type RangeBatch = {
    type: 'session_messages_range_batch';
    payload: {
      sessionId: string;
      messages: Array<Record<string, unknown>>;
      firstSeq: number;
      lastSeq: number;
      truncated: boolean;
    };
  };

  /** Build a `LoggedMessage`-shaped entry from a partial. */
  function entry(seq: number, type = 'agent_message', payload: Record<string, unknown> = {}): {
    seq: number;
    type: string;
    payload: string;
    ts: string;
  } {
    return {
      seq,
      type,
      payload: JSON.stringify({ type, payload, ...payload }),
      ts: '2026-01-01T00:00:00Z',
    };
  }

  /**
   * Stand up a connected RelayClient with the consumer device already
   * registered (so `consumerKeys` is populated and outbound unicasts succeed).
   * Returns helpers to inject a range request and read back the resulting batch.
   */
  function connectWithConsumer() {
    const adapter = createAdapter();
    const sm = createSessionManager();
    const keyManager = {
      getCompactPublicKey: vi.fn(() => 'tentacle-pub'),
      getKeyPair: vi.fn(() => ({ privateKey: 'tentacle-priv', publicKey: 'tentacle-pub' })),
    };
    const client = new RelayClient(
      adapter,
      sm,
      {
        relayUrl: 'ws://localhost:4000',
        authMethod: 'open',
        device: { name: 'Test', role: 'tentacle', deviceId: 'tentacle-dev' },
        reconnectDelay: 10,
      },
      keyManager,
    );
    client.connect();
    const ws = sockets[0];
    ws.emit('open');
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'auth_ok',
      deviceId: 'tentacle-dev',
      authMethod: 'open',
      user: { id: 'u1', login: 'test', provider: 'local' },
      devices: [],
    })));
    // Register a consumer device — this is what populates `consumerKeys`.
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'device_joined',
      device: { id: 'consumer-dev', role: 'app', encryptionKey: 'consumer-pub' },
    })));

    /** Inject a `request_session_messages_range` from the consumer. */
    function sendRangeRequest(sessionId: string, fromSeq: number, toSeq: number): void {
      ws.sent.length = 0;
      const inner = JSON.stringify({
        type: 'request_session_messages_range',
        deviceId: 'consumer-dev',
        seq: 1,
        timestamp: new Date().toISOString(),
        payload: { sessionId, fromSeq, toSeq },
      });
      ws.emit('message', Buffer.from(JSON.stringify({
        type: 'unicast',
        to: 'tentacle-dev',
        blob: inner,
        keys: {},
      })));
    }

    /** Find the single range-batch reply produced by the last request.
     *  Per-app replies now ride pulse: the unicast envelope carries a `pulse`
     *  frame (empty blob). Decode each captured frame at the wire level and read
     *  the DATA frames' payloads. Each payload is `JSON.stringify({blob, keys})`;
     *  the crypto mock makes `blob` the raw plaintext message JSON (see the
     *  encryptToBlob/decryptFromBlob mocks above). */
    function lastRangeBatch(): RangeBatch | undefined {
      let found: RangeBatch | undefined;
      for (const raw of ws.sent) {
        const env = JSON.parse(raw);
        if (env.type !== 'unicast' || env.to !== 'consumer-dev' || typeof env.pulse !== 'string') continue;
        const frame = decodeFrame(new Uint8Array(Buffer.from(env.pulse as string, 'base64')));
        if (!frame || frame.t !== 'data') continue;
        const { blob } = JSON.parse(new TextDecoder().decode(frame.payload)) as { blob: string };
        const inner = JSON.parse(blob);
        if (inner.type === 'session_messages_range_batch') found = inner as RangeBatch;
      }
      return found;
    }

    return { adapter, sm, client, ws, sendRangeRequest, lastRangeBatch };
  }

  it('returns the requested inclusive seq range', () => {
    const { sm, sendRangeRequest, lastRangeBatch } = connectWithConsumer();
    const smMock = sm as Record<string, ReturnType<typeof vi.fn>>;
    smMock.getMeta.mockReturnValue({ id: 's1', lastSeq: 100 });
    // getMessagesAfterSeq is called with `lo - 1`; return seqs 5..10 so the
    // hi-side filter `e.seq <= 10` keeps all of them.
    smMock.getMessagesAfterSeq.mockReturnValue([
      entry(5), entry(6), entry(7), entry(8), entry(9), entry(10),
    ]);

    sendRangeRequest('s1', 5, 10);
    const batch = lastRangeBatch();

    expect(smMock.getMessagesAfterSeq).toHaveBeenCalledWith('s1', 4);
    expect(batch).toBeDefined();
    expect(batch!.payload.sessionId).toBe('s1');
    expect(batch!.payload.messages.map(m => m.seq)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(batch!.payload.firstSeq).toBe(5);
    expect(batch!.payload.lastSeq).toBe(10);
    expect(batch!.payload.truncated).toBe(false);
  });

  it('drops entries past the requested toSeq', () => {
    const { sm, sendRangeRequest, lastRangeBatch } = connectWithConsumer();
    const smMock = sm as Record<string, ReturnType<typeof vi.fn>>;
    smMock.getMeta.mockReturnValue({ id: 's1', lastSeq: 100 });
    smMock.getMessagesAfterSeq.mockReturnValue([
      entry(5), entry(6), entry(7), entry(8), entry(9), entry(10),
    ]);

    sendRangeRequest('s1', 5, 7);
    const batch = lastRangeBatch()!;

    expect(batch.payload.messages.map(m => m.seq)).toEqual([5, 6, 7]);
    expect(batch.payload.lastSeq).toBe(7);
    expect(batch.payload.truncated).toBe(false);
  });

  it('clamps fromSeq below 1 up to 1', () => {
    const { sm, sendRangeRequest, lastRangeBatch } = connectWithConsumer();
    const smMock = sm as Record<string, ReturnType<typeof vi.fn>>;
    smMock.getMeta.mockReturnValue({ id: 's1', lastSeq: 100 });
    smMock.getMessagesAfterSeq.mockReturnValue([entry(1), entry(2), entry(3)]);

    sendRangeRequest('s1', -5, 3);

    expect(smMock.getMessagesAfterSeq).toHaveBeenCalledWith('s1', 0);
    const batch = lastRangeBatch()!;
    expect(batch.payload.firstSeq).toBe(1);
    expect(batch.payload.lastSeq).toBe(3);
    expect(batch.payload.truncated).toBe(false);
  });

  it('clamps toSeq above headSeq down to headSeq', () => {
    const { sm, sendRangeRequest, lastRangeBatch } = connectWithConsumer();
    const smMock = sm as Record<string, ReturnType<typeof vi.fn>>;
    smMock.getMeta.mockReturnValue({ id: 's1', lastSeq: 7 });
    smMock.getMessagesAfterSeq.mockReturnValue([
      entry(5), entry(6), entry(7),
    ]);

    sendRangeRequest('s1', 5, 9999);
    const batch = lastRangeBatch()!;

    expect(batch.payload.messages.map(m => m.seq)).toEqual([5, 6, 7]);
    expect(batch.payload.lastSeq).toBe(7);
    expect(batch.payload.truncated).toBe(false);
  });

  it('returns empty batch when session is unknown', () => {
    const { sm, sendRangeRequest, lastRangeBatch } = connectWithConsumer();
    const smMock = sm as Record<string, ReturnType<typeof vi.fn>>;
    smMock.getMeta.mockReturnValue(null);

    sendRangeRequest('missing', 1, 10);
    const batch = lastRangeBatch()!;

    expect(smMock.getMessagesAfterSeq).not.toHaveBeenCalled();
    expect(batch.payload.messages).toHaveLength(0);
    expect(batch.payload.firstSeq).toBe(0);
    expect(batch.payload.lastSeq).toBe(0);
    expect(batch.payload.truncated).toBe(false);
  });

  it('returns empty batch when fromSeq exceeds headSeq', () => {
    const { sm, sendRangeRequest, lastRangeBatch } = connectWithConsumer();
    const smMock = sm as Record<string, ReturnType<typeof vi.fn>>;
    smMock.getMeta.mockReturnValue({ id: 's1', lastSeq: 10 });

    sendRangeRequest('s1', 50, 100);
    const batch = lastRangeBatch()!;

    expect(batch.payload.messages).toHaveLength(0);
    expect(batch.payload.truncated).toBe(false);
  });

  it('returns empty batch when fromSeq > toSeq after clamping', () => {
    const { sm, sendRangeRequest, lastRangeBatch } = connectWithConsumer();
    const smMock = sm as Record<string, ReturnType<typeof vi.fn>>;
    smMock.getMeta.mockReturnValue({ id: 's1', lastSeq: 100 });

    sendRangeRequest('s1', 30, 20);
    const batch = lastRangeBatch()!;

    expect(batch.payload.messages).toHaveLength(0);
    expect(batch.payload.truncated).toBe(false);
  });

  it('returns empty batch for NaN / non-finite inputs', () => {
    const { sm, sendRangeRequest, lastRangeBatch } = connectWithConsumer();
    const smMock = sm as Record<string, ReturnType<typeof vi.fn>>;
    smMock.getMeta.mockReturnValue({ id: 's1', lastSeq: 100 });

    sendRangeRequest('s1', Number.NaN, 10);
    const batch = lastRangeBatch()!;

    expect(batch.payload.messages).toHaveLength(0);
    expect(batch.payload.truncated).toBe(false);
  });

  it('truncates at the cap, keeping the newer end', () => {
    const { sm, sendRangeRequest, lastRangeBatch } = connectWithConsumer();
    const smMock = sm as Record<string, ReturnType<typeof vi.fn>>;
    smMock.getMeta.mockReturnValue({ id: 's1', lastSeq: 5000 });

    // Request 1..1000 (range = 1000 > cap 500). Handler should bump lo to
    // hi - 500 + 1 = 501. We assert getMessagesAfterSeq was called with 500.
    // Provide returned entries to span the kept range so the batch shape is
    // verifiable: 501..1000 (500 entries).
    const kept = Array.from({ length: 500 }, (_, i) => entry(501 + i));
    smMock.getMessagesAfterSeq.mockReturnValue(kept);

    sendRangeRequest('s1', 1, 1000);

    expect(smMock.getMessagesAfterSeq).toHaveBeenCalledWith('s1', 500);
    const batch = lastRangeBatch()!;
    expect(batch.payload.firstSeq).toBe(501);
    expect(batch.payload.lastSeq).toBe(1000);
    expect(batch.payload.messages).toHaveLength(500);
    expect(batch.payload.truncated).toBe(true);
  });

  it('does not truncate when range exactly equals the cap', () => {
    const { sm, sendRangeRequest, lastRangeBatch } = connectWithConsumer();
    const smMock = sm as Record<string, ReturnType<typeof vi.fn>>;
    smMock.getMeta.mockReturnValue({ id: 's1', lastSeq: 5000 });

    // Range = 500 exactly (1..500) — boundary case.
    const kept = Array.from({ length: 500 }, (_, i) => entry(1 + i));
    smMock.getMessagesAfterSeq.mockReturnValue(kept);

    sendRangeRequest('s1', 1, 500);

    expect(smMock.getMessagesAfterSeq).toHaveBeenCalledWith('s1', 0);
    const batch = lastRangeBatch()!;
    expect(batch.payload.messages).toHaveLength(500);
    expect(batch.payload.truncated).toBe(false);
  });

  it('filters out non-persistent types defensively', () => {
    const { sm, sendRangeRequest, lastRangeBatch } = connectWithConsumer();
    const smMock = sm as Record<string, ReturnType<typeof vi.fn>>;
    smMock.getMeta.mockReturnValue({ id: 's1', lastSeq: 100 });
    // Pretend an older log accidentally has a transient type with a seq —
    // the handler should skip it (parity with handleSessionMessages).
    smMock.getMessagesAfterSeq.mockReturnValue([
      entry(5, 'agent_message'),
      entry(6, 'agent_message_delta'), // transient — should be dropped
      entry(7, 'agent_message'),
    ]);

    sendRangeRequest('s1', 5, 7);
    const batch = lastRangeBatch()!;

    expect(batch.payload.messages.map(m => m.seq)).toEqual([5, 7]);
    // firstSeq / lastSeq reflect what's actually returned post-filter.
    expect(batch.payload.firstSeq).toBe(5);
    expect(batch.payload.lastSeq).toBe(7);
  });

  it('floors fractional seq inputs', () => {
    const { sm, sendRangeRequest, lastRangeBatch } = connectWithConsumer();
    const smMock = sm as Record<string, ReturnType<typeof vi.fn>>;
    smMock.getMeta.mockReturnValue({ id: 's1', lastSeq: 100 });
    smMock.getMessagesAfterSeq.mockReturnValue([entry(5), entry(6), entry(7)]);

    sendRangeRequest('s1', 5.9, 7.9);

    // 5.9 → 5 (lo - 1 = 4), 7.9 → 7
    expect(smMock.getMessagesAfterSeq).toHaveBeenCalledWith('s1', 4);
    const batch = lastRangeBatch()!;
    expect(batch.payload.messages.map(m => m.seq)).toEqual([5, 6, 7]);
  });
});
