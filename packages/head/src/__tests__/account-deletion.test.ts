/**
 * Account deletion (App Store 5.1.1(v)): an app deletes the account, the
 * relay removes every row it keeps for the user, tells connected devices and
 * closes them, and a device that was offline learns it on its next connect
 * instead of silently signing up again.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { ACCOUNT_DELETED_CLOSE_CODE } from '@kraki/protocol';
import { Storage } from '../storage.js';
import { HeadServer } from '../server.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { RemoteAuthBackend } from '../remote-auth-backend.js';
import { AccountApi } from '../account-api.js';
import { OpenAuthProvider } from '../auth.js';
import type { AuthBackend } from '../auth-backend.js';
import { connectDevice } from './integration-helpers.js';

function localBackend(storage: Storage): LocalAuthBackend {
  const providers = new Map();
  providers.set('open', new OpenAuthProvider());
  return new LocalAuthBackend({ storage, authProviders: providers });
}

async function startHead(storage: Storage, authBackend: AuthBackend) {
  const server = new HeadServer(storage, { authBackend });
  const httpServer = createServer();
  server.attach(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    port,
    server,
    async close() {
      server.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/** Raw auth attempt; resolves with the first auth answer. */
async function tryAuth(port: number, deviceId: string, role: 'app' | 'tentacle') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const answer = new Promise<Record<string, unknown>>((resolve) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.type === 'auth_ok' || msg.type === 'auth_error') resolve(msg);
    });
  });
  ws.send(JSON.stringify({ type: 'auth', auth: { method: 'open' }, device: { name: 'Again', role, deviceId } }));
  const msg = await answer;
  ws.close();
  return msg;
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.on('close', (code) => resolve(code)));
}

describe('account deletion', () => {
  let storage: Storage;
  let head: Awaited<ReturnType<typeof startHead>>;

  beforeEach(async () => {
    storage = new Storage(':memory:');
    head = await startHead(storage, localBackend(storage));
  });

  afterEach(async () => {
    await head.close();
    storage.close();
  });

  it('deletes everything for the user, notifies and closes every device', async () => {
    const app = await connectDevice(head.port, 'Phone', 'app');
    const tentacle = await connectDevice(head.port, 'Laptop', 'tentacle', { kind: 'desktop' });
    const userId = String((app.authOk.user as { id: string }).id);
    storage.upsertPushToken(app.deviceId, 'apns', 'tok-1');
    storage.updateVoiceVocabulary(userId, [{ op: 'add', word: 'Kraki', at: 1 }] as never);
    storage.recordVoiceLease({
      jti: 'j1', userId, deviceId: app.deviceId, resource: 'asr',
      quotaSeconds: 60, issuedAtUnixSec: 1, expiresAtUnixSec: 2,
    });

    const appClosed = closed(app.ws);
    const tentacleClosed = closed(tentacle.ws);
    app.send({ type: 'delete_account' });

    await expect(tentacle.waitFor('account_deleted')).resolves.toBeTruthy();
    await expect(app.waitFor('account_deleted')).resolves.toBeTruthy();
    expect(await appClosed).toBe(ACCOUNT_DELETED_CLOSE_CODE);
    expect(await tentacleClosed).toBe(ACCOUNT_DELETED_CLOSE_CODE);

    expect(storage.getUser(userId)).toBeFalsy();
    expect(storage.getDevicesByUser(userId)).toEqual([]);
    expect(storage.getPushTokensForOfflineDevices(userId, [])).toEqual([]);
    expect(storage.getVoiceLease('j1')).toBeFalsy();
    expect(storage.isDeletedDevice(app.deviceId)).toBe(true);
    expect(storage.isDeletedDevice(tentacle.deviceId)).toBe(true);
  });

  it('an offline device of the deleted account gets account_deleted instead of a new account', async () => {
    const app = await connectDevice(head.port, 'Phone', 'app');
    const tentacle = await connectDevice(head.port, 'Laptop', 'tentacle', { kind: 'desktop' });
    const tentacleId = tentacle.deviceId;
    tentacle.close();
    await new Promise((r) => setTimeout(r, 50));

    app.send({ type: 'delete_account' });
    await app.waitFor('account_deleted');

    const answer = await tryAuth(head.port, tentacleId, 'tentacle');
    expect(answer).toMatchObject({ type: 'auth_error', code: 'account_deleted' });
    expect(storage.getDevice(tentacleId)).toBeFalsy();

    // A fresh install (new device id) can still sign up again.
    const fresh = await tryAuth(head.port, 'dev_fresh_install', 'app');
    expect(fresh.type).toBe('auth_ok');
  });

  it('only an app may delete the account', async () => {
    const app = await connectDevice(head.port, 'Phone', 'app');
    const tentacle = await connectDevice(head.port, 'Laptop', 'tentacle', { kind: 'desktop' });
    const userId = String((app.authOk.user as { id: string }).id);

    tentacle.send({ type: 'delete_account' });
    const err = await tentacle.waitFor('server_error');
    expect(String(err.message)).toContain('Only the Kraki app');
    expect(storage.getUser(userId)).toBeTruthy();
    expect(storage.getDevicesByUser(userId)).toHaveLength(2);
    app.close();
    tentacle.close();
  });

  it('keeps everything when the account store cannot delete', async () => {
    await head.close();
    const backend = localBackend(storage);
    backend.deleteAccount = async () => { throw new Error('account service unavailable'); };
    head = await startHead(storage, backend);

    const app = await connectDevice(head.port, 'Phone', 'app');
    const userId = String((app.authOk.user as { id: string }).id);
    app.send({ type: 'delete_account' });
    const err = await app.waitFor('server_error');
    expect(String(err.message)).toContain('Could not delete the account');
    expect(storage.getUser(userId)).toBeTruthy();
    expect(storage.getDevice(app.deviceId)).toBeTruthy();
    expect(app.ws.readyState).toBe(WebSocket.OPEN);
    app.close();
  });
});

