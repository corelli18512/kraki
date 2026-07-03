/**
 * Pulse reliable-delivery integration — the real proof that @kraki/pulse, wired
 * into the real tentacle RelayClient and consumed by a real pulse Endpoint over
 * a real head relay, does not lose reliable messages across a disconnect.
 *
 * This is the end-to-end verification the whole pulse effort exists to earn:
 * the exact "agent keeps producing while the socket is down, arm must not end
 * with a hole" failure, driven against the integrated code (not the isolated
 * harness). Pulse is enabled via KRAKI_PULSE=1 for these tests only.
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
import { Endpoint, packPulsePlaintext, tryUnpackPulse } from '@kraki/pulse';
import { KeyManager, RelayClient, SessionManager } from '@kraki/tentacle';
import type { AgentAdapter } from '@kraki/tentacle';
import { createTestEnv, createTmpSessionDir, waitMs, type TestEnv } from './helpers.js';

// ── Minimal mock adapter: lets the test emit producer events on demand ──

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

  started = false;
  async start() { this.started = true; }
  async stop() { this.started = false; }
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
  async respondPermission() {}
  async respondQuestion() {}
  async killSession() {}
  async abortSession() {}
  listModels() { return []; }
  listModelDetails() { return []; }
}

// ── A pulse-aware consumer app: real Endpoint + real crypto over the relay ──

interface PulseApp {
  ws: WebSocket;
  deviceId: string;
  /** Reliable messages delivered in order by pulse. */
  delivered: Record<string, unknown>[];
  close: () => void;
}

