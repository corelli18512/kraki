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
import type { AuthProvider, PushManager } from '@kraki/head';
import { SessionManager, RelayClient, KeyManager } from '@kraki/tentacle';
import type { AgentAdapter } from '@kraki/tentacle';
import {
  generateKeyPair, exportPublicKey, importPublicKey,
  encryptToBlob, decryptFromBlob, signChallenge,
} from '@kraki/crypto';
import type { KeyPair } from '@kraki/crypto';
import { Endpoint } from '@coinfra/pulse';
import { HEAD_PULSE_TARGET } from '@kraki/protocol';
import type { BlobPayload } from '@kraki/protocol';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Pulse framing helpers for the mock apps. Every real arm/tentacle speaks pulse
// unconditionally now, so a mock app must too: reliable producer messages arrive
// wrapped in a `pulse` frame (empty blob), and app→tentacle reliable sends go out
// as pulse frames the head hub fans out.
const pb64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
const punb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

/** A pulse endpoint for a mock app: drives HELLO on connect, decodes inbound
 *  pulse frames to their {blob,keys} payload, and frames outbound reliable sends.
 *  `onPayload` gets each delivered {blob,keys} JSON string for the app to decrypt. */
export function createPulseAppLayer(
  ws: WebSocket,
  onPayload: (payloadJson: string) => void,
): {
  onConnected: () => void;
  onRawFrame: (pulseB64: string) => void;
  sendReliable: (payloadJson: string, to: string) => void;
} {
  const endpoint = new Endpoint({
    epoch: `mockapp:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
    random: () => 0.5,
    durable: { supported: false },
  });
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let currentTo = '';

  function run(effects: ReturnType<Endpoint['onTick']>): void {
    for (const e of effects) {
      if (e.t === 'transmit') {
        ws.send(JSON.stringify({ type: 'unicast', to: currentTo, pulse: pb64(e.bytes), blob: '', keys: {} }));
      } else if (e.t === 'deliver') {
        onPayload(dec.decode(e.payload));
      }
    }
  }

  return {
    onConnected: () => run(endpoint.onConnected(Date.now())),
    onRawFrame: (pulseB64: string) => run(endpoint.onBytes(punb64(pulseB64), Date.now())),
    sendReliable: (payloadJson: string, to: string) => {
      currentTo = to;
      run(endpoint.send(enc.encode(payloadJson)).effects);
      currentTo = '';
    },
  };
}

/** Decode a pulse-delivered payload into the control message a real app would
 *  dispatch. A delivered payload is one of two shapes:
 *   - head-originated control: plaintext `{from:'@head', msg}` (device_joined/
 *     left/pending, preferences_updated, push acks). Head↔device control has no
 *     E2E — the app dispatches `msg` directly.
 *   - E2E producer message: `{blob, keys}` addressed to this device — decrypt to
 *     the inner message.
 *  Returns the message to dispatch, or null if the payload isn't for us. */
function decodePulsePayload(
  payloadJson: string,
  deviceId: string,
  privateKey: string,
): Record<string, unknown> | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Head-originated control frame — dispatch the inner message as-is.
  if (parsed.from === HEAD_PULSE_TARGET && parsed.msg) {
    return parsed.msg as Record<string, unknown>;
  }
  // Otherwise an E2E {blob,keys} envelope — decrypt for this device.
  try {
    const { blob, keys } = parsed as unknown as { blob: string; keys: Record<string, string> };
    const decrypted = decryptFromBlob({ blob, keys }, deviceId, privateKey);
    return JSON.parse(decrypted) as Record<string, unknown>;
  } catch {
    return null; // not for us
  }
}


export interface TestEnv {
  port: number;
  storage: Storage;
  head: HeadServer;
  httpServer: Server;
  /** Records every pushPreview the head fires at its push layer (offline
   *  notifications). Since the preview no longer reaches online apps on the
   *  wire, this is where tests observe it. */
  pushSpy: SpyPushManager;
  cleanup: () => Promise<void>;
}

/**
 * A stand-in PushManager that records every pushPreview handed to the push
 * layer instead of dispatching real notifications.
 *
 * The pushPreview now rides the SAME pulse envelope the tentacle sends to the
 * head. The head consumes that envelope (feeding the pulse hub) and fires the
 * preview at its push layer for OFFLINE devices via
 * `firePushPreview → pushManager.sendToOfflineDevices(userId, onlineDeviceIds,
 * pushPreview)`; it does NOT forward the preview to online apps. So an online
 * app never sees a standalone `{type:'broadcast', pushPreview}` on the wire —
 * the only surviving observation point is the PushManager. This spy captures
 * the `pushPreview` arg there. The preview is encrypted for every recipient
 * (including online apps), so a connected app's key still decrypts it.
 */
export interface SpyPushManager {
  /** Cast to inject as `HeadServerOptions.pushManager`. */
  manager: PushManager;
  /** pushPreview payloads captured by sendToOfflineDevices, in call order. */
  previews: BlobPayload[];
  /** Resolve once a captured preview satisfies `predicate` (default: any),
   *  polling until it lands or the timeout elapses. Undefined on timeout. */
  waitForPreview: (
    predicate?: (p: BlobPayload) => boolean,
    timeout?: number,
  ) => Promise<BlobPayload | undefined>;
}

export function createSpyPushManager(): SpyPushManager {
  const previews: BlobPayload[] = [];
  // The head calls getVapidPublicKey() (for auth_ok), sendToOfflineDevices()
  // (firePushPreview), and close() (shutdown). A real instance carries private
  // fields, so we structurally satisfy the used surface and cast.
  const manager = {
    sendToOfflineDevices(
      _userId: string,
      _onlineDeviceIds: string[],
      pushPreview: BlobPayload,
    ): Promise<void> {
      previews.push(pushPreview);
      return Promise.resolve();
    },
    getVapidPublicKey(): string | undefined {
      return undefined;
    },
    close(): void {},
  } as unknown as PushManager;

  async function waitForPreview(
    predicate: (p: BlobPayload) => boolean = () => true,
    timeout = 3000,
  ): Promise<BlobPayload | undefined> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = previews.find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    return previews.find(predicate);
  }

  return { manager, previews, waitForPreview };
}

export async function createTestEnv(options?: {
  authProvider?: AuthProvider;
}): Promise<TestEnv> {
  const storage = new Storage(':memory:');
  const pushSpy = createSpyPushManager();
  const head = new HeadServer(storage, {
    authProvider: options?.authProvider ?? new OpenAuthProvider(),
    pushManager: pushSpy.manager,
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

  return { port, storage, head, httpServer, pushSpy, cleanup };
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
 * Resolve the tentacle (daemon) device + its encryption key from an app's
 * auth_ok device roster.
 */
export function tentacleTarget(app: MockApp): { id: string; key: string } {
  const devs = (app.authOk.devices as Array<Record<string, unknown>>) ?? [];
  const t =
    devs.find((d) => d.role === 'tentacle') ??
    devs.find((d) => typeof d.name === 'string' && (d.name as string).includes('Daemon')) ??
    devs.find((d) => d.id !== app.deviceId && (d.encryptionKey || d.publicKey));
  if (!t) throw new Error(`tentacle device not in auth_ok: ${JSON.stringify(devs)}`);
  return { id: t.id as string, key: (t.encryptionKey ?? t.publicKey) as string };
}

/**
 * Send an app→tentacle session command (answer / set_session_mode / approve).
 *
 * These are NOT plain `app.send`: the head only routes encrypted `unicast`
 * envelopes to the tentacle, which decrypts and runs the inner ConsumerMessage.
 * A plain send of these types is silently dropped by the head. This mirrors the
 * real web arm's behavior exactly.
 */
export function sendToTentacle(app: MockApp, inner: Record<string, unknown>): void {
  const t = tentacleTarget(app);
  app.sendUnicast(t.id, inner, t.key);
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
    // Pulse-framed reliable message: decode the frame, then decrypt its payload.
    if ((raw.type === 'broadcast' || raw.type === 'unicast') && typeof raw.pulse === 'string') {
      pulse.onRawFrame(raw.pulse);
      return;
    }
    if (raw.type === 'auth_ok') {
      pulse.onConnected();
    }
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

  // Pulse layer: delivers decoded payloads → dispatch. A payload is either a
  // head-originated control message ({from:'@head', msg}) or an E2E {blob,keys}
  // envelope for this device; decodePulsePayload handles both.
  const pulse = createPulseAppLayer(ws, (payloadJson) => {
    const msg = decodePulsePayload(payloadJson, deviceId, kp.privateKey);
    if (!msg) return; // not for us
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
    // Reliable app→tentacle send goes through pulse (mirrors ArmPulse): the head
    // hub fans the frame out to the target tentacle, which decodes {blob,keys}.
    pulse.sendReliable(JSON.stringify({ blob, keys }), to);
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
    if ((raw.type === 'broadcast' || raw.type === 'unicast') && typeof raw.pulse === 'string') {
      pulse.onRawFrame(raw.pulse);
      return;
    }
    if (raw.type === 'auth_ok') {
      pulse.onConnected();
    }
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

  const pulse = createPulseAppLayer(ws, (payloadJson) => {
    const msg = decodePulsePayload(payloadJson, deviceId, opts.privateKey);
    if (!msg) return; // not for us
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
    // Reliable app→tentacle send goes through pulse (mirrors ArmPulse): the head
    // hub fans the frame out to the target tentacle, which decodes {blob,keys}.
    pulse.sendReliable(JSON.stringify({ blob, keys }), to);
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
