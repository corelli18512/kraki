/**
 * 2026-10-07 18:28–20:22 reconnect storm: CN Head logged 2351 "Device
 * authenticated" + 2346 "Replacing existing connection" for one Web device id,
 * ~1 s apart. Two browser tabs shared one stored identity; Head evicted the
 * older socket with a bare terminate (1006), the evicted tab reconnected as
 * after a network drop and evicted the other one, forever.
 *
 * Now Head closes the evicted socket with DEVICE_REPLACED_CLOSE_CODE and the
 * Web transport stays offline on it. `startTab` follows that rule
 * (packages/arm/web/src/lib/transport.ts) against the real HeadServer.
 */
import { describe, it, expect } from 'vitest';
import { WebSocket } from 'ws';
import { exportPublicKey, signChallenge } from '@kraki/crypto';
import { DEVICE_REPLACED_CLOSE_CODE } from '@kraki/protocol';
import { createTestEnv, connectApp } from './helpers.js';

interface Tab {
  auths: number;
  closes: Array<{ code: number; reason: string }>;
  stop(): void;
}

/** One browser tab: reconnects on every unintentional close, with the Web
 *  transport's delays (500 ms base, reset to base after a successful auth). */
function startTab(port: number, deviceId: string, publicKey: string, privateKey: string): Tab {
  const tab: Tab = { auths: 0, closes: [], stop: () => { stopped = true; ws?.close(); } };
  let stopped = false;
  let ws: WebSocket | null = null;
  let delay = 500;
  const connect = () => {
    if (stopped) return;
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    ws = sock;
    sock.on('open', () => sock.send(JSON.stringify({
      type: 'auth',
      auth: { method: 'challenge', deviceId },
      device: { name: 'Web', role: 'app', kind: 'web', deviceId, publicKey: exportPublicKey(publicKey) },
    })));
    sock.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type: string; nonce?: string };
      if (msg.type === 'auth_challenge') {
        sock.send(JSON.stringify({ type: 'auth_response', deviceId, signature: signChallenge(msg.nonce!, privateKey) }));
      } else if (msg.type === 'auth_ok') {
        tab.auths += 1;
        delay = 500; // transport.setAuthenticated(true)
      }
    });
    sock.on('error', () => {});
    sock.on('close', (code, reason) => {
      tab.closes.push({ code, reason: reason.toString() });
      if (stopped || code === DEVICE_REPLACED_CLOSE_CODE) return;
      const wait = Math.round(delay * (0.8 + 0.4 * Math.random()));
      delay = Math.min(delay * 2, 4000);
      setTimeout(connect, wait);
    });
  };
  connect();
  return tab;
}

describe('two tabs sharing one Web device identity', () => {
  it('Head evicts the previous socket with an explicit "replaced" close', async () => {
    const env = await createTestEnv();
    try {
      const first = await connectApp(env.port, 'Web tab A');
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        first.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
      // Tab B: same stored identity.
      const tabB = startTab(env.port, first.deviceId, first.keyPair.publicKey, first.keyPair.privateKey);
      const close = await closed;
      tabB.stop();
      expect(close.code).toBe(DEVICE_REPLACED_CLOSE_CODE);
      expect(close.reason).toBe('replaced');
    } finally {
      await env.cleanup();
    }
  });

  it('two tabs with the Web reconnect rule settle instead of evicting each other', async () => {
    const env = await createTestEnv();
    try {
      const paired = await connectApp(env.port, 'Web');
      paired.close();
      const { deviceId, keyPair } = paired;
      const a = startTab(env.port, deviceId, keyPair.publicKey, keyPair.privateKey);
      const b = startTab(env.port, deviceId, keyPair.publicKey, keyPair.privateKey);
      await new Promise((r) => setTimeout(r, 5_000));
      a.stop(); b.stop();
      const total = a.auths + b.auths;
      // Before: ~17 auths in 8 s, all closes 1006. Now: each tab authenticates
      // once, the earlier one is told it was replaced and stays offline.
      expect(total).toBe(2);
      expect([...a.closes, ...b.closes].filter((c) => c.code === DEVICE_REPLACED_CLOSE_CODE)).toHaveLength(1);
    } finally {
      await env.cleanup();
    }
  }, 20_000);
});
