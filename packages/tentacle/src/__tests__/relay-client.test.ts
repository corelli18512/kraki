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
  };
}

function createSessionManager(): Record<string, unknown> {
  return {
    getResumableSessions: vi.fn(() => []),
    resumeSession: vi.fn(() => null),
    createSession: vi.fn(),
    endSession: vi.fn(),
    markDisconnected: vi.fn(),
    updateContext: vi.fn(),
    getContext: vi.fn(() => null),
    setTitle: vi.fn(),
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
