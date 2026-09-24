/**
 * Pulse per-hop END-TO-END — real head (pulse hub) + real tentacle RelayClient
 * (pulse) + a pulse-aware app. Proves the full chain:
 *
 *   tentacle ⇄(pulse)⇄ head(hub, SQLite) ⇄(pulse)⇄ app
 *
 * Unlike the pulse-package unit tests, this drives the REAL integrated wiring:
 * the envelope `pulse` field, head's PulseHub bridge + fan-out + durable store,
 * and the tentacle's TentaclePulse endpoint — over a real WebSocket + real E2E
 * crypto. It is the integration proof before the browser Playwright pass.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  decryptFromBlob,
  encryptToBlob,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  signChallenge,
  type KeyPair,
} from '@kraki/crypto';
import { Endpoint } from '@coinfra/pulse';
import { KeyManager, RelayClient, SessionManager } from '@kraki/tentacle';
import type { AgentAdapter } from '@kraki/tentacle';
import { createTestEnv, createTmpSessionDir, waitMs, type TestEnv } from './helpers.js';

// Minimal adapter that lets the test emit producer events on demand.
class EmitAdapter {
  onSessionCreated: ((e: { sessionId: string; agent: string; model?: string }) => void) | null = null;
  onMessage: ((sessionId: string, e: { content: string }) => void) | null = null;
  onMessageDelta: ((sessionId: string, e: { content: string }) => void) | null = null;
  onPermissionRequest: ((sessionId: string, e: { id: string; toolArgs: unknown; description: string }) => void) | null = null;
  onPermissionAutoResolved: ((sessionId: string, permissionId: string) => void) | null = null;
  onQuestionRequest: ((sessionId: string, e: { id: string; question: string }) => void) | null = null;
  onToolStart: ((sessionId: string, e: { toolName: string; args: Record<string, unknown> }) => void) | null = null;
  onToolComplete: ((sessionId: string, e: { toolName: string; result: string }) => void) | null = null;
  onIdle: ((sessionId: string) => void) | null = null;
  onError: ((sessionId: string, e: { message: string }) => void) | null = null;
  onSessionEnded: ((sessionId: string, e: { reason: string }) => void) | null = null;

  lastPermissionResponse: string | null = null;
  async start() {}
  async stop() {}
  async createSession(config?: { sessionId?: string }) {
    const sessionId = config?.sessionId ?? 'sess_1';
    this.onSessionCreated?.({ sessionId, agent: 'mock', model: 'mock-v1' });
    return { sessionId };
  }
  async resumeSession(sessionId: string) {
    this.onSessionCreated?.({ sessionId, agent: 'mock', model: 'mock-v1' });
    return { sessionId };
  }
  async sendMessage() {}
  async respondToPermission(_s: string, _id: string, resolution: string) {
    this.lastPermissionResponse = resolution;
  }
  async respondToQuestion() {}
  async killSession() {}
  async abortSession() {}
  listModels() { return []; }
  listModelDetails() { return []; }
}

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

/** A pulse-aware app: a real pulse Endpoint over the relay, mirroring ArmPulse.
 *  Receives tentacle→app producer messages reliably; can send app→tentacle. */
interface PulseApp {
  ws: WebSocket;
  deviceId: string;
  received: Record<string, unknown>[];
  sendReliable: (msg: Record<string, unknown>, tentacleId: string) => void;
  close: () => void;
}

