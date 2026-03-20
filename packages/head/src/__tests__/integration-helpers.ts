/**
 * Integration test helpers.
 * Spins up a real head server and provides WebSocket clients
 * that act as mock tentacles and apps.
 */

import { createServer, type Server } from 'http';
import { WebSocket } from 'ws';
import { Storage } from '../storage.js';
import { ChannelManager } from '../channel-manager.js';
import { Router } from '../router.js';
import { HeadServer } from '../server.js';
import { OpenAuthProvider } from '../auth.js';

import type { AuthProvider } from '../auth.js';

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

export interface MockDevice {
  ws: WebSocket;
  deviceId: string;
  channel: string;
  /** All messages received (raw parsed JSON) */
  messages: any[];
  /** Wait for a message of a specific type */
  waitFor: (type: string, timeout?: number) => Promise<any>;
  /** Wait for N messages of a specific type */
  waitForN: (type: string, count: number, timeout?: number) => Promise<any[]>;
  /** Send a raw message */
  send: (msg: Record<string, unknown>) => void;
  /** Close the connection */
  close: () => void;
}

export async function connectDevice(
  port: number,
  name: string,
  role: 'tentacle' | 'app',
  options?: { kind?: string; token?: string; deviceId?: string },
): Promise<MockDevice> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: any[] = [];
  const listeners = new Set<{ type: string; resolve: (msg: any) => void }>();

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    messages.push(msg);

    // Notify waiters
    for (const listener of listeners) {
      if (msg.type === listener.type) {
        listeners.delete(listener);
        listener.resolve(msg);
      }
    }
  });

  // Auth
  const authMsg: any = {
    type: 'auth',
    device: { name, role, kind: options?.kind, deviceId: options?.deviceId },
  };
  if (options?.token) authMsg.token = options.token;
  ws.send(JSON.stringify(authMsg));

  const authOk = await waitFor('auth_ok');

  function waitFor(type: string, timeout = 5000): Promise<any> {
    // Check already received (track consumed indices)
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].type === type && !messages[i]._consumed) {
        messages[i]._consumed = true;
        return Promise.resolve(messages[i]);
      }
    }

    return new Promise((resolve, reject) => {
      const listener = { type, resolve };
      listeners.add(listener);
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`Timeout waiting for message type "${type}" on device "${name}"`));
      }, timeout);
      const origResolve = listener.resolve;
      listener.resolve = (msg) => {
        msg._consumed = true;
        clearTimeout(timer);
        origResolve(msg);
      };
    });
  }

  async function waitForN(type: string, count: number, timeout = 5000): Promise<any[]> {
    const results: any[] = [];
    for (let i = 0; i < count; i++) {
      results.push(await waitFor(type, timeout));
    }
    return results;
  }

  return {
    ws,
    deviceId: authOk.deviceId,
    channel: authOk.channel,
    messages,
    waitFor,
    waitForN,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}
