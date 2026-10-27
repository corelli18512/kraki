/**
 * Renaming a device (`rename_device`): an app gives any device of its account
 * a custom name. Every online device hears `device_renamed`, the name survives
 * the device's own re-auth (which reports its own name every time), offline
 * devices can be renamed, and in edge mode the account service keeps the name
 * so every edge shows it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { MAX_DEVICE_NAME_LENGTH, normalizeDeviceName } from '@kraki/protocol';
import { exportPublicKey, generateKeyPair, signChallenge } from '@kraki/crypto';
import { Storage } from '../storage.js';
import { HeadServer } from '../server.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { RemoteAuthBackend } from '../remote-auth-backend.js';
import { AccountApi } from '../account-api.js';
import { OpenAuthProvider } from '../auth.js';
import type { AuthBackend } from '../auth-backend.js';
import { connectDevice, type MockDevice } from './integration-helpers.js';

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

type Summary = { id: string; name: string; defaultName?: string };
const listed = (device: MockDevice, id: string) =>
  (device.authOk.devices as Summary[]).find((d) => d.id === id);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The next `type` message from now on (skips ones already received). */
function next(device: MockDevice, type: string) {
  for (const m of device.messages) if (m.type === type) m._consumed = true;
  return device.waitFor(type).then(({ _consumed: _, ...msg }) => msg);
}

/** The relay's name rule. Swift `DeviceName.normalize` checks the same
 *  vectors (KrakiTests/DeviceRenameTests.swift): keep both lists identical. */
