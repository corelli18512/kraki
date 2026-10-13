/** Defensive relay-boundary QA. All keys/files are fixtures in a temporary KRAKI_HOME.
 * Failing security assertions are deliberately retained for the review report.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  decryptFromBlob, decryptV2, encryptToBlob, encryptV2, exportPublicKey,
  generateE2EKeyPair, generateIdentityKeyPair, generateKeyPair, isSignedMessage,
  isV2Payload, pairingProof, ReplayGuard, signChallenge, signMessage, verifySignature,
  type PairingClaim, type SignedMessage, type SignOptions,
} from '@kraki/crypto';
import { fragmentPayload, HEAD_CONTROL_TYPES } from '@kraki/protocol';

vi.mock('../logger.js', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return { ...real, unlinkSync: vi.fn(real.unlinkSync) };
});
vi.mock('../relay/consumer-messages.js', async (original) => {
  const real = await original<typeof import('../relay/consumer-messages.js')>();
  return { ...real, handleConsumerMessage: vi.fn(real.handleConsumerMessage) };
});

import { RelayClient } from '../relay-client.js';
import { KeyManager } from '../key-manager.js';
import { createPairingSecret, readTrustPolicy, TrustStore, writeTrustPolicy } from '../trust-store.js';
import { handleConsumerMessage } from '../relay/consumer-messages.js';
import { buildPushPreview, dispatchPushPreview } from '../relay/push-preview.js';
import { sendAttachmentChunk } from '../relay/attachments.js';
import { handleSessionReplay, handleSessionMessages, handleSessionMessagesRange } from '../relay/history.js';
import { appProofMessage } from '../local-link.js';
import { TentaclePulse } from '../tentacle-pulse.js';
import { WebSocket } from 'ws';

const COMPUTER = 'dev_computer';
// Reuse real RSA fixtures to keep the many route permutations inexpensive.
const computerRsa = generateKeyPair();
const phoneRsa = generateKeyPair();
const attackerRsa = generateKeyPair();
function app(id = 'dev_phone', hostile = false) {
  const rsa = hostile ? attackerRsa : phoneRsa;
  return { id, rsa, rsaCompact: exportPublicKey(rsa.publicKey), ik: generateIdentityKeyPair(), xk: generateE2EKeyPair() };
}
type App = ReturnType<typeof app>;
interface Sent { payload: Record<string, unknown>; target?: string | string[] }
interface PrivateClient {
  ws: unknown;
  handleMessage(msg: Record<string, unknown>): void;
  handlePulseDelivered(json: string, sender?: string, route?: 'head' | 'link'): void;
  onLocalDelivered(id: string, json: string): void;
  ensureLocalLink(): void;
  updateConsumerKeys(devices: unknown[]): void;
  appSigningKeys: Map<string, string>;
}
let home: string;
const savedHome = process.env.KRAKI_HOME;
const savedMode = process.env.KRAKI_DEVICE_TRUST;
const savedPort = process.env.KRAKI_LOCAL_LINK_PORT;
const clients: RelayClient[] = [];
const localSockets: WebSocket[] = [];
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'kraki-verify-tentacle-'));
  process.env.KRAKI_HOME = home;
  delete process.env.KRAKI_DEVICE_TRUST;
  process.env.KRAKI_LOCAL_LINK_PORT = '0';
  vi.mocked(handleConsumerMessage).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(fs.unlinkSync).mockReset().mockImplementation(realUnlink);
  for (const socket of localSockets.splice(0)) socket.terminate();
  for (const client of clients.splice(0)) client.disconnect();
  fs.rmSync(home, { recursive: true, force: true });
  for (const [key, value] of [['KRAKI_HOME', savedHome], ['KRAKI_DEVICE_TRUST', savedMode], ['KRAKI_LOCAL_LINK_PORT', savedPort]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
});
// Keep the genuine filesystem primitive for deterministic unlink-race injection.
const realUnlink = (await vi.importActual<typeof import('node:fs')>('node:fs')).unlinkSync;

function setup(mode: 'enforce' | 'compatible' | 'policy' = 'enforce', options: { fresh?: boolean; local?: boolean; socket?: boolean } = {}) {
  const keyDir = join(home, 'keys');
  if (!options.fresh) {
    fs.mkdirSync(keyDir, { recursive: true });
    if (!fs.existsSync(join(keyDir, 'private.pem'))) fs.writeFileSync(join(keyDir, 'private.pem'), computerRsa.privateKey, { mode: 0o600 });
  }
  const keyManager = new KeyManager(keyDir);
  const adapter = {
    generateTitle: vi.fn(async () => null), sendMessage: vi.fn(async () => {}),
    setTurnIdentity: vi.fn(), isTurnSettled: vi.fn(() => false), setSessionUsage: vi.fn(),
    getSessionUsage: vi.fn(() => null), registerSessionAgent: vi.fn(), setSessionMode: vi.fn(),
    resumeSession: vi.fn(async (sessionId: string) => ({ sessionId })),
  } as Record<string, unknown>;
  const history = [{ type: 'agent_message', seq: 1, payload: JSON.stringify({ type: 'agent_message', sessionId: 's1', payload: { text: 'SECRET_HISTORY' } }) }];
  const sessionManager = new Proxy({
    getSessionList: vi.fn(() => []), getMeta: vi.fn(() => ({ agent: 'copilot', state: 'idle', lastSeq: 1 })),
    getInputLedgerEntry: vi.fn(() => null), findUserMessageSeqByClientId: vi.fn(() => null),
    appendMessage: vi.fn(() => 1), getAllLinks: vi.fn(() => []), getLink: vi.fn(() => null),
    countArchived: vi.fn(() => 0), getPendingHumanAction: vi.fn(() => null), readCurrentTurnArtifacts: vi.fn(() => []),
    getResumableSessions: vi.fn(() => []), autoArchive: vi.fn(() => []),
    getMessagesAfterSeq: vi.fn(() => history), findTurnAlignedStart: vi.fn(() => 1),
  } as Record<string, unknown>, {
    get(target, prop: string) { return target[prop] ??= vi.fn(() => null); },
  });
  const client = new RelayClient(adapter as never, sessionManager as never, {
    relayUrl: 'ws://127.0.0.1:1', authMethod: 'open',
    device: { name: 'QA Computer', role: 'tentacle', deviceId: COMPUTER },
    ...(mode === 'policy' ? {} : { deviceTrust: mode }), localLink: options.local ?? false,
  }, keyManager);
  clients.push(client);
  const priv = client as unknown as PrivateClient;
  const sent: Sent[] = [];
  vi.spyOn(client.pulse, 'send').mockImplementation(((payload: string, target?: string | string[]) => {
    sent.push({ payload: JSON.parse(payload), target });
  }) as never);
  if (!options.socket) priv.ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
  client.authInfo = { type: 'auth_ok', deviceId: COMPUTER, devices: [] } as never;
  const tentacle = keyManager.getPublicIdentity();
  return {
    client, priv, adapter, sent, keyManager, tentacle,
    deliver: (payload: Record<string, unknown>, src?: string) => priv.handlePulseDelivered(JSON.stringify({ ...payload, ...(src === undefined ? {} : { src }) }), undefined, 'head'),
    control: (msg: Record<string, unknown>) => priv.handleMessage(msg),
  };
}
type Env = ReturnType<typeof setup>;
function joined(env: Env, phone: App, override: Record<string, unknown> = {}) {
  env.control({ type: 'device_joined', device: { id: phone.id, name: phone.id, role: 'app', online: true, publicKey: phone.rsaCompact, ...override } });
}
function wire(env: Env, message: SignedMessage | Record<string, unknown>) {
  return { v: 2, blob: encryptV2(JSON.stringify(message), [{ recipientId: COMPUTER, publicKey: env.tentacle.encryptionKey }]) };
}
function signed(env: Env, phone: App, body: Record<string, unknown>, opts: SignOptions & { to?: string } = {}) {
  return signMessage(JSON.stringify({ deviceId: phone.id, ...body }), phone.id, opts.to ?? COMPUTER, phone.ik.privateKey, opts);
}
function request(env: Env, phone: App, secret: string | null, override: Partial<PairingClaim> = {}, local = false) {
  const claim: PairingClaim = { tentacleId: COMPUTER, appId: phone.id, identityKey: phone.ik.publicKey, encryptionKey: phone.xk.publicKey, rsaKey: phone.rsaCompact, ts: Date.now(), ...override };
  // A malformed claim has no valid proof at all (pairingProof refuses it).
  let proof: string | undefined;
  try { proof = secret ? pairingProof(secret, claim) : undefined; } catch { proof = 'AAAA'; }
  return wire(env, signed(env, phone, { type: 'pair_request', payload: { claim, ...(proof ? { proof } : {}), ...(local ? { local: true } : {}) } }));
}
function paired(mode: 'enforce' | 'compatible' | 'policy' = 'enforce') {
  if (mode === 'policy') writeTrustPolicy(join(home, 'trust'), { enforce: true });
  const env = setup(mode);
  const phone = app();
  joined(env, phone);
  env.deliver(request(env, phone, createPairingSecret(home)), phone.id);
  expect(env.client.deviceTrust!.isTrusted(phone.id)).toBe(true);
  vi.mocked(handleConsumerMessage).mockClear();
  env.sent.length = 0;
  return { env, phone };
}
function open(env: Env, phone: App, payload: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const text = isV2Payload(payload) ? decryptV2(payload.blob, phone.id, phone.xk.privateKey) : decryptFromBlob(payload as never, phone.id, phone.rsa.privateKey);
    const outer = JSON.parse(text);
    if (!isSignedMessage(outer)) return outer;
    expect(verifySignature(outer, env.tentacle.identityKey)).toBe(true);
    return JSON.parse(outer.body);
  } catch { return null; }
}
function readable(env: Env, phone: App) { return env.sent.map(s => open(env, phone, s.payload)).filter(Boolean); }
function fragments(payload: Record<string, unknown>) { return fragmentPayload(JSON.stringify(payload), randomUUID(), 40, 0)!.map(s => JSON.parse(s)); }
const evil = { type: 'send_input', sessionId: 's1', payload: { text: 'RELAY_INJECTED_INPUT' } };
async function flush() { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); }
function enrollment(phone: App, overrides: Record<string, unknown> = {}, mode = 0o600) {
  const path = join(home, 'trust', 'local-enroll', `${phone.id}.json`);
  fs.mkdirSync(join(home, 'trust', 'local-enroll'), { recursive: true });
  fs.writeFileSync(path, JSON.stringify({ appId: phone.id, identityKey: phone.ik.publicKey, encryptionKey: phone.xk.publicKey, ts: Date.now(), ...overrides }), { mode });
  fs.chmodSync(path, mode);
  return path;
}

// Delivers real Pulse wire frames through RelayClient.handleMessage, not just its decrypt seam.
function pulseRoute(env: Env) {
  const incoming: string[] = [];
  const head = new TentaclePulse({ now: Date.now, onDelivered: () => {}, sendPulseFrame: frame => incoming.push(frame) }, 'hostile-head');
  head.onConnected();
  const drain = () => { for (const pulse of incoming.splice(0)) env.control({ type: 'unicast', pulse }); };
  drain();
  return (payload: Record<string, unknown>) => { head.send(JSON.stringify(payload)); drain(); };
}

async function localRoute(env: Env, phone: App) {
  // Exercise the production LocalLinkServer including RSA challenge and Pulse.
  (env.client as unknown as { options: { localLink: boolean } }).options.localLink = true;
  env.priv.ensureLocalLink();
  await vi.waitFor(() => expect(env.client.localLink?.listening).toBe(true));
  const { port } = JSON.parse(fs.readFileSync(join(home, 'local-link.json'), 'utf8'));
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  localSockets.push(ws);
  let ready = false;
  const pulse = new TentaclePulse({ now: Date.now, onDelivered: () => {}, sendPulseFrame: frame => ws.send(JSON.stringify({ type: 'pulse', pulse: frame })) }, `local-qa:${phone.id}`);
  ws.on('message', data => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'challenge') ws.send(JSON.stringify({ type: 'auth', signature: signChallenge(appProofMessage(msg.nonce, COMPUTER, phone.id), phone.rsa.privateKey) }));
    else if (msg.type === 'ready') { ready = true; pulse.onConnected(); }
    else if (msg.type === 'pulse') pulse.onFrame(msg.pulse);
  });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'hello', v: 1, appId: phone.id, nonce: 'a'.repeat(32) }));
  await vi.waitFor(() => expect(ready).toBe(true));
  return (payload: Record<string, unknown>) => pulse.send(JSON.stringify(payload));
}

describe('Tentacle command acceptance at every inbound route', () => {
  it.each(['direct', 'pulse', 'fragments', 'local'] as const)('%s rejects unsigned and foreign-signed payloads; signed paired command works', async route => {
    const { env, phone } = paired();
    const deliver = route === 'pulse' ? pulseRoute(env) : route === 'local' ? await localRoute(env, phone) :
      route === 'direct' ? (payload: Record<string, unknown>) => env.control({ type: 'unicast', ...payload }) :
      (payload: Record<string, unknown>) => { for (const part of fragments(payload)) env.deliver(part, 'arbitrary-fragment-source'); };
    const unsignedBody = { ...evil, deviceId: phone.id };
    const foreign = signMessage(JSON.stringify(unsignedBody), phone.id, COMPUTER, generateIdentityKeyPair().privateKey);
    for (const body of [unsignedBody, foreign]) {
      const payload = route === 'direct' ? encryptToBlob(JSON.stringify(body), [{ deviceId: COMPUTER, publicKey: env.keyManager.getKeyPair().publicKey }]) : wire(env, body);
      deliver({ ...payload, src: phone.id });
    }
    await flush();
    expect(handleConsumerMessage).not.toHaveBeenCalled();
    expect(env.adapter.sendMessage).not.toHaveBeenCalled();
    expect(env.client.deviceTrust!.enforced).toBe(true);
    // A genuinely signed message uses the same route (fragments must agree with its sender).
    if (route === 'fragments') for (const part of fragments(wire(env, signed(env, phone, evil)))) env.deliver(part, phone.id);
    else deliver(route === 'direct' ? encryptToBlob(JSON.stringify(signed(env, phone, evil)), [{ deviceId: COMPUTER, publicKey: env.keyManager.getKeyPair().publicKey }]) : wire(env, signed(env, phone, evil)));
    await vi.waitFor(() => expect(env.adapter.sendMessage).toHaveBeenCalledTimes(1));
  });

  it.each([...HEAD_CONTROL_TYPES, 'account_deleted', 'send_input', 'set_trust_policy', 'auth_ok', 'auth_error'])('Head wrapper %s never dispatches arbitrary command content', type => {
    const { env, phone } = paired('policy');
    const message = { ...evil, type, deviceId: phone.id, device: { id: 'dev_rogue', role: 'app', publicKey: exportPublicKey(attackerRsa.publicKey) }, payload: { ...evil.payload, enforce: false } };
    env.deliver({ from: '@head', msg: message }, 'anything');
    expect(handleConsumerMessage).not.toHaveBeenCalled();
    expect(env.client.deviceTrust!.enforced).toBe(true);
    expect(env.client.deviceTrust!.isTrusted('dev_rogue')).toBe(false);
    expect(env.client.deviceTrust!.isTrusted(phone.id)).toBe(type !== 'device_removed');
  });

  it.each([...HEAD_CONTROL_TYPES, 'account_deleted'])('malformed Head wrapper %s cannot become a consumer message', type => {
    const { env } = paired('policy');
    for (const extra of [{}, { device: null, deviceId: {} }, { device: { role: 'app', id: {} }, payload: null }]) {
      // The socket callback catches handler errors; emulate that outer boundary.
      try { env.deliver({ from: '@head', msg: { type, ...extra } }); } catch { /* malformed control: socket logs only */ }
    }
    expect(handleConsumerMessage).not.toHaveBeenCalled();
    expect(env.client.deviceTrust!.enforced).toBe(true);
  });

  it('direct plaintext command and trust administration are ignored', () => {
    const { env, phone } = paired('policy');
    for (const type of ['send_input', 'set_trust_policy', 'revoke_device']) env.control({ ...evil, type, deviceId: phone.id, payload: { enforce: false, deviceId: phone.id } });
    expect(handleConsumerMessage).not.toHaveBeenCalled();
    expect(env.client.deviceTrust!.enforced).toBe(true);
    expect(env.client.deviceTrust!.isTrusted(phone.id)).toBe(true);
  });

  it('local link rejects Head wrappers', async () => {
    const { env, phone } = paired();
    const deliver = await localRoute(env, phone);
    deliver({ from: '@head', msg: { type: 'device_removed', deviceId: phone.id } });
    await flush();
    expect(env.client.deviceTrust!.isTrusted(phone.id)).toBe(true);
  });

  it('VT-LOCAL-FRAGMENT: local link also rejects fragmented Head wrappers', async () => {
    const { env, phone } = paired();
    const deliver = await localRoute(env, phone);
    for (const part of fragments({ from: '@head', msg: { type: 'device_removed', deviceId: phone.id } })) deliver(part);
    await vi.waitFor(() => expect(env.client.getLocalLinkStats()?.payloadsIn).toBeGreaterThan(1));
    expect(env.client.deviceTrust!.isTrusted(phone.id)).toBe(true);
  });

  it.each(['direct', 'pulse-without-src'])('VT-COMPAT-IMPERSONATION: %s rejects unsigned content claiming a paired app', async route => {
    const { env, phone } = paired('compatible');
    const payload = encryptToBlob(JSON.stringify({ ...evil, deviceId: phone.id }), [{ deviceId: COMPUTER, publicKey: env.keyManager.getKeyPair().publicKey }]);
    if (route === 'direct') env.control({ type: 'unicast', ...payload }); else env.deliver(payload);
    await flush();
    expect(env.adapter.sendMessage).not.toHaveBeenCalled();
  });
});

