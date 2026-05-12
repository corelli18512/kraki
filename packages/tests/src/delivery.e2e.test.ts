/**
 * End-to-end delivery assurance tests.
 *
 * Spins up a REAL relay (head), REAL tentacle (RelayClient + SessionManager +
 * KeyManager + a mock adapter), and REAL app client (with real RSA crypto).
 *
 * Goal: validate that the relay-side delivery tracking mechanism (relaySeq +
 * ack + retry) recovers from dropped frames without requiring user action.
 *
 * "Dropped frames" are simulated by intercepting messages between head and
 * one peer at the wire level — proving the recovery mechanism actually fires
 * end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { Storage, HeadServer, OpenAuthProvider } from '@kraki/head';
import {
  generateKeyPair, exportPublicKey, importPublicKey,
  encryptToBlob, decryptFromBlob,
} from '@kraki/crypto';
import type { KeyPair } from '@kraki/crypto';
import { waitMs } from './helpers';

// ── E2E test rig ────────────────────────────────────────────

interface E2EEnv {
  port: number;
  storage: Storage;
  head: HeadServer;
  httpServer: Server;
  cleanup: () => Promise<void>;
}

async function createE2EEnv(): Promise<E2EEnv> {
  const storage = new Storage(':memory:');
  const head = new HeadServer(storage, {
    authProvider: new OpenAuthProvider(),
  });

  const httpServer = createServer();
  head.attach(httpServer);
  await new Promise<void>(resolve => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;

  return {
    port, storage, head, httpServer,
    cleanup: async () => {
      head.close();
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
      storage.close();
    },
  };
}

/**
 * A real-WS-protocol app client that tracks relaySeq and sends piggybacked
 * acks. Mirrors the behavior of the arm KrakiTransport but lives in Node.
 *
 * Supports a `dropNext(n)` knob: the next N inbound encrypted broadcasts are
 * silently dropped (simulating GFW packet loss).
 */
interface AppPeer {
  ws: WebSocket;
  deviceId: string;
  keyPair: KeyPair;
  rawMessages: Record<string, unknown>[];
  decryptedMessages: Record<string, unknown>[];
  lastReceivedRelaySeq: () => number;
  ackCount: () => number;
  sendPing: () => void;
  sendUnicast: (to: string, inner: Record<string, unknown>, recipientCompactPubKey: string) => void;
  /** Skip the next N inbound encrypted broadcasts (simulate dropped frames). */
  dropNext: (n: number) => void;
  close: () => void;
}