async function connectPulseApp(
  port: number,
  options?: { keyPair?: KeyPair; deviceId?: string; epoch?: string; suppressHello?: boolean },
): Promise<PulseApp> {
  const kp: KeyPair = options?.keyPair ?? generateKeyPair();
  const deviceId = options?.deviceId ?? `app_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const compactPubKey = exportPublicKey(kp.publicKey);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: Record<string, unknown>[] = [];
  const endpoint = new Endpoint({
    epoch: options?.epoch ?? `app:${deviceId}`,
    random: () => 0.5,
    durable: { supported: false },
  });
  let currentTo = '';
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function run(effects: ReturnType<Endpoint['onTick']>): void {
    for (const e of effects) {
      if (e.t === 'transmit') {
        ws.send(JSON.stringify({ type: 'unicast', to: currentTo, pulse: b64(e.bytes), blob: '', keys: {} }));
      } else if (e.t === 'deliver') {
        // deliver payload = the JSON {blob, keys} → decrypt.
        try {
          const { blob, keys } = JSON.parse(dec.decode(e.payload)) as { blob: string; keys: Record<string, string> };
          const plaintext = decryptFromBlob({ blob, keys }, deviceId, kp.privateKey);
          received.push(JSON.parse(plaintext));
        } catch {
          /* not for us */
        }
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  ws.on('message', (data) => {
    const raw = JSON.parse(data.toString());
    if (raw.type === 'auth_challenge') {
      ws.send(JSON.stringify({ type: 'auth_response', deviceId, signature: signChallenge(raw.nonce, kp.privateKey) }));
      return;
    }
    if (raw.type === 'auth_ok') {
      const effects = endpoint.onConnected(Date.now());
      if (!options?.suppressHello) run(effects);
      return;
    }
    if ((raw.type === 'unicast' || raw.type === 'broadcast') && typeof raw.pulse === 'string') {
      run(endpoint.onBytes(unb64(raw.pulse), Date.now()));
    }
  });

  // Auth (open provider registers us with our pubkey).
  ws.send(JSON.stringify({
    type: 'auth',
    auth: { method: 'open' },
    device: { name: 'Pulse App', role: 'app', kind: 'web', deviceId, publicKey: compactPubKey },
  }));
  await waitMs(300);

  // Tick for heartbeat/liveness + resend.
  const tick = setInterval(() => run(endpoint.onTick(Date.now())), 200);

  return {
    ws,
    deviceId,
    received,
    sendReliable: (msg, tentacleId) => {
      const pub = appTentaclePubKeys.get(tentacleId);
      if (!pub) return;
      const { blob, keys } = encryptToBlob(JSON.stringify(msg), [{ deviceId: tentacleId, publicKey: pub }]);
      currentTo = tentacleId;
      run(endpoint.send(enc.encode(JSON.stringify({ blob, keys }))).effects);
    },
    close: () => { clearInterval(tick); ws.close(); },
  };
}

/** tentacleId → PEM pubkey, so the app can encrypt app→tentacle messages. */
const appTentaclePubKeys = new Map<string, string>();

describe('Pulse per-hop e2e: tentacle ⇄ head(hub) ⇄ app', () => {
  let env: TestEnv;
  let adapter: EmitAdapter;
  let sm: SessionManager;
  let km: KeyManager;
  let relay: RelayClient;
  let sessDir: { dir: string; cleanup: () => void };
  let kmDir: { dir: string; cleanup: () => void };
  let homeDir: { dir: string; cleanup: () => void };

  beforeEach(async () => {
    env = await createTestEnv();
    adapter = new EmitAdapter();
    sessDir = createTmpSessionDir();
    kmDir = createTmpSessionDir();
    homeDir = createTmpSessionDir();
    process.env.KRAKI_HOME = homeDir.dir;
    sm = new SessionManager(sessDir.dir);
    km = new KeyManager(kmDir.dir);
  });

  afterEach(async () => {
    relay?.disconnect();
    await env.cleanup();
    sessDir.cleanup();
    kmDir.cleanup();
    homeDir.cleanup();
    appTentaclePubKeys.clear();
  });

  async function connectTentacle(): Promise<void> {
    relay = new RelayClient(
      adapter as unknown as AgentAdapter,
      sm,
      { relayUrl: `ws://127.0.0.1:${env.port}`, device: { name: 'Pulse Laptop', role: 'tentacle', kind: 'desktop' } },
      km,
    );
    await new Promise<void>((resolve, reject) => {
      relay.onAuthenticated = () => resolve();
      relay.onFatalError = (m) => reject(new Error(m));
      relay.connect();
    });
    // Publish the tentacle's pubkey so the app can encrypt back to it.
    const info = relay.getAuthInfo()!;
    appTentaclePubKeys.set(info.deviceId, km.getKeyPair().publicKey);
  }

  it('delivers a reliable agent_message tentacle → head hub → app', async () => {
    const app = await connectPulseApp(env.port);
    await connectTentacle();
    await waitMs(400); // device_joined both ways + pulse handshakes

    adapter.onSessionCreated?.({ sessionId: 's1', agent: 'mock', model: 'm' });
    adapter.onMessage?.('s1', { content: 'hello via pulse' });

    const deadline = Date.now() + 5000;
    while (!app.received.some((m) => m.type === 'agent_message') && Date.now() < deadline) {
      await waitMs(50);
    }
    const got = app.received.filter((m) => m.type === 'agent_message');
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect((got[0]!.payload as Record<string, unknown>).content).toBe('hello via pulse');
    app.close();
  });

  it('does not replay an unacked live tail when a fresh App process replaces the old socket', async () => {
    const identity = {
      keyPair: generateKeyPair(),
      deviceId: `app-reconnect-${Date.now()}`,
    };
    const first = await connectPulseApp(env.port, {
      ...identity,
      epoch: 'app-process-1',
    });
    await connectTentacle();
    await waitMs(400);

    adapter.onSessionCreated?.({ sessionId: 's-preview', agent: 'mock', model: 'm' });
    adapter.onMessage?.('s-preview', { content: 'previous-process-tail' });

    const firstDeadline = Date.now() + 5_000;
    while (!first.received.some((message) => message.type === 'agent_message') && Date.now() < firstDeadline) {
      await waitMs(25);
    }
    expect(first.received.some((message) => message.type === 'agent_message')).toBe(true);

    // Do not close first: this exercises the same-device socket replacement
    // path, including the reconnect guard that suppresses the old close callback.
    // The first process has delivered the message but has not reached its 15 s
    // heartbeat ACK, so pre-fix Head replays that tail into the new epoch.
    const second = await connectPulseApp(env.port, {
      ...identity,
      epoch: 'app-process-2',
    });

    const authorityDeadline = Date.now() + 5_000;
    while (!second.received.some((message) => message.type === 'session_list') && Date.now() < authorityDeadline) {
      await waitMs(25);
    }

    expect(second.received.some((message) => message.type === 'session_list')).toBe(true);
    expect(second.received.some((message) => message.type === 'agent_message')).toBe(false);
    first.close();
    second.close();
  });

  it('fences encrypted data queued after auth when the prior socket never sent HELLO', async () => {
    const identity = { keyPair: generateKeyPair(), deviceId: `app-no-hello-${Date.now()}` };
    const first = await connectPulseApp(env.port, { ...identity, epoch: 'unseen-epoch', suppressHello: true });
    await connectTentacle();
    await waitMs(400);
    // Observe only sequence metadata, never inspect retained ciphertext.
    const hub = (env.head as unknown as {
      pulseHub: { devices: Map<string, { live: { sendSeqValue: bigint } }> };
    }).pulseHub;
    const live = hub.devices.get(identity.deviceId)!.live;
    const before = live.sendSeqValue;
    adapter.onSessionCreated?.({ sessionId: 's-prehello', agent: 'mock', model: 'm' });
    adapter.onMessage?.('s-prehello', { content: 'synthetic-prehello-tail' });
    const deadline = Date.now() + 5_000;
    while (live.sendSeqValue <= before + 1n && Date.now() < deadline) await waitMs(25);
    expect(live.sendSeqValue).toBeGreaterThan(before + 1n);
    expect(first.received).toEqual([]);

    const second = await connectPulseApp(env.port, { ...identity, epoch: 'fresh-epoch' });
    try {
      const authorityDeadline = Date.now() + 5_000;
      while (!second.received.some((m) => m.type === 'session_list') && Date.now() < authorityDeadline) {
        await waitMs(25);
      }
      expect(second.received.some((m) => m.type === 'session_list')).toBe(true);
      expect(second.received.some((m) => m.type === 'agent_message')).toBe(false);
    } finally {
      first.close();
      second.close();
    }
  });

  it('does not queue generic broadcasts produced while the App is offline', async () => {
    const app = await connectPulseApp(env.port);
    await connectTentacle();
    await waitMs(400);

    adapter.onMessage?.('s1', { content: 'msg-1' });
    await waitMs(300);
    expect(app.received.filter((m) => m.type === 'agent_message').length).toBe(1);

    // App drops; Tentacle keeps producing. Generic broadcasts target only Apps
    // that are online at send time, so these frames are not accumulated for a
    // later replay. Reconnect authorities recover current state instead.
    app.ws.close();
    await waitMs(200);
    adapter.onMessage?.('s1', { content: 'msg-2' });
    adapter.onMessage?.('s1', { content: 'msg-3' });
    await waitMs(200);

    expect(app.received.filter((m) => m.type === 'agent_message').length).toBe(1);
    app.close();
  });
});
