/**
 * Integration test helpers for the thin relay.
 * Spins up a real head server with mock WebSocket clients.
 */

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { Storage } from '../storage.js';
import { HeadServer } from '../server.js';
import { OpenAuthProvider } from '../auth.js';
import type { AuthProvider } from '../auth.js';
import type { HeadServerOptions } from '../server.js';

export interface TestEnv {
  port: number;
  storage: Storage;
  server: HeadServer;
  httpServer: Server;
  cleanup: () => Promise<void>;
}

export async function createTestEnv(options?: Partial<HeadServerOptions>): Promise<TestEnv> {
  const storage = new Storage(':memory:');
  const server = new HeadServer(storage, {
    authProvider: new OpenAuthProvider(),
    ...options,
  });

  const httpServer = createServer();
  server.attach(httpServer);

  await new Promise<void>(resolve => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;

  const cleanup = async () => {
    server.close();
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    storage.close();
  };

  return { port, storage, server, httpServer, cleanup };
}

export interface MockDevice {
  ws: WebSocket;
  deviceId: string;
  /** All messages received (raw parsed JSON) */
  messages: Record<string, unknown>[];
  /** Wait for a message of a specific type */
  waitFor: (type: string, timeout?: number) => Promise<Record<string, unknown>>;
  /** Wait for N messages of a specific type */
  waitForN: (type: string, count: number, timeout?: number) => Promise<Record<string, unknown>[]>;
  /** Send a raw message */
  send: (msg: Record<string, unknown>) => void;
  /** Close the connection */
  close: () => void;
}

export async function connectDevice(
  port: number,
  name: string,
  role: 'tentacle' | 'app',
  options?: { kind?: string; token?: string; deviceId?: string; pairingToken?: string },
): Promise<MockDevice> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: Record<string, unknown>[] = [];
  const listeners = new Set<{ type: string; resolve: (msg: Record<string, unknown>) => void }>();

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    messages.push(msg);

    for (const listener of listeners) {
      if (msg.type === listener.type) {
        listeners.delete(listener);
        listener.resolve(msg);
      }
    }
  });

  const authMsg: Record<string, unknown> = {
    type: 'auth',
    auth: options?.pairingToken
      ? { method: 'pairing', token: options.pairingToken }
      : options?.token
        ? { method: 'open', sharedKey: options.token }
        : { method: 'open' },
    device: { name, role, kind: options?.kind, deviceId: options?.deviceId },
  };
  ws.send(JSON.stringify(authMsg));

  const authOk = await waitFor('auth_ok');

  function waitFor(type: string, timeout = 5000): Promise<Record<string, unknown>> {
    for (let i = 0; i < messages.length; i++) {
      if ((messages[i] as Record<string, unknown>).type === type && !(messages[i] as Record<string, unknown>)._consumed) {
        (messages[i] as Record<string, unknown>)._consumed = true;
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

  async function waitForN(type: string, count: number, timeout = 5000): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i++) {
      results.push(await waitFor(type, timeout));
    }
    return results;
  }

  return {
    ws,
    deviceId: authOk.deviceId,
    messages,
    waitFor,
    waitForN,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}
