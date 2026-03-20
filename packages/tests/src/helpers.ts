/**
 * Real integration test helpers.
 * Spins up a real head server and provides real tentacle components
 * + mock app WebSocket clients.
 */
import { createServer, type Server } from 'http';
import { WebSocket } from 'ws';
import { Storage, ChannelManager, Router, HeadServer, OpenAuthProvider } from 'kraki-relay';
import type { AuthProvider } from 'kraki-relay';
import { SessionManager, RelayClient } from 'kraki';
import type { AgentAdapter } from 'kraki';
import type { RelayClientOptions } from 'kraki';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export interface TestEnv {
  port: number;
  storage: Storage;
  cm: ChannelManager;
  router: Router;
  head: HeadServer;
  httpServer: Server;
  cleanup: () => Promise<void>;
}

export async function createTestEnv(options?: {
  authProvider?: AuthProvider;
  e2e?: boolean;
}): Promise<TestEnv> {
  const storage = new Storage(':memory:');
  const cm = new ChannelManager(storage);
  const router = new Router(cm);
  const head = new HeadServer(cm, router, {
    authProvider: options?.authProvider ?? new OpenAuthProvider(),
    e2e: options?.e2e ?? false,
    pingInterval: 0,
  });

  const httpServer = createServer();
  head.attach(httpServer);

  await new Promise<void>(resolve => httpServer.listen(0, resolve));
  const port = (httpServer.address() as any).port;

  const cleanup = async () => {
    head.close();
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    storage.close();
  };

  return { port, storage, cm, router, head, httpServer, cleanup };
}

export function createTmpSessionDir(): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `kraki-int-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true }); } catch {} } };
}

export function createRelayClient(
  adapter: AgentAdapter,
  sessionManager: SessionManager,
  port: number,
  name: string = 'Test Laptop',
): RelayClient {
  return new RelayClient(adapter, sessionManager, {
    relayUrl: `ws://127.0.0.1:${port}`,
    device: { name, role: 'tentacle', kind: 'desktop' },
  });
}

export interface MockApp {
  ws: WebSocket;
  messages: any[];
  waitFor: (type: string, timeout?: number) => Promise<any>;
  waitForN: (type: string, count: number, timeout?: number) => Promise<any[]>;
  send: (msg: Record<string, unknown>) => void;
  close: () => void;
}

export async function connectApp(port: number, name: string = 'Test Phone'): Promise<MockApp> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: any[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()));
  });

  // Auth
  ws.send(JSON.stringify({
    type: 'auth',
    device: { name, role: 'app', kind: 'web' },
  }));

  await waitForType('auth_ok');

  function waitForType(type: string, timeout = 5000): Promise<any> {
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].type === type && !messages[i]._consumed) {
        messages[i]._consumed = true;
        return Promise.resolve(messages[i]);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.off('message', handler); reject(new Error(`Timeout waiting for "${type}" on "${name}"`)); }, timeout);
      const handler = (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          ws.off('message', handler);
          clearTimeout(timer);
          msg._consumed = true;
          resolve(msg);
        }
      };
      ws.on('message', handler);
    });
  }

  async function waitForN(type: string, count: number, timeout = 5000): Promise<any[]> {
    const results: any[] = [];
    for (let i = 0; i < count; i++) {
      results.push(await waitForType(type, timeout));
    }
    return results;
  }

  return {
    ws, messages,
    waitFor: waitForType,
    waitForN,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}

export function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Connect an app with explicit deviceId and publicKey (for E2E tests).
 */
export async function connectAppWithKeys(
  port: number,
  opts: { name?: string; deviceId: string; publicKey: string },
): Promise<MockApp> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: any[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()));
  });

  ws.send(JSON.stringify({
    type: 'auth',
    device: {
      name: opts.name ?? 'E2E App',
      role: 'app',
      kind: 'web',
      deviceId: opts.deviceId,
      publicKey: opts.publicKey,
    },
  }));

  // Wait for auth_ok or auth_challenge
  const authMsg = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Auth timeout')), 5000);
    const handler = (data: any) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth_ok' || msg.type === 'auth_challenge' || msg.type === 'auth_error') {
        ws.off('message', handler);
        clearTimeout(timer);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    // Check backlog
    for (const m of messages) {
      if ((m.type === 'auth_ok' || m.type === 'auth_challenge' || m.type === 'auth_error') && !m._consumed) {
        m._consumed = true;
        clearTimeout(timer);
        resolve(m);
        break;
      }
    }
  });

  // Handle challenge-response if the head recognizes our deviceId
  if (authMsg.type === 'auth_challenge') {
    // Need privateKey to sign — caller must handle this or we skip
    // For tests: import signChallenge at call site
    throw new Error('Challenge-response required but not handled by connectAppWithKeys. Use connectAppWithCrypto instead.');
  }
  if (authMsg.type === 'auth_error') {
    throw new Error(`Auth failed: ${authMsg.message}`);
  }

  function waitForType(type: string, timeout = 5000): Promise<any> {
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].type === type && !messages[i]._consumed) {
        messages[i]._consumed = true;
        return Promise.resolve(messages[i]);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${type}"`)), timeout);
      const handler = (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          ws.off('message', handler);
          clearTimeout(timer);
          msg._consumed = true;
          resolve(msg);
        }
      };
      ws.on('message', handler);
    });
  }

  async function waitForN(type: string, count: number, timeout = 5000): Promise<any[]> {
    const results: any[] = [];
    for (let i = 0; i < count; i++) {
      results.push(await waitForType(type, timeout));
    }
    return results;
  }

  return {
    ws, messages,
    waitFor: waitForType,
    waitForN,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}

/**
 * Connect an app with full crypto support (handles challenge-response auth).
 */
export async function connectAppWithCrypto(
  port: number,
  opts: { name?: string; deviceId: string; publicKey: string; privateKey: string },
): Promise<MockApp> {
  const { signChallenge } = await import('@kraki/crypto');
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: any[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()));
  });

  ws.send(JSON.stringify({
    type: 'auth',
    device: {
      name: opts.name ?? 'E2E App',
      role: 'app',
      kind: 'web',
      deviceId: opts.deviceId,
      publicKey: opts.publicKey,
    },
  }));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Auth timeout')), 5000);
    const handler = (data: any) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth_ok') {
        ws.off('message', handler);
        clearTimeout(timer);
        msg._consumed = true;
        resolve();
      } else if (msg.type === 'auth_challenge') {
        const signature = signChallenge(msg.nonce, opts.privateKey);
        ws.send(JSON.stringify({ type: 'auth_response', deviceId: opts.deviceId, signature }));
      } else if (msg.type === 'auth_error') {
        ws.off('message', handler);
        clearTimeout(timer);
        reject(new Error('Auth failed: ' + msg.message));
      }
    };
    ws.on('message', handler);
  });

  function waitForType(type: string, timeout = 5000): Promise<any> {
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].type === type && !messages[i]._consumed) {
        messages[i]._consumed = true;
        return Promise.resolve(messages[i]);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.off('message', handler); reject(new Error('Timeout waiting for "' + type + '"')); }, timeout);
      const handler = (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          ws.off('message', handler);
          clearTimeout(timer);
          msg._consumed = true;
          resolve(msg);
        }
      };
      ws.on('message', handler);
    });
  }

  async function waitForN(type: string, count: number, timeout = 5000): Promise<any[]> {
    const results: any[] = [];
    for (let i = 0; i < count; i++) {
      results.push(await waitForType(type, timeout));
    }
    return results;
  }

  return {
    ws, messages,
    waitFor: waitForType,
    waitForN,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}