describe('normalizeDeviceName vectors (shared with Swift)', () => {
  const becomesSpace = [0x00, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1f, 0x20, 0x7f, 0x85, 0x9f, 0xa0, 0x1680,
    0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
  const kept = [0x180e, 0x200b, 0x200c, 0x200d, 0x2060, 0xfffe];

  it('turns control and white-space code points into one space and keeps the rest', () => {
    for (const cp of becomesSpace) expect(normalizeDeviceName(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe('a b');
    for (const cp of kept) expect(normalizeDeviceName(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe(`a${String.fromCodePoint(cp)}b`);
    expect(normalizeDeviceName('  Work \n\t laptop ')).toBe('Work laptop');
    expect(normalizeDeviceName('\ufeff\u3000')).toBe('');
  });
});

describe('rename_device', () => {
  let storage: Storage;
  let head: Awaited<ReturnType<typeof startHead>>;
  const open: MockDevice[] = [];
  const connect = async (...args: Parameters<typeof connectDevice> extends [number, ...infer R] ? R : never) => {
    const d = await connectDevice(head.port, ...args);
    open.push(d);
    return d;
  };

  beforeEach(async () => {
    storage = new Storage(':memory:');
    head = await startHead(storage, localBackend(storage));
  });

  afterEach(async () => {
    for (const d of open.splice(0)) d.close();
    await head.close();
    storage.close();
  });

  it('tells every online device, the sender included', async () => {
    const phone = await connect('Kraki iOS', 'app', { kind: 'ios' });
    const mac = await connect('Kraki Mac', 'app', { kind: 'desktop' });
    const laptop = await connect('corelli-mbp', 'tentacle', { kind: 'desktop' });

    const heard = [phone, mac, laptop].map((d) => next(d, 'device_renamed'));
    phone.send({ type: 'rename_device', deviceId: laptop.deviceId, name: '  Work\n laptop ' });
    for (const msg of await Promise.all(heard)) {
      expect(msg).toEqual({ type: 'device_renamed', deviceId: laptop.deviceId, name: 'Work laptop', defaultName: 'corelli-mbp' });
    }
    expect(storage.getDevice(laptop.deviceId)).toMatchObject({ name: 'Work laptop', reportedName: 'corelli-mbp', displayName: 'Work laptop' });
  });

  it('is sent as presence, so a reconnect\'s auth_ok list supersedes an unacked older name', async () => {
    const phone = await connect('Kraki iOS', 'app');
    const laptop = await connect('corelli-mbp', 'tentacle');
    const presence = vi.spyOn(head.server.pulseHub, 'sendPresenceToDevice');
    const control = vi.spyOn(head.server.pulseHub, 'sendToDevice');

    const heard = next(phone, 'device_renamed');
    phone.send({ type: 'rename_device', deviceId: laptop.deviceId, name: 'Work laptop' });
    await heard;
    const renamedFrames = (spy: typeof presence) => spy.mock.calls
      .filter(([, payload]) => JSON.parse(Buffer.from(payload).toString('utf8')).msg?.type === 'device_renamed')
      .map(([dest]) => dest);
    expect(renamedFrames(presence).sort()).toEqual([phone.deviceId, laptop.deviceId].sort());
    expect(renamedFrames(control)).toEqual([]);
  });

  it('keeps the custom name when the device signs in again with its own name', async () => {
    const phone = await connect('Kraki iOS', 'app');
    const laptop = await connect('corelli-mbp', 'tentacle', { kind: 'desktop' });
    const id = laptop.deviceId;
    phone.send({ type: 'rename_device', deviceId: id, name: 'Work laptop' });
    await phone.waitFor('device_renamed');

    laptop.close();
    await wait(50);
    const joined = next(phone, 'device_joined');
    // The computer reports a new hostname on its next sign-in.
    await connect('corelli-mbp-2', 'tentacle', { kind: 'desktop', deviceId: id });
    expect((await joined).device).toMatchObject({ id, name: 'Work laptop', defaultName: 'corelli-mbp-2' });

    const later = await connect('Kraki Mac', 'app');
    expect(listed(later, id)).toMatchObject({ name: 'Work laptop', defaultName: 'corelli-mbp-2' });
  });

  it('renames an offline device; it and every app see the name on their next sign-in', async () => {
    const phone = await connect('Kraki iOS', 'app');
    const laptop = await connect('corelli-mbp', 'tentacle');
    const id = laptop.deviceId;
    laptop.close();
    await wait(50);

    phone.send({ type: 'rename_device', deviceId: id, name: 'Home iMac' });
    expect(await phone.waitFor('device_renamed')).toMatchObject({ name: 'Home iMac' });

    const back = await connect('corelli-mbp', 'tentacle', { deviceId: id });
    expect(listed(back, id)).toMatchObject({ name: 'Home iMac', defaultName: 'corelli-mbp' });
  });

  it('an empty name goes back to the device\'s own name', async () => {
    const phone = await connect('Kraki iOS', 'app');
    const laptop = await connect('corelli-mbp', 'tentacle');
    phone.send({ type: 'rename_device', deviceId: laptop.deviceId, name: 'Work laptop' });
    await laptop.waitFor('device_renamed');

    const cleared = next(laptop, 'device_renamed');
    phone.send({ type: 'rename_device', deviceId: laptop.deviceId, name: '   ' });
    expect(await cleared).toEqual({ type: 'device_renamed', deviceId: laptop.deviceId, name: 'corelli-mbp' });
    expect(storage.getDevice(laptop.deviceId)?.displayName).toBeNull();
    const later = await connect('Kraki Mac', 'app');
    expect(listed(later, laptop.deviceId)).toEqual(expect.not.objectContaining({ defaultName: expect.anything() }));
  });

  it('an app can rename itself', async () => {
    const phone = await connect('Kraki iOS', 'app', { kind: 'ios' });
    phone.send({ type: 'rename_device', deviceId: phone.deviceId, name: "Corelli's iPhone" });
    expect(await phone.waitFor('device_renamed')).toMatchObject({ deviceId: phone.deviceId, name: "Corelli's iPhone", defaultName: 'Kraki iOS' });
  });

  it('rejects computers, other accounts\' devices and names that are too long', async () => {
    const phone = await connect('Kraki iOS', 'app');
    const laptop = await connect('corelli-mbp', 'tentacle');

    laptop.send({ type: 'rename_device', deviceId: phone.deviceId, name: 'pwned' });
    expect(String((await laptop.waitFor('server_error')).message)).toContain('Only apps');

    phone.send({ type: 'rename_device', deviceId: 'dev_someone_else', name: 'x' });
    expect(String((await phone.waitFor('server_error')).message)).toContain('Device not found');

    phone.send({ type: 'rename_device', deviceId: laptop.deviceId, name: 'x'.repeat(MAX_DEVICE_NAME_LENGTH + 1) });
    expect(String((await phone.waitFor('server_error')).message)).toContain('too long');

    phone.send({ type: 'rename_device', deviceId: laptop.deviceId });
    expect(String((await phone.waitFor('server_error')).message)).toContain('Missing');

    expect(storage.getDevice(phone.deviceId)?.displayName).toBeNull();
    expect(storage.getDevice(laptop.deviceId)?.displayName).toBeNull();
    expect(phone.messages.some((m) => m.type === 'device_renamed')).toBe(false);
  });
});

describe('rename_device through the account service (edge mode)', () => {
  const SERVICE_KEY = 'svc-key-rename';
  let central: Storage;
  let http: Server;
  let accountUrl: string;
  const edges: Array<{ storage: Storage; head: Awaited<ReturnType<typeof startHead>> }> = [];
  const open: MockDevice[] = [];

  beforeEach(async () => {
    central = new Storage(':memory:');
    const api = new AccountApi({ authBackend: localBackend(central), serviceKey: SERVICE_KEY });
    http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (!(await api.handleRequest(req, res))) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => http.listen(0, resolve));
    accountUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const d of open.splice(0)) d.close();
    for (const e of edges.splice(0)) { await e.head.close(); e.storage.close(); }
    await new Promise<void>((resolve) => http.close(() => resolve()));
    central.close();
  });

  async function edge() {
    const storage = new Storage(':memory:');
    const head = await startHead(storage, new RemoteAuthBackend({ accountUrl, serviceKey: SERVICE_KEY }));
    const e = { storage, head };
    edges.push(e);
    return e;
  }
  async function connect(e: Awaited<ReturnType<typeof edge>>, ...rest: Parameters<typeof connectDevice> extends [number, ...infer R] ? R : never) {
    const d = await connectDevice(e.head.port, ...rest);
    open.push(d);
    return d;
  }

  it('stores the name at the account service; another edge shows it', async () => {
    const tokyo = await edge();
    const china = await edge();
    // An account's devices share one edge (its region).
    const phone = await connect(tokyo, 'Kraki iOS', 'app');
    const laptop = await connect(tokyo, 'corelli-mbp', 'tentacle');

    phone.send({ type: 'rename_device', deviceId: laptop.deviceId, name: 'Work laptop' });
    expect(await phone.waitFor('device_renamed')).toMatchObject({ name: 'Work laptop', defaultName: 'corelli-mbp' });
    expect(central.getDevice(laptop.deviceId)).toMatchObject({ name: 'Work laptop', reportedName: 'corelli-mbp' });

    // The computer later signs in on another edge (e.g. the account moved
    // region): that edge mirrors the account service and keeps the custom
    // name over the name the computer reports.
    laptop.close();
    await new Promise((r) => setTimeout(r, 50));
    const back = await connect(china, 'corelli-mbp', 'tentacle', { deviceId: laptop.deviceId });
    expect(listed(back, laptop.deviceId)).toMatchObject({ name: 'Work laptop', defaultName: 'corelli-mbp' });
    expect(china.storage.getDevice(laptop.deviceId)).toMatchObject({ name: 'Work laptop', reportedName: 'corelli-mbp' });

    // Clearing it on one edge clears it on the others at their next sign-in.
    const cleared = next(phone, 'device_renamed');
    phone.send({ type: 'rename_device', deviceId: laptop.deviceId, name: '' });
    expect(await cleared).toEqual({ type: 'device_renamed', deviceId: laptop.deviceId, name: 'corelli-mbp' });
    const mac = await connect(china, 'Kraki Mac', 'app');
    expect(listed(mac, laptop.deviceId)?.name).toBe('corelli-mbp');
    expect(china.storage.getDevice(laptop.deviceId)?.displayName).toBeNull();
  });

  it('a sign-in whose device list predates a rename does not revert it', async () => {
    // Found by review: the account service answers an edge's auth with the
    // device list as it was then; if a rename completes on the edge before
    // that answer is applied, mirroring the list would put the old name back.
    let release!: () => void;
    let markHeld!: () => void;
    const isHeld = new Promise<void>((r) => { markHeld = r; });
    let held = false;
    class SlowBackend extends RemoteAuthBackend {
      override async authenticate(...args: Parameters<RemoteAuthBackend['authenticate']>) {
        const result = await super.authenticate(...args);
        if (held) await new Promise<void>((r) => { release = r; markHeld(); });
        return result;
      }
    }
    const storage = new Storage(':memory:');
    const head = await startHead(storage, new SlowBackend({ accountUrl, serviceKey: SERVICE_KEY }));
    const e = { storage, head };
    edges.push(e);
    const phone = await connect(e, 'Kraki iOS', 'app');
    const laptop = await connect(e, 'corelli-mbp', 'tentacle');
    const laptopId = laptop.deviceId;
    laptop.close();
    await new Promise((r) => setTimeout(r, 50));

    // The laptop signs in again; its answer (old device list) is held back.
    held = true;
    const back = connect(e, 'corelli-mbp', 'tentacle', { deviceId: laptopId });
    await isHeld; // its answer (computed before the rename) is being held
    held = false;
    phone.send({ type: 'rename_device', deviceId: laptopId, name: 'Work laptop' });
    expect(await next(phone, 'device_renamed')).toMatchObject({ name: 'Work laptop' });
    release();

    const laptopAgain = await back;
    expect(listed(laptopAgain, laptopId)).toMatchObject({ name: 'Work laptop', defaultName: 'corelli-mbp' });
    expect(storage.getDevice(laptopId)).toMatchObject({ name: 'Work laptop', reportedName: 'corelli-mbp' });
    const mac = await connect(e, 'Kraki Mac', 'app');
    expect(listed(mac, laptopId)?.name).toBe('Work laptop');
  });

  it('changes nothing when the account service cannot store it', async () => {
    const tokyo = await edge();
    const phone = await connect(tokyo, 'Kraki iOS', 'app');
    const laptop = await connect(tokyo, 'corelli-mbp', 'tentacle');
    await new Promise<void>((resolve) => http.close(() => resolve()));
    http.listen(0); // keep afterEach's close() valid; nothing listens on accountUrl now

    phone.send({ type: 'rename_device', deviceId: laptop.deviceId, name: 'Work laptop' });
    expect(String((await phone.waitFor('server_error')).message)).toContain('Could not rename');
    expect(tokyo.storage.getDevice(laptop.deviceId)?.displayName).toBeNull();
    expect(laptop.messages.some((m) => m.type === 'device_renamed')).toBe(false);
  });
});

describe('challenge sign-in keeps the device\'s own name', () => {
  it('does not write the custom name into the device\'s own name', async () => {
    // Found by the real-stack spec: a computer that signs in again with its
    // key (challenge auth, no name sent) had its custom name copied over its
    // own name, so clearing the custom name could never go back.
    const storage = new Storage(':memory:');
    const backend = localBackend(storage);
    const keys = generateKeyPair();
    storage.upsertUser('u1', 'one', 'open');
    storage.upsertDevice('d1', 'u1', 'corelli-mbp', 'tentacle', 'desktop', exportPublicKey(keys.publicKey));
    storage.setDeviceDisplayName('d1', 'Work laptop');

    const challenge = await backend.startChallenge('d1');
    if (!challenge.ok) throw new Error('no challenge');
    const result = await backend.verifyChallenge('d1', challenge.nonce, signChallenge(challenge.nonce, keys.privateKey));
    expect(result.ok).toBe(true);
    expect(storage.getDevice('d1')).toMatchObject({ name: 'Work laptop', reportedName: 'corelli-mbp', displayName: 'Work laptop' });
    storage.close();
  });
});

describe('Storage: device display names', () => {
  it('migrates an existing database and keeps the custom name over auth upserts', () => {
    const storage = new Storage(':memory:');
    storage.upsertUser('u1', 'one', 'open');
    storage.upsertDevice('d1', 'u1', 'host-a', 'tentacle');
    expect(storage.getDevice('d1')).toMatchObject({ name: 'host-a', reportedName: 'host-a', displayName: null });
    expect(storage.setDeviceDisplayName('d1', 'Work')).toBe(true);
    storage.upsertDevice('d1', 'u1', 'host-b', 'tentacle');
    expect(storage.getDevice('d1')).toMatchObject({ name: 'Work', reportedName: 'host-b', displayName: 'Work' });
    expect(storage.getDevicesByUser('u1')[0].name).toBe('Work');
    expect(storage.setDeviceDisplayName('missing', 'x')).toBe(false);
    storage.close();
  });
});
