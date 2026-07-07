/**
 * Integration test helpers for the thin relay.
 * Spins up a real head server with mock WebSocket clients.
 */

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { decodeFrame } from '@coinfra/pulse';
import { HEAD_PULSE_TARGET } from '@kraki/protocol';
import { Storage } from '../storage.js';
import { HeadServer } from '../server.js';
import { OpenAuthProvider } from '../auth.js';
import type { AuthProvider } from '../auth.js';
import type { HeadServerOptions } from '../server.js';

/** Unwrap a head-originated pulse control frame back to its inner control
 *  message. Head→device control (device_joined/left/pending, preferences, push
 *  acks) now rides pulse: the wire carries a `unicast` envelope whose `pulse`
 *  frame wraps a plaintext `{from:'@head', msg}` payload. Returns the inner
 *  `msg` for such frames, the raw message unchanged for non-pulse envelopes
 *  (auth_ok, broadcast, …), or null for pulse control frames that aren't
 *  head-control (HELLO/ACK/heartbeat) — a real client hands those to its pulse
 *  layer, not its message handlers. */
function unwrapControlFrame(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof raw.pulse !== 'string') return raw;
  const frame = decodeFrame(new Uint8Array(Buffer.from(raw.pulse, 'base64')));
  if (frame?.t === 'data') {
    try {
      const inner = JSON.parse(new TextDecoder().decode(frame.payload)) as {
        from?: string; msg?: Record<string, unknown>;
      };
      if (inner.from === HEAD_PULSE_TARGET && inner.msg) return inner.msg;
    } catch { /* fall through */ }
  }
  return null;
}

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
  /** The full auth_ok message returned by the server (post-handshake). */
  authOk: Record<string, unknown>;
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
    const raw = JSON.parse(data.toString());
    // Head→device control (device_joined/left/pending, preferences, push acks)
    // now rides pulse: the wire carries a `unicast` envelope wrapping a plaintext
    // {from:'@head', msg} payload. Unwrap it back to `msg` so the mock's message
    // handlers see the control message, exactly as a real client's pulse layer
    // would deliver it. Non-head pulse frames (HELLO/ACK/heartbeat) unwrap to
    // null and are ignored — a bare mock has no pulse layer to hand them to.
    const msg = unwrapControlFrame(raw);
    if (msg === null) return;

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
    authOk,
    messages,
    waitFor,
    waitForN,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}