async function connectPulseApp(port: number, tentacleDeviceIdRef: { id: string }): Promise<PulseApp> {
  const kp: KeyPair = generateKeyPair();
  const deviceId = `app_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const compactPubKey = exportPublicKey(kp.publicKey);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const delivered: Record<string, unknown>[] = [];
  // One Endpoint per tentacle device (keyed lazily; this test has one tentacle).
  const endpoints = new Map<string, Endpoint>();
  const now = () => Date.now();

  function ep(src: string): Endpoint {
    let e = endpoints.get(src);
    if (!e) {
      e = new Endpoint({ epoch: `${deviceId}:${src}:${Math.random().toString(36).slice(2, 8)}` });
      endpoints.set(src, e);
    }
    return e;
  }
  function runEffects(src: string, effects: ReturnType<Endpoint['onTick']>) {
    for (const eff of effects) {
      if (eff.t === 'transmit') {
        // Ack/resume frame back to the tentacle, encrypted for it.
        const tentaclePub = tentaclePubKey;
        if (tentaclePub) {
          const { blob, keys } = encryptToBlob(
            packPulsePlaintext(deviceId, eff.bytes),
            [{ deviceId: tentacleDeviceIdRef.id, publicKey: tentaclePub }],
          );
          ws.send(JSON.stringify({ type: 'unicast', to: tentacleDeviceIdRef.id, blob, keys }));
        }
      } else if (eff.t === 'deliver') {
        delivered.push(JSON.parse(new TextDecoder().decode(eff.payload)));
      }
    }
  }

  let tentaclePubKey: string | null = null;

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  ws.on('message', (data) => {
    const raw = JSON.parse(data.toString());
    if (raw.type === 'auth_ok') {
      // Learn the tentacle's public key from the device list for ack encryption.
      for (const d of (raw.devices ?? []) as Record<string, unknown>[]) {
        if (d.role === 'tentacle') {
          tentacleDeviceIdRef.id = d.id as string;
          const compact = (d.encryptionKey ?? d.publicKey) as string | undefined;
          if (compact) tentaclePubKey = importPublicKey(compact);
        }
      }
      return;
    }
    if (raw.type === 'auth_challenge') {
      ws.send(JSON.stringify({ type: 'auth_response', deviceId, signature: signChallenge(raw.nonce, kp.privateKey) }));
      return;
    }
    if (raw.type === 'device_joined') {
      const d = raw.device as Record<string, unknown>;
      if (d?.role === 'tentacle') {
        tentacleDeviceIdRef.id = d.id as string;
        const compact = (d.encryptionKey ?? d.publicKey) as string | undefined;
        if (compact) tentaclePubKey = importPublicKey(compact);
        // Resume the stream now that we know the tentacle.
        runEffects(tentacleDeviceIdRef.id, ep(tentacleDeviceIdRef.id).onConnected(now()));
      }
      return;
    }
    if (raw.type === 'broadcast' || raw.type === 'unicast') {
      let plaintext: string;
      try {
        plaintext = decryptFromBlob({ blob: raw.blob, keys: raw.keys }, deviceId, kp.privateKey);
      } catch {
        return; // not for us
      }
      const unpacked = tryUnpackPulse(plaintext);
      if (unpacked) {
        runEffects(unpacked.src, ep(unpacked.src).onBytes(unpacked.frame, now()));
      }
      // non-pulse plaintext (deltas, greetings, session_list) ignored by this test
      return;
    }
  });

  // Auth as a returning known device (challenge) — but first-time we don't know
  // the device, so use open/github? The head uses OpenAuthProvider in tests, so
  // a plain auth with our pubkey registers us.
  ws.send(JSON.stringify({
    type: 'auth',
    auth: { method: 'open' },
    device: { name: 'Pulse App', role: 'app', kind: 'web', deviceId, publicKey: compactPubKey },
  }));

  // Wait until we've learned the tentacle key (auth_ok/device_joined).
  const deadline = Date.now() + 5000;
  while (!tentaclePubKey && Date.now() < deadline) await waitMs(20);

  // Drive periodic ticks so heartbeat/liveness + tail-loss recovery run.
  const tick = setInterval(() => {
    for (const [src, e] of endpoints) runEffects(src, e.onTick(now()));
  }, 200);

  return {
    ws,
    deviceId,
    delivered,
    close: () => { clearInterval(tick); ws.close(); },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Pulse integration: reliable delivery across a disconnect', () => {
  let env: TestEnv;
  let adapter: EmitAdapter;
  let sm: SessionManager;
  let km: KeyManager;
  let relay: RelayClient;
  let sessDir: { dir: string; cleanup: () => void };
  let kmDir: { dir: string; cleanup: () => void };
  let homeDir: { dir: string; cleanup: () => void };

  beforeEach(async () => {
    process.env.KRAKI_PULSE = '1';
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
    delete process.env.KRAKI_PULSE;
    relay?.disconnect();
    await env.cleanup();
    sessDir.cleanup();
    kmDir.cleanup();
    homeDir.cleanup();
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
  }

  it('delivers a reliable agent_message through pulse (happy path)', async () => {
    const ref = { id: '' };
    const app = await connectPulseApp(env.port, ref);
    await connectTentacle();
    // let device_joined propagate both ways
    await waitMs(300);

    adapter.onSessionCreated?.({ sessionId: 's1', agent: 'mock', model: 'm' });
    adapter.onMessage?.('s1', { content: 'hello from agent' });

    const deadline = Date.now() + 4000;
    while (!app.delivered.some((m) => m.type === 'agent_message') && Date.now() < deadline) {
      await waitMs(50);
    }
    const got = app.delivered.filter((m) => m.type === 'agent_message');
    expect(got.length).toBe(1);
    expect((got[0]!.payload as Record<string, unknown>).content).toBe('hello from agent');
    app.close();
  });

  it('recovers messages produced WHILE the tentacle socket is down', async () => {
    const ref = { id: '' };
    const app = await connectPulseApp(env.port, ref);
    await connectTentacle();
    await waitMs(300);

    // 1 delivered live.
    adapter.onMessage?.('s1', { content: 'msg-1' });
    await waitMs(200);

    // Drop the tentacle's socket. The agent keeps producing while it's down.
    relay.disconnect();
    await waitMs(100);
    adapter.onMessage?.('s1', { content: 'msg-2' }); // produced offline
    adapter.onMessage?.('s1', { content: 'msg-3' });

    // Reconnect: pulse must resume and deliver msg-2, msg-3 (no hole).
    await new Promise<void>((resolve, reject) => {
      relay.onAuthenticated = () => resolve();
      relay.onFatalError = (m) => reject(new Error(m));
      relay.connect();
    });

    const deadline = Date.now() + 6000;
    const want = ['msg-1', 'msg-2', 'msg-3'];
    while (Date.now() < deadline) {
      const contents = app.delivered
        .filter((m) => m.type === 'agent_message')
        .map((m) => (m.payload as Record<string, unknown>).content);
      if (want.every((w) => contents.includes(w))) break;
      await waitMs(100);
    }

    const contents = app.delivered
      .filter((m) => m.type === 'agent_message')
      .map((m) => (m.payload as Record<string, unknown>).content);
    // No loss: every reliable message arrived.
    for (const w of want) expect(contents).toContain(w);
    // Exactly once: no duplicates.
    expect(contents.filter((c) => c === 'msg-2').length).toBe(1);
    app.close();
  });
});