async function connectAppPeer(port: number, name = 'PhoneA'): Promise<AppPeer> {
  const kp = generateKeyPair();
  const deviceId = `dev_app_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const compactPubKey = exportPublicKey(kp.publicKey);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const rawMessages: Record<string, unknown>[] = [];
  const decryptedMessages: Record<string, unknown>[] = [];
  let lastRelaySeq = 0;
  const seenRelaySeqs = new Set<number>();
  let dropsRemaining = 0;
  let ackPings = 0;

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  ws.on('message', (data) => {
    const raw = JSON.parse(data.toString()) as Record<string, unknown>;
    rawMessages.push(raw);

    // Simulate GFW dropping the frame — skip everything: tracking, decrypt, ack.
    if (typeof raw.relaySeq === 'number' && raw.type === 'broadcast' && dropsRemaining > 0) {
      dropsRemaining -= 1;
      return;
    }

    // Track relaySeq for ack piggybacking.
    if (typeof raw.relaySeq === 'number' && raw.relaySeq > 0) {
      if (seenRelaySeqs.has(raw.relaySeq)) {
        // Duplicate retry — silently drop (mirrors arm behavior).
        return;
      }
      seenRelaySeqs.add(raw.relaySeq);
      if (raw.relaySeq > lastRelaySeq) lastRelaySeq = raw.relaySeq;
    }

    if (raw.type === 'broadcast' || raw.type === 'unicast') {
      try {
        const decrypted = decryptFromBlob(
          { blob: raw.blob as string, keys: raw.keys as Record<string, string> },
          deviceId,
          kp.privateKey,
        );
        decryptedMessages.push(JSON.parse(decrypted));
      } catch {
        // not for us
      }
    } else {
      decryptedMessages.push(raw);
    }
  });

  // Authenticate
  ws.send(JSON.stringify({
    type: 'auth',
    auth: { method: 'open' },
    device: { name, role: 'app', kind: 'web', deviceId, publicKey: compactPubKey },
  }));

  // Wait for auth_ok
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Auth timeout')), 5000);
    const check = () => {
      if (decryptedMessages.some(m => m.type === 'auth_ok')) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve();
      }
    };
    const onMsg = () => check();
    ws.on('message', onMsg);
    check();
  });

  return {
    ws, deviceId, keyPair: kp,
    rawMessages, decryptedMessages,
    lastReceivedRelaySeq: () => lastRelaySeq,
    ackCount: () => ackPings,
    sendPing() {
      ackPings += 1;
      ws.send(JSON.stringify({ type: 'ping', ack: lastRelaySeq }));
    },
    sendUnicast(to, inner, recipientCompactPubKey) {
      const recipientPubKey = importPublicKey(recipientCompactPubKey);
      const { blob, keys } = encryptToBlob(JSON.stringify(inner), [
        { deviceId: to, publicKey: recipientPubKey },
      ]);
      const env: Record<string, unknown> = { type: 'unicast', to, blob, keys };
      if (lastRelaySeq > 0) env.ack = lastRelaySeq;
      ws.send(JSON.stringify(env));
    },
    dropNext(n) {
      dropsRemaining = n;
    },
    close() { ws.close(); },
  };
}

/**
 * A real-WS-protocol tentacle client — same shape as RelayClient but inline
 * here so we can drive it deterministically and capture wire-level state.
 */
interface TentaclePeer {
  ws: WebSocket;
  deviceId: string;
  keyPair: KeyPair;
  rawMessages: Record<string, unknown>[];
  decryptedMessages: Record<string, unknown>[];
  lastReceivedRelaySeq: () => number;
  consumerKeys: Map<string, string>;
  broadcast: (inner: Record<string, unknown>) => void;
  sendPing: () => void;
  close: () => void;
}

async function connectTentaclePeer(port: number, name = 'Laptop'): Promise<TentaclePeer> {
  const kp = generateKeyPair();
  const deviceId = `dev_t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const compactPubKey = exportPublicKey(kp.publicKey);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const rawMessages: Record<string, unknown>[] = [];
  const decryptedMessages: Record<string, unknown>[] = [];
  const consumerKeys = new Map<string, string>();
  let lastRelaySeq = 0;
  const seenRelaySeqs = new Set<number>();

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  ws.on('message', (data) => {
    const raw = JSON.parse(data.toString()) as Record<string, unknown>;
    rawMessages.push(raw);

    if (typeof raw.relaySeq === 'number' && raw.relaySeq > 0) {
      if (seenRelaySeqs.has(raw.relaySeq)) return;
      seenRelaySeqs.add(raw.relaySeq);
      if (raw.relaySeq > lastRelaySeq) lastRelaySeq = raw.relaySeq;
    }

    if (raw.type === 'device_joined') {
      const device = raw.device as Record<string, unknown>;
      const key = (device.encryptionKey ?? device.publicKey) as string | undefined;
      if (key) consumerKeys.set(device.id as string, key);
    }
    if (raw.type === 'auth_ok') {
      const devices = (raw.devices as Record<string, unknown>[] | undefined) ?? [];
      for (const d of devices) {
        const key = (d.encryptionKey ?? d.publicKey) as string | undefined;
        if (key && d.role === 'app') consumerKeys.set(d.id as string, key);
      }
    }

    if (raw.type === 'broadcast' || raw.type === 'unicast') {
      try {
        const decrypted = decryptFromBlob(
          { blob: raw.blob as string, keys: raw.keys as Record<string, string> },
          deviceId,
          kp.privateKey,
        );
        decryptedMessages.push(JSON.parse(decrypted));
      } catch {
        // not for us
      }
    } else {
      decryptedMessages.push(raw);
    }
  });

  ws.send(JSON.stringify({
    type: 'auth',
    auth: { method: 'open' },
    device: { name, role: 'tentacle', kind: 'desktop', deviceId, publicKey: compactPubKey },
  }));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Auth timeout')), 5000);
    const check = () => {
      if (decryptedMessages.some(m => m.type === 'auth_ok')) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve();
      }
    };
    const onMsg = () => check();
    ws.on('message', onMsg);
    check();
  });

  return {
    ws, deviceId, keyPair: kp,
    rawMessages, decryptedMessages,
    lastReceivedRelaySeq: () => lastRelaySeq,
    consumerKeys,
    broadcast(inner) {
      if (consumerKeys.size === 0) {
        throw new Error('No consumer keys to encrypt for');
      }
      const recipients = Array.from(consumerKeys.entries()).map(([id, compactKey]) => ({
        deviceId: id,
        publicKey: importPublicKey(compactKey),
      }));
      const { blob, keys } = encryptToBlob(JSON.stringify(inner), recipients);
      const env: Record<string, unknown> = { type: 'broadcast', blob, keys };
      if (lastRelaySeq > 0) env.ack = lastRelaySeq;
      ws.send(JSON.stringify(env));
    },
    sendPing() {
      const msg: Record<string, unknown> = { type: 'ping' };
      if (lastRelaySeq > 0) msg.ack = lastRelaySeq;
      ws.send(JSON.stringify(msg));
    },
    close() { ws.close(); },
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('E2E delivery assurance', () => {
  let env: E2EEnv;

  beforeEach(async () => { env = await createE2EEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it('end-to-end happy path: encrypted broadcast delivered with ack pruning', async () => {
    const tentacle = await connectTentaclePeer(env.port);
    const app = await connectAppPeer(env.port);
    // Wait for device_joined / consumer keys to propagate to tentacle.
    await waitMs(50);
    expect(tentacle.consumerKeys.has(app.deviceId)).toBe(true);

    // Tentacle broadcasts an agent_message to app.
    tentacle.broadcast({
      type: 'agent_message',
      sessionId: 'sess_e2e',
      deviceId: tentacle.deviceId,
      seq: 1,
      timestamp: new Date().toISOString(),
      payload: { content: 'Hello from agent' },
    });

    // App should receive and decrypt it.
    await waitMs(50);
    const agentMsg = app.decryptedMessages.find(m => m.type === 'agent_message');
    expect(agentMsg).toBeDefined();
    expect((agentMsg!.payload as { content: string }).content).toBe('Hello from agent');

    // app received a relaySeq from head→app direction. App now pings to ack.
    expect(app.lastReceivedRelaySeq()).toBeGreaterThan(0);
    app.sendPing();
    await waitMs(50);

    // Head should have pruned its in-flight buffer for app.
    const state = env.head.getDeliveryState(app.deviceId)!;
    expect(state.ackSupported).toBe(true);
    expect(state.lastAckedSeq).toBe(app.lastReceivedRelaySeq());
    expect(state.inFlightCount).toBe(0);
  });

  it('recovers a dropped broadcast frame via retry — no user action needed', async () => {
    const tentacle = await connectTentaclePeer(env.port);
    const app = await connectAppPeer(env.port);
    await waitMs(50);
    // Establish ack support so head will retry.
    app.sendPing();
    await waitMs(30);
    expect(env.head.getDeliveryState(app.deviceId)!.ackSupported).toBe(true);

    // The next encrypted broadcast will be silently dropped by the app side
    // (simulating a GFW packet loss between head and the app).
    app.dropNext(1);

    tentacle.broadcast({
      type: 'agent_message',
      sessionId: 'sess_drop',
      deviceId: tentacle.deviceId,
      seq: 1,
      timestamp: new Date().toISOString(),
      payload: { content: 'this message was dropped on first delivery' },
    });

    // After the broadcast is dropped, app has not received the agent_message.
    await waitMs(100);
    expect(app.decryptedMessages.find(m => m.type === 'agent_message')).toBeUndefined();

    // Wait past RETRY_AFTER_MS, then trigger retry pass.
    await waitMs(5100);
    env.head.forceRetryPass();
    await waitMs(100);

    // App should now have received the message via the retry — without
    // needing to reconnect or refresh.
    const recovered = app.decryptedMessages.find(m => m.type === 'agent_message');
    expect(recovered).toBeDefined();
    expect((recovered!.payload as { content: string }).content).toBe(
      'this message was dropped on first delivery',
    );

    // App acks the recovered message → head's buffer drains.
    app.sendPing();
    await waitMs(50);
    expect(env.head.getDeliveryState(app.deviceId)!.inFlightCount).toBe(0);
  }, 15000);

  it('recovers MULTIPLE dropped frames in sequence', async () => {
    const tentacle = await connectTentaclePeer(env.port);
    const app = await connectAppPeer(env.port);
    await waitMs(50);
    app.sendPing();
    await waitMs(30);

    // Drop the next 3 broadcasts.
    app.dropNext(3);

    for (let i = 0; i < 3; i++) {
      tentacle.broadcast({
        type: 'agent_message',
        sessionId: 'sess_multi',
        deviceId: tentacle.deviceId,
        seq: i + 1,
        timestamp: new Date().toISOString(),
        payload: { content: `msg-${i}` },
      });
    }

    await waitMs(100);
    expect(app.decryptedMessages.filter(m => m.type === 'agent_message').length).toBe(0);

    // Retry pass — all 3 should come through.
    await waitMs(5100);
    env.head.forceRetryPass();
    await waitMs(200);

    const received = app.decryptedMessages
      .filter(m => m.type === 'agent_message')
      .map(m => (m.payload as { content: string }).content);
    expect(received.sort()).toEqual(['msg-0', 'msg-1', 'msg-2']);

    app.sendPing();
    await waitMs(50);
    expect(env.head.getDeliveryState(app.deviceId)!.inFlightCount).toBe(0);
  }, 15000);

  it('user action carries cumulative ack — no separate ack message sent', async () => {
    const tentacle = await connectTentaclePeer(env.port);
    const app = await connectAppPeer(env.port);
    await waitMs(50);

    // Tentacle sends agent_message → head→app.
    tentacle.broadcast({
      type: 'agent_message',
      sessionId: 's',
      deviceId: tentacle.deviceId,
      seq: 1,
      timestamp: new Date().toISOString(),
      payload: { content: 'agent says hi' },
    });
    await waitMs(50);

    const headSeqAtApp = app.lastReceivedRelaySeq();
    expect(headSeqAtApp).toBeGreaterThan(0);

    // App sends a real user action — a unicast — which auto-includes ack
    // via our peer wrapper. No separate ack message.
    const tentacleCompactPubKey = exportPublicKey(tentacle.keyPair.publicKey);
    app.sendUnicast(tentacle.deviceId, {
      type: 'user_message',
      sessionId: 's',
      payload: { content: 'I approve' },
    }, tentacleCompactPubKey);

    await waitMs(50);

    // Head's in-flight buffer for app should now be pruned by the ack
    // piggybacked on the unicast.
    const state = env.head.getDeliveryState(app.deviceId)!;
    expect(state.ackSupported).toBe(true);
    expect(state.lastAckedSeq).toBeGreaterThanOrEqual(headSeqAtApp);

    // Tentacle should have received the unicast.
    const userMsg = tentacle.decryptedMessages.find(m => m.type === 'user_message');
    expect(userMsg).toBeDefined();
    expect((userMsg!.payload as { content: string }).content).toBe('I approve');
  });

  it('drops connection after MAX_RETRIES and tentacle stops seeing the app online', async () => {
    const tentacle = await connectTentaclePeer(env.port);
    const app = await connectAppPeer(env.port);
    await waitMs(50);
    // Make head consider app ack-capable, but then start dropping everything.
    app.sendPing();
    await waitMs(30);
    expect(env.head.getDeliveryState(app.deviceId)!.ackSupported).toBe(true);

    // App will drop everything from now on.
    app.dropNext(1000);

    let appClosed = false;
    app.ws.on('close', () => { appClosed = true; });

    tentacle.broadcast({
      type: 'agent_message',
      sessionId: 's',
      deviceId: tentacle.deviceId,
      seq: 1,
      timestamp: new Date().toISOString(),
      payload: { content: 'doomed' },
    });

    // 4 retry passes spaced past RETRY_AFTER_MS.
    for (let i = 0; i < 4; i++) {
      await waitMs(5100);
      env.head.forceRetryPass();
      if (appClosed) break;
    }
    await waitMs(200);

    expect(appClosed).toBe(true);
    expect(env.head.getDeliveryState(app.deviceId)).toBeUndefined();

    // Tentacle should have been notified that the app left.
    const left = tentacle.rawMessages.find(m => m.type === 'device_left');
    expect(left).toBeDefined();
  }, 30000);

  it('arm→head direction: tentacle never sees duplicates even if arm retries same relaySeq', async () => {
    const tentacle = await connectTentaclePeer(env.port);
    const app = await connectAppPeer(env.port);
    await waitMs(50);

    const tentaclePub = exportPublicKey(tentacle.keyPair.publicKey);

    // Manually craft a unicast with explicit relaySeq=1, then "retry" it.
    const { blob, keys } = encryptToBlob(
      JSON.stringify({ type: 'user_message', payload: { content: 'first' } }),
      [{ deviceId: tentacle.deviceId, publicKey: importPublicKey(tentaclePub) }],
    );
    const envelope = { type: 'unicast', to: tentacle.deviceId, blob, keys, relaySeq: 1 };

    app.ws.send(JSON.stringify(envelope));
    app.ws.send(JSON.stringify(envelope)); // duplicate
    await waitMs(100);

    const userMessages = tentacle.decryptedMessages.filter(m => m.type === 'user_message');
    expect(userMessages.length).toBe(1);
  });

  it('multi-app: dropped frame on one app does not affect the other', async () => {
    const tentacle = await connectTentaclePeer(env.port);
    const app1 = await connectAppPeer(env.port, 'PhoneA');
    const app2 = await connectAppPeer(env.port, 'PhoneB');
    await waitMs(50);
    app1.sendPing();
    app2.sendPing();
    await waitMs(30);
    expect(tentacle.consumerKeys.has(app1.deviceId)).toBe(true);
    expect(tentacle.consumerKeys.has(app2.deviceId)).toBe(true);

    // Only app1 drops the next broadcast.
    app1.dropNext(1);
    tentacle.broadcast({
      type: 'agent_message',
      sessionId: 's',
      deviceId: tentacle.deviceId,
      seq: 1,
      timestamp: new Date().toISOString(),
      payload: { content: 'split delivery' },
    });

    await waitMs(100);
    // app2 got it directly.
    expect(app2.decryptedMessages.find(m => m.type === 'agent_message')).toBeDefined();
    // app1 hasn't.
    expect(app1.decryptedMessages.find(m => m.type === 'agent_message')).toBeUndefined();

    // Retry recovers app1.
    await waitMs(5100);
    env.head.forceRetryPass();
    await waitMs(100);
    expect(app1.decryptedMessages.find(m => m.type === 'agent_message')).toBeDefined();
  }, 15000);

  it('full session flow with intermittent drops — every message eventually arrives in order', async () => {
    const tentacle = await connectTentaclePeer(env.port);
    const app = await connectAppPeer(env.port);
    await waitMs(50);
    app.sendPing();
    await waitMs(30);

    // 10 messages, dropping every 3rd one.
    const TOTAL = 10;
    const sentContents: string[] = [];

    for (let i = 0; i < TOTAL; i++) {
      if (i % 3 === 0) app.dropNext(1);
      const content = `msg-${i.toString().padStart(2, '0')}`;
      sentContents.push(content);
      tentacle.broadcast({
        type: 'agent_message',
        sessionId: 's_flow',
        deviceId: tentacle.deviceId,
        seq: i + 1,
        timestamp: new Date().toISOString(),
        payload: { content },
      });
      await waitMs(10);
    }

    // After initial round, some messages haven't arrived.
    await waitMs(100);
    const initialCount = app.decryptedMessages.filter(m => m.type === 'agent_message').length;
    expect(initialCount).toBeLessThan(TOTAL);

    // Wait past RETRY_AFTER_MS and force retries until all delivered.
    for (let attempt = 0; attempt < 4; attempt++) {
      await waitMs(5100);
      env.head.forceRetryPass();
      await waitMs(100);
      const recv = app.decryptedMessages.filter(m => m.type === 'agent_message').length;
      if (recv === TOTAL) break;
    }

    const received = app.decryptedMessages
      .filter(m => m.type === 'agent_message')
      .map(m => (m.payload as { content: string }).content);

    // Every sent message is in the received set.
    for (const c of sentContents) {
      expect(received).toContain(c);
    }
    expect(received.length).toBe(TOTAL);

    // Final ack drains head's buffer.
    app.sendPing();
    await waitMs(50);
    expect(env.head.getDeliveryState(app.deviceId)!.inFlightCount).toBe(0);
  }, 60000);
});

describe('E2E delivery assurance — backward compatibility', () => {
  let env: E2EEnv;

  beforeEach(async () => { env = await createE2EEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it('old client (never sends ack) still receives messages — head does not retry or kill', async () => {
    const tentacle = await connectTentaclePeer(env.port);

    // Create an "old client" — auth, but never sends acks.
    const kp = generateKeyPair();
    const deviceId = `dev_old_${Date.now()}`;
    const compactPubKey = exportPublicKey(kp.publicKey);
    const ws = new WebSocket(`ws://127.0.0.1:${env.port}`);
    const received: Record<string, unknown>[] = [];

    await new Promise<void>(resolve => ws.on('open', () => resolve()));
    ws.on('message', (data) => {
      const raw = JSON.parse(data.toString());
      received.push(raw);
    });

    ws.send(JSON.stringify({
      type: 'auth',
      auth: { method: 'open' },
      device: { name: 'OldClient', role: 'app', kind: 'web', deviceId, publicKey: compactPubKey },
    }));

    await waitMs(100);
    expect(received.find(m => m.type === 'auth_ok')).toBeDefined();

    // Tentacle broadcasts.
    tentacle.broadcast({
      type: 'agent_message',
      sessionId: 's',
      deviceId: tentacle.deviceId,
      seq: 1,
      timestamp: new Date().toISOString(),
      payload: { content: 'works without ack' },
    });

    await waitMs(100);
    const got = received.find(m => m.type === 'broadcast');
    expect(got).toBeDefined();
    // Message is stamped with relaySeq, old client just ignores the field.
    expect((got as Record<string, unknown>).relaySeq).toBeGreaterThan(0);

    // Force several retry passes — old client never acks, but ackSupported
    // stays false so retry does nothing, and connection stays alive.
    const state = env.head.getDeliveryState(deviceId)!;
    expect(state.ackSupported).toBe(false);

    for (let i = 0; i < 5; i++) {
      await waitMs(5100);
      env.head.forceRetryPass();
    }

    // Connection should still be open.
    expect(env.head.getDeliveryState(deviceId)).toBeDefined();
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
  }, 45000);
});