describe('Tentacle pairing edge cases', () => {
  it('captured pair_request cannot enroll again after removal, including a restarted store', () => {
    const env = setup(); const phone = app();
    const captured = request(env, phone, createPairingSecret(home));
    env.deliver(captured, phone.id);
    env.control({ type: 'device_removed', deviceId: phone.id });
    env.deliver(captured, phone.id);
    expect(env.client.deviceTrust!.isTrusted(phone.id)).toBe(false);
    env.client.deviceTrust!.store.flushReplay();
    const restarted = setup();
    restarted.deliver(captured, phone.id);
    expect(restarted.client.deviceTrust!.isTrusted(phone.id)).toBe(false);
  });

  it('two pending requests with one secret enroll exactly one app', async () => {
    const env = setup(); const a = app('dev_a'); const b = app('dev_b');
    const secret = createPairingSecret(home);
    const requests = [request(env, a, secret), request(env, b, secret)];
    await Promise.all(requests.map((payload, i) => Promise.resolve().then(() => env.deliver(payload, [a.id, b.id][i]))));
    expect(env.client.deviceTrust!.store.ids()).toHaveLength(1);
    expect(fs.readdirSync(join(home, 'trust', 'pairings'))).toEqual([]);
  });

  it('QR unlink race loses safely and does not enroll', () => {
    const env = setup(); const phone = app();
    const captured = request(env, phone, createPairingSecret(home));
    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => { throw new Error('another process consumed secret'); });
    env.deliver(captured, phone.id);
    expect(env.client.deviceTrust!.isTrusted(phone.id)).toBe(false);
  });

  it.each([{ tentacleId: 'dev_elsewhere' }, { appId: 'dev_elsewhere' }, { encryptionKey: 'broken' }])('rejects malformed / misbound QR claim %j', override => {
    const env = setup(); const phone = app();
    env.deliver(request(env, phone, createPairingSecret(home), override), phone.id);
    expect(env.client.deviceTrust!.isTrusted(phone.id)).toBe(false);
  });

  it('expired QR secret is rejected', () => {
    const env = setup(); const phone = app();
    env.deliver(request(env, phone, createPairingSecret(home, Date.now() - 300_001)), phone.id);
    expect(env.client.deviceTrust!.isTrusted(phone.id)).toBe(false);
  });

  it.each([
    ['other appId', { appId: 'dev_other' }, 0o600], ['past clock', { ts: Date.now() - 660_000 }, 0o600],
    ['future clock', { ts: Date.now() + 660_000 }, 0o600], ['readable by others', {}, 0o644],
  ] as const)('local enrollment rejects %s', (_label, override, mode) => {
    const env = setup(); const phone = app(); enrollment(phone, override, mode);
    env.deliver(request(env, phone, null, {}, true), phone.id);
    expect(env.client.deviceTrust!.isTrusted(phone.id)).toBe(false);
  });

  it('local enrollment rejects a file not owned by the current uid', () => {
    const env = setup(); const phone = app(); const path = enrollment(phone);
    const uid = fs.statSync(path).uid;
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    try {
      env.deliver(request(env, phone, null, {}, true), phone.id);
      expect(env.client.deviceTrust!.isTrusted(phone.id)).toBe(false);
    } finally { getuid.mockRestore(); }
  });

  it.each([-600_001, -600_000, 600_000, 600_001])('local enrollment clock boundary %i ms', delta => {
    const env = setup(); const phone = app(); const now = Date.now();
    enrollment(phone, { ts: now + delta });
    expect(env.client.deviceTrust!.store.acceptLocalEnrollment(phone.id, phone.ik.publicKey, phone.xk.publicKey, now)).toBe(Math.abs(delta) <= 600_000);
  });

  it('a replacement local enrollment between read and unlink does not swap the accepted keys (same-user TOCTOU)', () => {
    const env = setup(); const phone = app(); const replacement = app('dev_replacement'); const path = enrollment(phone);
    vi.mocked(fs.unlinkSync).mockImplementationOnce(candidate => {
      expect(candidate).toBe(path);
      fs.writeFileSync(path, JSON.stringify({ appId: phone.id, identityKey: replacement.ik.publicKey, encryptionKey: replacement.xk.publicKey, ts: Date.now() }));
      realUnlink(candidate);
    });
    env.deliver(request(env, phone, null, {}, true), phone.id);
    expect(env.client.deviceTrust!.store.get(phone.id)?.identityKey).toBe(phone.ik.publicKey);
    expect(fs.existsSync(path)).toBe(false); // Replacement is lost: local-only DoS, not a key swap.
  });

  it('local enrollment accepts private symlink target owned by this user (same-user local trust zone)', () => {
    const env = setup(); const phone = app();
    const path = enrollment(phone); const target = join(home, 'private-enrollment.json');
    fs.renameSync(path, target); fs.symlinkSync(target, path);
    env.deliver(request(env, phone, null, {}, true), phone.id);
    expect(env.client.deviceTrust!.isTrusted(phone.id)).toBe(true);
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('VT-LOCAL-UNLINK: failed local enrollment unlink must not leave reusable authorization', () => {
    const env = setup(); const phone = app(); const path = enrollment(phone);
    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => { throw new Error('unlink failed'); });
    env.deliver(request(env, phone, null, {}, true), phone.id);
    expect(fs.existsSync(path)).toBe(true);
    // Consumption must succeed before granting trust; otherwise revocation can
    // be undone by this still-present enrollment after replay state is lost.
    expect(env.client.deviceTrust!.isTrusted(phone.id)).toBe(false);
  });

  it('corrupted devices store loses pins, but enforcing mode does not accept commands', async () => {
    const { env, phone } = paired();
    fs.writeFileSync(join(home, 'trust', 'devices.json'), '{');
    const restarted = setup();
    restarted.deliver(wire(restarted, signed(restarted, phone, evil)), phone.id);
    await flush();
    expect(restarted.client.deviceTrust!.store.ids()).toEqual([]);
    expect(restarted.adapter.sendMessage).not.toHaveBeenCalled();
    // The user can recover with a new optical pairing secret.
    restarted.deliver(request(restarted, phone, createPairingSecret(home)), phone.id);
    expect(restarted.client.deviceTrust!.isTrusted(phone.id)).toBe(true);
    void env;
  });
});