describe('Storage.deleteUser', () => {
  it('deletes only the given user and tombstones its devices', () => {
    const storage = new Storage(':memory:');
    storage.upsertUser('u1', 'one', 'open');
    storage.upsertUser('u2', 'two', 'open');
    storage.upsertDevice('d1', 'u1', 'A', 'app');
    storage.upsertDevice('d2', 'u2', 'B', 'app');
    storage.upsertPushToken('d2', 'apns', 'tok-2');

    expect(storage.deleteUser('u1')).toEqual(['d1']);
    expect(storage.getUser('u1')).toBeFalsy();
    expect(storage.getUser('u2')).toBeTruthy();
    expect(storage.getDevice('d2')).toBeTruthy();
    expect(storage.isDeletedDevice('d1')).toBe(true);
    expect(storage.isDeletedDevice('d2')).toBe(false);
    expect(storage.deleteUser('u1')).toEqual([]);
    storage.close();
  });
});

describe('account deletion through the account service (edge mode)', () => {
  it('RemoteAuthBackend.deleteAccount deletes at the account service', async () => {
    const SERVICE_KEY = 'svc-key-123';
    const central = new Storage(':memory:');
    const api = new AccountApi({ authBackend: localBackend(central), serviceKey: SERVICE_KEY });
    const http: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (!(await api.handleRequest(req, res))) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => http.listen(0, resolve));
    const accountUrl = `http://localhost:${(http.address() as AddressInfo).port}`;

    central.upsertUser('u1', 'one', 'open');
    central.upsertDevice('d1', 'u1', 'A', 'app');

    const remote = new RemoteAuthBackend({ accountUrl, serviceKey: SERVICE_KEY });
    expect(await remote.deleteAccount('u1')).toEqual(['d1']);
    expect(central.getUser('u1')).toBeFalsy();
    expect(central.isDeletedDevice('d1')).toBe(true);

    const wrongKey = new RemoteAuthBackend({ accountUrl, serviceKey: 'wrong' });
    await expect(wrongKey.deleteAccount('u2')).rejects.toThrow();

    await new Promise<void>((resolve) => http.close(() => resolve()));
    central.close();
  });
});
