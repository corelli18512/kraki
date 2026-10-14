import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KeyManager, RelayClient, SessionManager } from '@kraki/tentacle';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestEnv, createTmpSessionDir, type TestEnv } from './helpers.js';
import { connectHeadApp, EmitAdapter, ofType, until, type HeadApp } from './local-link-helpers.js';

let env: TestEnv | undefined;
let relay: RelayClient | undefined;
let app: HeadApp | undefined;
let directory: ReturnType<typeof createTmpSessionDir> | undefined;
const oldHome = process.env.KRAKI_HOME;
const oldMode = process.env.KRAKI_DEVICE_TRUST;

afterEach(async () => {
  app?.close(); relay?.disconnect();
  await env?.cleanup(); directory?.cleanup();
  if (oldHome === undefined) delete process.env.KRAKI_HOME; else process.env.KRAKI_HOME = oldHome;
  if (oldMode === undefined) delete process.env.KRAKI_DEVICE_TRUST; else process.env.KRAKI_DEVICE_TRUST = oldMode;
});

it('real relay: a new account app reads and sends after a formerly pairing-only computer upgrades', async () => {
  directory = createTmpSessionDir();
  process.env.KRAKI_HOME = directory.dir;
  process.env.KRAKI_DEVICE_TRUST = 'enforce'; // old deployment configuration
  const trust = join(directory.dir, 'trust');
  mkdirSync(trust);
  writeFileSync(join(trust, 'policy.json'), JSON.stringify({ enforce: true, revision: 7 }));
  const keys = new KeyManager(join(directory.dir, 'keys'));
  const identity = keys.getPublicIdentity();
  env = await createTestEnv();
  const adapter = new EmitAdapter();
  const received = vi.spyOn(adapter, 'sendMessage');
  relay = new RelayClient(adapter, new SessionManager(join(directory.dir, 'sessions')), {
    relayUrl: `ws://127.0.0.1:${env.port}`,
    authMethod: 'open',
    device: { name: 'Account computer', role: 'tentacle', kind: 'desktop' },
    localLink: false,
  }, keys);
  await new Promise<void>((resolve, reject) => {
    relay!.onAuthenticated = () => resolve();
    relay!.onFatalError = (message) => reject(new Error(message));
    relay!.connect();
  });
  const id = relay.getAuthInfo()!.deviceId;
  app = await connectHeadApp(env.port); // a new device, no pairing request or QR secret
  await until(() => ofType(app!.received, 'session_list').length > 0);
  expect(ofType(app.received, 'trust_required')).toHaveLength(0);
  app.sendReliable({ type: 'create_session', deviceId: app.deviceId, seq: 1,
    timestamp: new Date().toISOString(), payload: { agent: 'mock', prompt: 'login without pairing' } }, id, keys.getKeyPair().publicKey);
  await until(() => received.mock.calls.length > 0);
  expect(keys.getPublicIdentity()).toEqual(identity);
  expect(JSON.parse(readFileSync(join(trust, 'policy.json'), 'utf8'))).toMatchObject({ enforce: false });
  expect(JSON.parse(readFileSync(join(trust, 'policy.pairing-only.json'), 'utf8'))).toEqual({ enforce: true, revision: 7 });
}, 20_000);