describe('Tentacle confidentiality: outbound keys stay pinned', () => {
  it.each(['device_joined', 'auth_ok-key-cache'])('%s relay key replacement cannot decrypt any shared outbound path', method => {
    const { env, phone } = paired(); const head = app(phone.id, true);
    const replacement = { id: phone.id, name: 'relay alias', role: 'app', online: true, publicKey: head.rsaCompact, encryptionKey: head.xk.publicKey };
    if (method === 'device_joined') env.control({ type: method, device: replacement });
    else env.control({ type: 'auth_ok', deviceId: COMPUTER, devices: [replacement] });
    expect(env.client.consumerKeys.get(phone.id)).toBe(phone.rsaCompact);
    expect(env.client.deviceTrust!.store.get(phone.id)?.encryptionKey).toBe(phone.xk.publicKey);
    env.sent.length = 0;
    // Every current sendReliableUnicastTo caller funnels through this one seal.
    const callerTypes = ['session_list', 'device_greeting', 'device_usage', 'usage_history', 'local_sessions_list', 'archived_session_list', 'user_message', 'session_replay_batch', 'session_messages_batch', 'session_messages_range_batch', 'turn_trace_batch', 'session_subscription_set', 'card_action', 'trusted_devices', 'local_notification', 'attachment_data'];
    for (const type of callerTypes) env.client.sendReliableUnicastTo(phone.id, head.rsaCompact, { type, payload: { text: 'SECRET_UNICAST' } });
    sendAttachmentChunk(env.client, phone.id, head.rsaCompact, 's1', 'image', 'text/plain', 0, 1, Buffer.from('SECRET_ATTACHMENT'), true);
    handleSessionReplay(env.client, phone.id, 's1', 0);
    handleSessionMessages(env.client, phone.id, 's1', undefined);
    handleSessionMessagesRange(env.client, phone.id, 's1', 1, 1);
    (env.adapter.onMessage as (id: string, msg: { content: string }) => void)('s1', { content: 'SECRET_BROADCAST' });
    expect(env.sent.length).toBeGreaterThan(callerTypes.length);
    expect(env.sent.every(s => isV2Payload(s.payload))).toBe(true);
    expect(readable(env, head)).toEqual([]);
    expect(readable(env, phone)).toHaveLength(env.sent.length);
    expect(JSON.stringify(readable(env, phone))).toContain('SECRET_UNICAST');
    expect(JSON.stringify(readable(env, phone))).toContain(Buffer.from('SECRET_ATTACHMENT').toString('base64'));
    expect(JSON.stringify(readable(env, phone))).toContain('SECRET_HISTORY');
    expect(JSON.stringify(readable(env, phone))).toContain('SECRET_BROADCAST');
    env.client.closingTurnPush.set('s1', {}); env.client.lastAgentContent.set('s1', 'SECRET_PREVIEW');
    const preview = buildPushPreview(env.client, { type: 'idle', sessionId: 's1' })!.trusted!;
    expect(Object.keys(preview.keys)).toEqual([phone.id]);
    expect(preview.keys[phone.id].startsWith('v2.')).toBe(true);
    expect(() => decryptV2(preview.keys[phone.id].slice(3), phone.id, head.xk.privateKey)).toThrow();
    expect(decryptV2(preview.keys[phone.id].slice(3), phone.id, phone.xk.privateKey)).toContain('SECRET_PREVIEW');
  });

  it('local_notification uses the pinned X25519 key even when consumerKeys has a stale hostile RSA key', () => {
    const { env, phone } = paired(); const head = app(phone.id, true);
    env.client.consumerKeys.set(phone.id, head.rsaCompact);
    const localSent: Sent[] = [];
    env.client.localLink = { peerIds: () => [phone.id], has: () => true, stop: () => {}, send: (_id: string, json: string) => { localSent.push({ payload: JSON.parse(json) }); return true; } } as never;
    env.client.closingTurnPush.set('s1', {}); env.client.lastAgentContent.set('s1', 'SECRET_LOCAL_PREVIEW');
    dispatchPushPreview(env.client, { type: 'idle', sessionId: 's1' });
    expect(localSent).toHaveLength(1);
    expect(open(env, phone, localSent[0].payload)).toMatchObject({ type: 'local_notification' });
    expect(open(env, head, localSent[0].payload)).toBeNull();
  });
});

