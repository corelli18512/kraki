/**
 * Real integration test helpers for thin relay protocol.
 * Spins up a real head server and provides crypto-aware test clients.
 *
 * The relay is a thin encrypted forwarder:
 * - Tentacle → apps via BroadcastEnvelope (encrypted blob)
 * - App → tentacle via UnicastEnvelope (encrypted blob with `to`)
 */
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { Storage, HeadServer, OpenAuthProvider } from '@kraki/head';
import type { AuthProvider } from '@kraki/head';
import { SessionManager, RelayClient, KeyManager } from '@kraki/tentacle';
import type { AgentAdapter } from '@kraki/tentacle';
import {
  generateKeyPair, exportPublicKey, importPublicKey,
  encryptToBlob, decryptFromBlob, signChallenge,
} from '@kraki/crypto';
import type { KeyPair } from '@kraki/crypto';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export interface TestEnv {
  port: number;
  storage: Storage;
  head: HeadServer;
  httpServer: Server;
  cleanup: () => Promise<void>;
}

export async function createTestEnv(options?: {
  authProvider?: AuthProvider;
}): Promise<TestEnv> {
  const storage = new Storage(':memory:');
  const head = new HeadServer(storage, {
    authProvider: options?.authProvider ?? new OpenAuthProvider(),
  });

  const httpServer = createServer();
  head.attach(httpServer);

  await new Promise<void>(resolve => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;

  const cleanup = async () => {
    head.close();
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    storage.close();
  };

  return { port, storage, head, httpServer, cleanup };
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
  keyManager?: KeyManager,
): RelayClient {
  return new RelayClient(adapter, sessionManager, {
    relayUrl: `ws://127.0.0.1:${port}`,
    device: { name, role: 'tentacle', kind: 'desktop' },
  }, keyManager);
}

export interface MockApp {
  ws: WebSocket;
  messages: Record<string, unknown>[];
  /** Raw envelopes before decryption (broadcast/unicast with blob, keys, pushPreview) */
  rawEnvelopes: Record<string, unknown>[];
  authOk: Record<string, unknown>;
  deviceId: string;
  keyPair: KeyPair;
  waitFor: (type: string, timeout?: number) => Promise<Record<string, unknown>>;
  waitForN: (type: string, count: number, timeout?: number) => Promise<Record<string, unknown>[]>;
  /** Send an encrypted unicast to a specific device. Pass recipientCompactPubKey if target isn't in auth_ok.devices. */
  sendUnicast: (to: string, msg: Record<string, unknown>, recipientCompactPubKey?: string) => void;
  send: (msg: Record<string, unknown>) => void;
  close: () => void;
}

/**
 * Connect a mock app client with E2E crypto support.
 * Generates a keypair, authenticates, and auto-decrypts broadcast/unicast envelopes.
 */
export async function connectApp(
  port: number,
  name: string = 'Test Phone',
  opts?: { token?: string; deviceId?: string },
): Promise<MockApp> {
  const kp = generateKeyPair();
  const deviceId = opts?.deviceId ?? `dev_app_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const compactPubKey = exportPublicKey(kp.publicKey);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: Record<string, unknown>[] = [];
  const rawEnvelopes: Record<string, unknown>[] = [];
  const listeners: Array<(msg: Record<string, unknown>) => void> = [];

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  ws.on('message', (data) => {
    const raw = JSON.parse(data.toString());
    let msg: Record<string, unknown>;
    if (raw.type === 'broadcast' || raw.type === 'unicast') {
      rawEnvelopes.push(raw);
      try {
        const decrypted = decryptFromBlob(
          { blob: raw.blob, keys: raw.keys },
          deviceId,
          kp.privateKey,
        );
        msg = JSON.parse(decrypted);
      } catch {
        return; // Can't decrypt — not for us
      }
    } else {
      msg = raw;
    }
    messages.push(msg);
    for (const l of listeners.slice()) l(msg);
  });

  // Auth
  const authMsg: Record<string, unknown> = {
    type: 'auth',
    auth: opts?.token
      ? { method: 'open', sharedKey: opts.token }
      : { method: 'open' },
    device: { name, role: 'app', kind: 'web', deviceId, publicKey: compactPubKey },
  };
  ws.send(JSON.stringify(authMsg));

  const authOk = await waitForType('auth_ok');

  function waitForType(type: string, timeout = 5000): Promise<Record<string, unknown>> {
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].type === type && !messages[i]._consumed) {
        messages[i]._consumed = true;
        return Promise.resolve(messages[i]);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
        reject(new Error(`Timeout waiting for "${type}" on "${name}"`));
      }, timeout);
      const listener = (msg: Record<string, unknown>) => {
        if (msg.type === type && !msg._consumed) {
          msg._consumed = true;
          clearTimeout(timer);
          const idx = listeners.indexOf(listener);
          if (idx !== -1) listeners.splice(idx, 1);
          resolve(msg);
        }
      };
      listeners.push(listener);
    });
  }

  async function waitForN(type: string, count: number, timeout = 5000): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i++) {
      results.push(await waitForType(type, timeout));
    }
    return results;
  }

  function sendUnicast(to: string, innerMsg: Record<string, unknown>, recipientCompactPubKey?: string): void {
    let compactKey = recipientCompactPubKey;
    if (!compactKey) {
      const device = authOk?.devices?.find((d: Record<string, unknown>) => d.id === to);
      compactKey = device?.encryptionKey ?? device?.publicKey;
    }
    if (!compactKey) throw new Error(`No encryption key for device ${to}`);
    const recipientPubKey = importPublicKey(compactKey);
    const { blob, keys } = encryptToBlob(JSON.stringify(innerMsg), [
      { deviceId: to, publicKey: recipientPubKey },
    ]);
    ws.send(JSON.stringify({ type: 'unicast', to, blob, keys }));
  }

  return {
    ws, messages, rawEnvelopes, authOk, deviceId, keyPair: kp,
    waitFor: waitForType,
    waitForN,
    sendUnicast,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}

/**
 * Connect an app with specific crypto keys (handles challenge-response auth).
 * Used for reconnecting a previously-paired device.
 */
export async function connectAppWithCrypto(
  port: number,
  opts: { name?: string; deviceId: string; publicKey: string; privateKey: string },
): Promise<MockApp> {
  const deviceId = opts.deviceId;
  const compactPubKey = exportPublicKey(opts.publicKey);
  const kp: KeyPair = { publicKey: opts.publicKey, privateKey: opts.privateKey };

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: Record<string, unknown>[] = [];
  const rawEnvelopes: Record<string, unknown>[] = [];
  const listeners: Array<(msg: Record<string, unknown>) => void> = [];

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  ws.on('message', (data) => {
    const raw = JSON.parse(data.toString());
    let msg: Record<string, unknown>;
    if (raw.type === 'broadcast' || raw.type === 'unicast') {
      rawEnvelopes.push(raw);
      try {
        const decrypted = decryptFromBlob(
          { blob: raw.blob, keys: raw.keys },
          deviceId,
          opts.privateKey,
        );
        msg = JSON.parse(decrypted);
      } catch {
        return;
      }
    } else {
      msg = raw;
    }
    messages.push(msg);
    for (const l of listeners.slice()) l(msg);
  });

  // Auth with challenge (reconnecting known device)
  ws.send(JSON.stringify({
    type: 'auth',
    auth: { method: 'challenge', deviceId },
    device: {
      name: opts.name ?? 'E2E App',
      role: 'app',
      kind: 'web',
      deviceId,
      publicKey: compactPubKey,
    },
  }));

  // Handle challenge-response if needed, wait for auth_ok
  let authOk: Record<string, unknown> | null = null;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Auth timeout')), 5000);
    const listener = (msg: Record<string, unknown>) => {
      if (msg.type === 'auth_ok') {
        authOk = msg;
        msg._consumed = true;
        clearTimeout(timer);
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
        resolve();
      } else if (msg.type === 'auth_challenge') {
        const signature = signChallenge(msg.nonce, opts.privateKey);
        ws.send(JSON.stringify({ type: 'auth_response', deviceId, signature }));
      } else if (msg.type === 'auth_error') {
        clearTimeout(timer);
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
        reject(new Error('Auth failed: ' + msg.message));
      }
    };
    listeners.push(listener);
  });

  function waitForType(type: string, timeout = 5000): Promise<Record<string, unknown>> {
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].type === type && !messages[i]._consumed) {
        messages[i]._consumed = true;
        return Promise.resolve(messages[i]);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
        reject(new Error(`Timeout waiting for "${type}"`));
      }, timeout);
      const listener = (msg: Record<string, unknown>) => {
        if (msg.type === type && !msg._consumed) {
          msg._consumed = true;
          clearTimeout(timer);
          const idx = listeners.indexOf(listener);
          if (idx !== -1) listeners.splice(idx, 1);
          resolve(msg);
        }
      };
      listeners.push(listener);
    });
  }

  async function waitForN(type: string, count: number, timeout = 5000): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i++) {
      results.push(await waitForType(type, timeout));
    }
    return results;
  }

  function sendUnicast(to: string, innerMsg: Record<string, unknown>, recipientCompactPubKey?: string): void {
    let compactKey = recipientCompactPubKey;
    if (!compactKey) {
      const device = authOk?.devices?.find((d: Record<string, unknown>) => d.id === to);
      compactKey = device?.encryptionKey ?? device?.publicKey;
    }
    if (!compactKey) throw new Error(`No encryption key for device ${to}`);
    const recipientPubKey = importPublicKey(compactKey);
    const { blob, keys } = encryptToBlob(JSON.stringify(innerMsg), [
      { deviceId: to, publicKey: recipientPubKey },
    ]);
    ws.send(JSON.stringify({ type: 'unicast', to, blob, keys }));
  }

  return {
    ws, messages, rawEnvelopes, authOk, deviceId, keyPair: kp,
    waitFor: waitForType,
    waitForN,
    sendUnicast,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}

export function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
