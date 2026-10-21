import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { signChallenge } from '@kraki/crypto';
import { DEVICE_REPLACED_CLOSE_CODE } from '@kraki/protocol';
import { firePushPreview } from '../../head/src/server/account-control.js';
import { connectApp, createTestEnv, type MockApp, type TestEnv } from './helpers.js';

async function until(predicate: () => boolean) {
  for (let i = 0; i < 300 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(predicate()).toBe(true);
}
function state(env: TestEnv, id: string) { return env.head.clients.get(env.head.connections.get(id)!)!; }

async function replace(env: TestEnv, first: MockApp) {
  const ws = new WebSocket(`ws://127.0.0.1:${env.port}`);
  const messages: Array<Record<string, unknown>> = [];
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString()); messages.push(m);
    if (m.type === 'auth_challenge') ws.send(JSON.stringify({ type: 'auth_response', deviceId: first.deviceId, signature: signChallenge(m.nonce, first.keyPair.privateKey) }));
  });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'auth', auth: { method: 'challenge', deviceId: first.deviceId }, device: { name: 'replacement', role: 'app', kind: 'web' } }));
  await until(() => messages.some((m) => m.type === 'auth_ok'));
  return { ws, messages };
}

describe('PR577 real Head visibility and revocation races', () => {
  it('hidden old socket cannot leak its visibility into a replacement or suppress push incorrectly', async () => {
    const env = await createTestEnv();
    let replacement: Awaited<ReturnType<typeof replace>> | undefined;
    try {
      const first = await connectApp(env.port, 'first');
      const push = vi.spyOn(env.pushSpy.manager, 'sendToOfflineDevices');
      const userId = state(env, first.deviceId).userId!;
      env.storage.upsertDevice('qa-sender', userId, 'Tentacle', 'tentacle', 'desktop');
      const sender = { ...state(env, first.deviceId), deviceId: 'qa-sender', userId };
      const preview = { blob: 'qa-preview', keys: { [first.deviceId]: 'key' } };
      first.send({ type: 'app_visibility', visible: false });
      await until(() => state(env, first.deviceId).hidden === true);
      firePushPreview(env.head, sender, preview);
      expect(push.mock.lastCall?.[1]).not.toContain(first.deviceId);
      const close = new Promise<number>((resolve) => first.ws.once('close', resolve));
      replacement = await replace(env, first);
      expect(await close).toBe(DEVICE_REPLACED_CLOSE_CODE);
      expect(state(env, first.deviceId).hidden).not.toBe(true);
      firePushPreview(env.head, sender, preview);
      expect(push.mock.lastCall?.[1]).toContain(first.deviceId);
      replacement.ws.send(JSON.stringify({ type: 'app_visibility', visible: false }));
      await until(() => state(env, first.deviceId).hidden === true);
      firePushPreview(env.head, sender, preview);
      expect(push.mock.lastCall?.[1]).not.toContain(first.deviceId);
      replacement.ws.send(JSON.stringify({ type: 'app_visibility', visible: true }));
      await until(() => state(env, first.deviceId).hidden === false);
    } finally { replacement?.ws.terminate(); await env.cleanup(); }
  });

  it('revokes the current socket after same-device replacement, not just the stale one', async () => {
    const env = await createTestEnv();
    let replacement: Awaited<ReturnType<typeof replace>> | undefined;
    try {
      const first = await connectApp(env.port, 'first');
      replacement = await replace(env, first);
      const closed = new Promise<number>((resolve) => replacement!.ws.once('close', resolve));
      env.head.revokeDevice({ deviceId: first.deviceId, code: 'unknown_device', message: 'qa removed' });
      expect(await closed).toBe(1008);
      expect(replacement.messages).toContainEqual(expect.objectContaining({ type: 'auth_error', code: 'unknown_device' }));
      expect(env.storage.getDevice(first.deviceId)).toBeFalsy();
      await until(() => !env.head.connections.has(first.deviceId));
    } finally { replacement?.ws.terminate(); await env.cleanup(); }
  });

  it('revoking an already disconnected device deletes its mirror and forgets Pulse state', async () => {
    const env = await createTestEnv();
    try {
      const first = await connectApp(env.port, 'first');
      const forget = vi.spyOn(env.head.pulseHub, 'forgetDevice');
      first.close();
      await until(() => !env.head.connections.has(first.deviceId));
      env.head.revokeDevice({ deviceId: first.deviceId, code: 'account_deleted', message: 'qa removed' });
      expect(env.storage.getDevice(first.deviceId)).toBeFalsy();
      expect(forget).toHaveBeenCalledWith(first.deviceId);
    } finally { await env.cleanup(); }
  });

  it('wrong_region closes a connected device but preserves its mirror for redirect', async () => {
    const env = await createTestEnv();
    try {
      const first = await connectApp(env.port, 'first');
      const closed = new Promise<number>((resolve) => first.ws.once('close', resolve));
      env.head.revokeDevice({ deviceId: first.deviceId, code: 'wrong_region', message: 'qa moved', redirect: 'wss://cn.kraki.chat' });
      expect(await closed).toBe(1008);
      expect(first.messages).toContainEqual(expect.objectContaining({ type: 'auth_error', code: 'wrong_region', redirect: 'wss://cn.kraki.chat' }));
      expect(env.storage.getDevice(first.deviceId)).toBeTruthy();
    } finally { await env.cleanup(); }
  });
});