describe('Tentacle policy and replay persistence', () => {
  it('unsigned and foreign-signed policy changes cannot downgrade an enforcing computer', () => {
    const { env, phone } = paired('policy'); const rogue = app('dev_rogue', true);
    const body = { type: 'set_trust_policy', deviceId: phone.id, payload: { enforce: false } };
    env.deliver(wire(env, body), phone.id);
    env.deliver(wire(env, signMessage(JSON.stringify(body), phone.id, COMPUTER, rogue.ik.privateKey)), phone.id);
    env.deliver(wire(env, signed(env, rogue, { type: 'set_trust_policy', payload: { enforce: false, revision: env.client.deviceTrust!.store.policyRevision } })), rogue.id);
    expect(env.client.deviceTrust!.enforced).toBe(true);
  });

  it('a valid paired signature or explicit local edit can change an unlocked policy; fixed mode stays locked', () => {
    const { env, phone } = paired('policy');
    env.deliver(wire(env, signed(env, phone, { type: 'set_trust_policy', payload: { enforce: false, revision: env.client.deviceTrust!.store.policyRevision } })), phone.id);
    expect(env.client.deviceTrust!.enforced).toBe(false);
    writeTrustPolicy(join(home, 'trust'), { enforce: true });
    env.client.deviceTrust!.store.refresh();
    expect(env.client.deviceTrust!.enforced).toBe(true);
    const locked = setup('enforce');
    locked.deliver(wire(locked, signed(locked, phone, { type: 'set_trust_policy', payload: { enforce: false, revision: locked.client.deviceTrust!.store.policyRevision } })), phone.id);
    expect(locked.client.deviceTrust!.enforced).toBe(true);
  });

  it('captured set_trust_policy cannot override a newer policy within the replay window', () => {
    const { env, phone } = paired('policy');
    const old = wire(env, signed(env, phone, { type: 'set_trust_policy', payload: { enforce: false, revision: env.client.deviceTrust!.store.policyRevision } }));
    env.deliver(old, phone.id);
    env.deliver(wire(env, signed(env, phone, { type: 'set_trust_policy', payload: { enforce: true, revision: env.client.deviceTrust!.store.policyRevision } })), phone.id);
    env.deliver(old, phone.id);
    expect(env.client.deviceTrust!.enforced).toBe(true);
  });

  it('another computer-specific signature cannot disable this computer', () => {
    const { env, phone } = paired('policy');
    env.deliver(wire(env, signed(env, phone, { type: 'set_trust_policy', payload: { enforce: false, revision: env.client.deviceTrust!.store.policyRevision } }, { to: 'dev_other_computer' })), phone.id);
    expect(env.client.deviceTrust!.enforced).toBe(true);
  });

  it('VT-WILDCARD-ADMIN: multi-computer to:"*" policy message cannot downgrade this computer', () => {
    const { env, phone } = paired('policy');
    // A captured multi-recipient envelope can be delivered to either recipient.
    // This asserts target-specific authorization for a security policy change.
    const other = generateE2EKeyPair();
    const message = signed(env, phone, { type: 'set_trust_policy', payload: { enforce: false, revision: env.client.deviceTrust!.store.policyRevision, tentacleId: 'dev_other_computer' } }, { to: '*' });
    const captured = { v: 2, blob: encryptV2(JSON.stringify(message), [{ recipientId: COMPUTER, publicKey: env.tentacle.encryptionKey }, { recipientId: 'dev_other_computer', publicKey: other.publicKey }]) };
    env.deliver(captured, phone.id);
    expect(env.client.deviceTrust!.enforced).toBe(true);
  });

  it('normal restart after replay flush rejects the captured command', async () => {
    const { env, phone } = paired(); const captured = wire(env, signed(env, phone, evil));
    env.deliver(captured, phone.id); env.client.deviceTrust!.store.flushReplay();
    const restarted = setup(); restarted.deliver(captured, phone.id); await flush();
    expect(restarted.adapter.sendMessage).not.toHaveBeenCalled();
  });

  it('VT-CRASH-REPLAY: abrupt restart before the one-second flush rejects the captured command', async () => {
    const { env, phone } = paired(); const captured = wire(env, signed(env, phone, evil));
    env.client.deviceTrust!.store.flushReplay(); // persist pairing, not the command
    env.deliver(captured, phone.id); await flush();
    expect(env.adapter.sendMessage).toHaveBeenCalledTimes(1);
    // A new process reads exactly these disk files; no graceful disconnect/flush.
    const restarted = setup(); restarted.deliver(captured, phone.id); await flush();
    expect(restarted.adapter.sendMessage).not.toHaveBeenCalled();
  });

  it('VT-CRASH-DOWNGRADE: crash-window replay of an old policy-off message cannot enable relay injection', async () => {
    const { env, phone } = paired('policy'); env.client.deviceTrust!.store.flushReplay();
    const captured = wire(env, signed(env, phone, { type: 'set_trust_policy', payload: { enforce: false, revision: env.client.deviceTrust!.store.policyRevision } }));
    env.deliver(captured, phone.id);
    env.deliver(wire(env, signed(env, phone, { type: 'set_trust_policy', payload: { enforce: true, revision: env.client.deviceTrust!.store.policyRevision } })), phone.id);
    expect(readTrustPolicy(join(home, 'trust')).enforce).toBe(true);
    const restarted = setup('policy'); restarted.deliver(captured, phone.id);
    const rogue = app('dev_rogue', true); joined(restarted, rogue);
    restarted.deliver(encryptToBlob(JSON.stringify({ ...evil, deviceId: rogue.id }), [{ deviceId: COMPUTER, publicKey: restarted.keyManager.getKeyPair().publicKey }]), rogue.id);
    await flush();
    expect(restarted.adapter.sendMessage).not.toHaveBeenCalled();
  });

  it('VT-CORRUPT-POLICY: corrupted enforcing policy does not silently fail open', () => {
    const { env } = paired('policy');
    fs.writeFileSync(join(home, 'trust', 'policy.json'), '{');
    env.client.deviceTrust!.store.refresh();
    expect(env.client.deviceTrust!.enforced).toBe(true);
  });

  it('VT-CORRUPT-REPLAY: corrupted replay state does not reopen accepted command nonces', async () => {
    const { env, phone } = paired(); const captured = wire(env, signed(env, phone, evil));
    env.deliver(captured, phone.id); env.client.deviceTrust!.store.flushReplay();
    fs.writeFileSync(join(home, 'trust', 'replay.json'), '{');
    const restarted = setup(); restarted.deliver(captured, phone.id); await flush();
    expect(restarted.adapter.sendMessage).not.toHaveBeenCalled();
  });

  it.each([[-900_001, 'stale'], [-900_000, null], [600_000, null], [600_001, 'from_future']] as const)('replay boundary %i ms yields %s', (delta, rejection) => {
    const now = 1_000_000;
    const guard = new ReplayGuard({ now: () => now });
    expect(guard.check({ from: 'dev_a', ts: now + delta, nonce: 'nonce' })).toBe(rejection);
  });

  it('identical nonces from different paired senders are independent', async () => {
    const { env, phone } = paired(); const second = app('dev_second');
    env.deliver(request(env, second, createPairingSecret(home)), second.id);
    for (const sender of [phone, second]) env.deliver(wire(env, signed(env, sender, { ...evil, sessionId: sender.id }, { nonce: 'U0FNRV9OT05DRV8xMjM0NQ' })), sender.id);
    await flush();
    expect(env.adapter.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('VT-FRESH-STARTUP: a fresh computer enforces before its first relay frame', async () => {
    const env = setup('policy', { fresh: true });
    // setup creates the identity via the same KeyManager lazy call used by auth.
    // The store existed first, as it does in daemon-worker.ts.
    expect(readTrustPolicy(join(home, 'trust')).enforce).toBe(true);
    const rogue = app('dev_rogue', true); joined(env, rogue);
    env.deliver(wire(env, { ...evil, deviceId: rogue.id }), rogue.id);
    await flush();
    expect(env.adapter.sendMessage).not.toHaveBeenCalled();
  });

  it('VT-FRESH-SOCKET: compromised loopback relay exploits the fresh-install initialization interval', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>(resolve => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    const env = setup('policy', { fresh: true, socket: true });
    // Warm the same lazy key calls used by buildAuthPayload, avoiding RSA CPU timing.
    env.keyManager.getCompactPublicKey();
    const rogue = app('dev_rogue', true);
    (env.client as unknown as { options: { relayUrl: string } }).options.relayUrl = `ws://127.0.0.1:${port}`;
    server.on('connection', ws => ws.once('message', () => {
      ws.send(JSON.stringify({ type: 'auth_ok', deviceId: COMPUTER, devices: [{ id: rogue.id, name: 'Relay-added', role: 'app', online: true, publicKey: rogue.rsaCompact }] }));
      ws.send(JSON.stringify({ type: 'unicast', ...encryptToBlob(JSON.stringify({ ...evil, deviceId: rogue.id }), [{ deviceId: COMPUTER, publicKey: env.keyManager.getKeyPair().publicKey }]) }));
    }));
    try {
      env.client.connect();
      await vi.waitFor(() => expect(env.client.getState()).toBe('connected'));
      await flush();
      expect(readTrustPolicy(join(home, 'trust')).enforce).toBe(true);
      expect(env.adapter.sendMessage).not.toHaveBeenCalled();
    } finally {
      env.client.disconnect(); for (const ws of server.clients) ws.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 15_000);

  it('malformed local enrollment, pairing secret, and trust-device entries do not enroll a relay app', () => {
    const env = setup(); const phone = app(); const path = enrollment(phone);
    fs.writeFileSync(path, '{');
    env.deliver(request(env, phone, null, {}, true), phone.id);
    const secret = createPairingSecret(home);
    const pairingPath = join(home, 'trust', 'pairings', fs.readdirSync(join(home, 'trust', 'pairings'))[0]);
    fs.writeFileSync(pairingPath, '{');
    env.deliver(request(env, phone, secret), phone.id);
    fs.writeFileSync(join(home, 'trust', 'devices.json'), JSON.stringify({ version: 1, devices: { [phone.id]: { identityKey: 'invalid', encryptionKey: phone.xk.publicKey } } }));
    expect(new TrustStore(join(home, 'trust')).ids()).toEqual([]);
    expect(env.client.deviceTrust!.isTrusted(phone.id)).toBe(false);
  });

  it('raw auth_error account_deleted irreversibly stops this client, without executing consumer content', () => {
    const { env } = paired(); const deletion = vi.fn(); env.client.onAccountDeleted = deletion;
    env.control({ type: 'auth_error', code: 'account_deleted', ...{ payload: evil } });
    expect(deletion).toHaveBeenCalledTimes(1);
    expect(env.client.getState()).toBe('disconnected');
    expect(handleConsumerMessage).not.toHaveBeenCalled();
  });

  it('raw account_deleted on a real socket invokes credential-deletion hook; Pulse wrapper does not', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>(resolve => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    const env = setup('enforce', { socket: true }); const deleted = vi.fn();
    env.client.onAccountDeleted = deleted;
    (env.client as unknown as { options: { relayUrl: string } }).options.relayUrl = `ws://127.0.0.1:${port}`;
    server.on('connection', ws => ws.once('message', () => ws.send(JSON.stringify({ type: 'account_deleted', payload: evil }))));
    try {
      env.deliver({ from: '@head', msg: { type: 'account_deleted' } });
      expect(deleted).not.toHaveBeenCalled();
      env.client.connect(); await vi.waitFor(() => expect(deleted).toHaveBeenCalledTimes(1));
      expect(env.client.getState()).toBe('disconnected');
      expect(handleConsumerMessage).not.toHaveBeenCalled();
    } finally {
      env.client.disconnect(); for (const ws of server.clients) ws.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
