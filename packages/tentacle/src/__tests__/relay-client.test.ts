import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { RelayClient } from '../relay-client.js';

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
      appendMessage: vi.fn(() => 1),
      getSessionList: vi.fn(() => []),
      getMessagesAfterSeq: vi.fn(() => []),
    };
    const client = new RelayClient(adapter, sm, {
      relayUrl: 'ws://localhost:4000',
      authMethod: 'open',
      device: { name: 'Test', role: 'tentacle' },
      reconnectDelay: 10,
    });
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
    return { adapter, sm, client };
  }

  it('calls adapter.setSessionModel and sessionManager.setModel on set_session_model', () => {
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

    expect(adapter.setSessionModel).toHaveBeenCalledWith('sess_1', 'claude-opus-4', undefined);
    expect(sm.setModel).toHaveBeenCalledWith('sess_1', 'claude-opus-4');
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
    const sent = ws.sent.map(s => JSON.parse(s));
    const modelSet = sent.find(m => m.type === 'session_model_set');
    expect(modelSet).toBeDefined();
    expect(modelSet.payload.model).toBe('gpt-5');
    expect(modelSet.payload.reasoningEffort).toBe('high');
    expect(modelSet.sessionId).toBe('sess_1');
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

    const sent = ws.sent.map(s => JSON.parse(s));
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

    const sent = ws.sent.map(s => JSON.parse(s));
    const readMsg = sent.find(m => m.type === 'session_read');
    expect(readMsg).toBeDefined();
    expect(readMsg.payload.seq).toBe(42);
    expect(readMsg.sessionId).toBe('sess_1');
  });
});
