/**
 * An edge relay mirrors the account service's device list on every sign-in
 * (QA K-102, K-140): the mirror must not mark every device of the account as
 * seen now, and a removal made at the edge must not be undone by it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { Storage } from '../storage.js';
import { HeadServer } from '../server.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { RemoteAuthBackend } from '../remote-auth-backend.js';
import { AccountApi } from '../account-api.js';
import { OpenAuthProvider } from '../auth.js';
import { connectDevice, type MockDevice } from './integration-helpers.js';

const SERVICE_KEY = 'svc-key-mirror';
const OLD = '2020-01-01 00:00:00';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function localBackend(storage: Storage): LocalAuthBackend {
  const providers = new Map();
  providers.set('open', new OpenAuthProvider());
  return new LocalAuthBackend({ storage, authProviders: providers });
}

/** Test-only: backdate a device's last_seen. */
function setLastSeen(storage: Storage, deviceId: string, at: string): void {
  (storage as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db
    .prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(at, deviceId);
}

describe('edge device mirror', () => {
  let central: Storage;
  let http: Server;
  let accountUrl: string;
  let edgeStorage: Storage;
  let head: HeadServer;
  let edgeHttp: Server;
  let port: number;
  const open: MockDevice[] = [];
  const connect = async (...args: Parameters<typeof connectDevice> extends [number, ...infer R] ? R : never) => {
    const d = await connectDevice(port, ...args);
    open.push(d);
    return d;
  };

  beforeEach(async () => {
    central = new Storage(':memory:');
    const api = new AccountApi({ authBackend: localBackend(central), serviceKey: SERVICE_KEY });
    http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (!(await api.handleRequest(req, res))) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => http.listen(0, resolve));
    accountUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    edgeStorage = new Storage(':memory:');
    head = new HeadServer(edgeStorage, { authBackend: new RemoteAuthBackend({ accountUrl, serviceKey: SERVICE_KEY }) });
    edgeHttp = createServer();
    head.attach(edgeHttp);
    await new Promise<void>((resolve) => edgeHttp.listen(0, resolve));
    port = (edgeHttp.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const d of open.splice(0)) d.close();
    head.close();
    await new Promise<void>((resolve) => edgeHttp.close(() => resolve()));
    if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()));
    edgeStorage.close();
    central.close();
  });

  it('a sign-in marks only the signing-in device as seen (K-102)', async () => {
    const phone = await connect('Kraki iOS', 'app');
    const browser = await connect('Old browser', 'app');
    const browserId = browser.deviceId;
    browser.close();
    await wait(50);
    setLastSeen(central, browserId, OLD);
    setLastSeen(edgeStorage, browserId, OLD);

    phone.close();
    await wait(50);
    await connect('Kraki iOS', 'app', { deviceId: phone.deviceId });

    expect(edgeStorage.getDevice(browserId)?.lastSeen).toBe(OLD);
    expect(edgeStorage.getDevice(phone.deviceId)?.lastSeen).not.toBe(OLD);
    // So an abandoned browser's web push token is pruned as stale.
    edgeStorage.upsertPushToken(browserId, 'web_push', 'https://push.example/abandoned');
    expect(edgeStorage.deleteStaleUserPushTokens(edgeStorage.getDevice(browserId)!.userId, phone.deviceId, [phone.deviceId])).toBe(1);
  });

  it('a first mirror of a device takes the account service\'s last_seen (K-102)', async () => {
    const laptop = await connect('corelli-mbp', 'tentacle');
    const laptopId = laptop.deviceId;
    laptop.close();
    await wait(50);
    setLastSeen(central, laptopId, OLD);
    edgeStorage.deleteDevice(laptopId); // as if this edge never saw it

    await connect('Kraki iOS', 'app');
    expect(edgeStorage.getDevice(laptopId)?.lastSeen).toBe(OLD);
  });

  it('removing a device while the account service is down changes nothing and says so (K-140)', async () => {
    const phone = await connect('Kraki iOS', 'app');
    const laptop = await connect('corelli-mbp', 'tentacle');
    const laptopId = laptop.deviceId;
    laptop.close();
    await wait(50);
    await new Promise<void>((resolve) => http.close(() => resolve()));

    phone.send({ type: 'remove_device', deviceId: laptopId });
    expect(String((await phone.waitFor('server_error')).message)).toContain('Could not remove');
    expect(edgeStorage.getDevice(laptopId)).toBeTruthy();
    expect(phone.messages.some((m) => m.type === 'device_removed')).toBe(false);
  });

  it('a removal stays removed after the next sign-in (K-140)', async () => {
    const phone = await connect('Kraki iOS', 'app');
    const laptop = await connect('corelli-mbp', 'tentacle');
    const laptopId = laptop.deviceId;
    laptop.close();
    await wait(50);

    phone.send({ type: 'remove_device', deviceId: laptopId });
    await phone.waitFor('device_removed');
    expect(central.getDevice(laptopId)).toBeFalsy();
    expect(edgeStorage.getDevice(laptopId)).toBeFalsy();

    const mac = await connect('Kraki Mac', 'app');
    expect((mac.authOk.devices as Array<{ id: string }>).some((d) => d.id === laptopId)).toBe(false);
    expect(edgeStorage.getDevice(laptopId)).toBeFalsy();
  });

  it('removes this edge\'s copy of a device the account service no longer has (K-140)', async () => {
    const phone = await connect('Kraki iOS', 'app');
    const laptop = await connect('corelli-mbp', 'tentacle');
    const laptopId = laptop.deviceId;
    laptop.close();
    await wait(50);
    central.deleteDevice(laptopId); // removed through another edge

    phone.send({ type: 'remove_device', deviceId: laptopId });
    await phone.waitFor('device_removed');
    expect(edgeStorage.getDevice(laptopId)).toBeFalsy();
  });
});
