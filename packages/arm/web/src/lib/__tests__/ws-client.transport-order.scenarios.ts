// Test-only diagnostics: real production seams, synthetic identities, no sockets opened.
import { linkResponseScenarios } from './ws-client.link-response.scenarios';
import { Endpoint, StreamSet, type Effect } from '@kraki/pulse';
import { fragmentPayload } from '@kraki/protocol';
import type { SessionSubscriptionSetMessage } from '@kraki/protocol';
import { useStore } from '../../hooks/useStore';
import { outbox } from '../chat/outbox';
import { BrowserAppKeyStore } from '../e2e';
import { EncryptionHandler } from '../encryption';
import { KrakiWSClient } from '../ws-client';
import { messageProvider } from '../message-provider';
import * as db from '../message-db';
import { SessionSubscriptionController } from '../session-subscription';
import { LocalLinkClient } from '../local-link';
import { ArmPulse } from '../arm-pulse';
import type { ChatMessage } from '../../types/store';

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
export async function until(check: () => boolean, label: string, timeout = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
let runNumber = 0;
export let sessionId = 'transport-synthetic-session';
export const deviceId = 'transport-synthetic-tentacle';
export const appId = 'transport-synthetic-app';
const message = (seq: number, type = 'agent_message', payload: object = { content: `row ${seq}` }): ChatMessage =>
  ({ type, seq, sessionId, deviceId, timestamp: '2026-10-15T00:00:00Z', payload }) as ChatMessage;

export async function reset() {
  messageProvider.clear();
  useStore.getState().reset();
  outbox.reset();
  await db.clearAllMessages();
  // Unique session isolates fire-and-forget IDB writes from earlier scenarios.
  sessionId = `transport-synthetic-session-${++runNumber}`;
  useStore.getState().setAuth(appId);
  useStore.getState().setStatus('connected');
  useStore.getState().setDevices([{ id: deviceId, role: 'tentacle', online: true, name: 'Synthetic only' }]);
  useStore.getState().setSessions([{ id: sessionId, deviceId, deviceName: 'Synthetic only', agent: 'pi', state: 'active', messageCount: 10, lastSeq: 10, readSeq: 4 }]);
  outbox.configure({ send: async () => true, isDeliveryPathUp: () => false });
}

export function ack(id = sessionId, head = 0, draft = ''): SessionSubscriptionSetMessage {
  return {
    type: 'session_subscription_set', deviceId, seq: 1, timestamp: '',
    payload: { accepted: true, sessionId: id, snapshot: {
      digest: { id, agent: 'pi', state: 'active', mode: 'execute', lastSeq: head, readSeq: 4, messageCount: head, createdAt: '' },
      spineHeadSeq: head, card: { draft, action: null },
    } },
  };
}

// Explicit private-seam access, only in this diagnostic bundle. No production export added.
type ClientSeams = {
  encryption: EncryptionHandler;
  subscription: SessionSubscriptionController;
  handlePulseDelivered(payload: string, route?: 'head' | 'link', sender?: string, streamId?: number): void;
  route(payload: string, to: string, durable: boolean, replayable: boolean): bigint;
  localLink: { isLinked(sender?: string): boolean; stats: { staleHeadFrames: number } } | null;
  pulse: ArmPulse;
  onLocalLinkChange(id: string, linked: boolean, unacked: []): void;
  handleMessage(msg: any): void;
};
function client() {
  const instance = new KrakiWSClient('ws://127.0.0.1:1');
  const seams = instance as unknown as ClientSeams;
  // Disable provider's singleton send route. All history requests terminate here.
  messageProvider.setSend(() => {});
  return { instance, seams };
}
export function confirm(seams: ClientSeams) {
  seams.subscription.onSessionList(deviceId);
  seams.subscription.setDesired(sessionId);
  seams.subscription.onAck(ack());
}

let keys: BrowserAppKeyStore | undefined;
export async function cryptoFixture() {
  if (!keys) { keys = new BrowserAppKeyStore(); await keys.init(); }
  useStore.getState().upsertDevice({ id: deviceId, role: 'tentacle', online: true, name: 'Synthetic only', encryptionKey: await keys.getPublicKey() });
  const { instance, seams } = client();
  seams.encryption = new EncryptionHandler(keys);
  const encrypt = async (inner: unknown) => keys!.encryptToBlob(JSON.stringify(inner), [{ deviceId: appId, publicKeyBase64: await keys!.getPublicKey() }]);
  return { instance, seams, encrypt, keys };
}

export async function cryptoOrdering(kind: 'ack-delta' | 'deltas' | 'sends' | 'handover' | 'control' | 'legacy-deltas') {
  await reset();
  const { instance, seams, encrypt, keys } = await cryptoFixture();
  let subscriptionSent = false;
  seams.route = () => { subscriptionSent = true; return 1n; };
  if (kind !== 'ack-delta') confirm(seams);
  else { seams.subscription.onSessionList(deviceId); seams.subscription.setDesired(sessionId); }
  await until(() => subscriptionSent, 'real encrypted subscription admission');
  const gate = deferred();
  const started = deferred();
  if (kind === 'sends') {
    const original = keys.encryptToBlob.bind(keys);
    let count = 0;
    keys.encryptToBlob = async (...args) => {
      const result = await original(...args); // Real RSA-OAEP + AES-GCM, then delay completion.
      if (++count === 1) { started.resolve(); await gate.promise; } else secondDone.resolve();
      return result;
    };
    const secondDone = deferred();
    const sent: Array<{ blob: string; keys: Record<string, string> }> = [];
    seams.route = (payload) => { sent.push(JSON.parse(payload)); return BigInt(sent.length); };
    try {
      instance.sendEncrypted({ type: 'send_input', sessionId, payload: { text: 'first' } });
      await started.promise;
      instance.sendEncrypted({ type: 'send_input', sessionId, payload: { text: 'second' } });
      await secondDone.promise;
      await new Promise((r) => setTimeout(r, 0));
      const admittedBeforeFirstRelease = sent.length;
      gate.resolve();
      await until(() => sent.length === 2, 'first encrypted send');
      const order: string[] = [];
      for (const envelope of sent) {
        const plaintext = await keys.decryptFromBlob(envelope, deviceId);
        order.push(JSON.parse(plaintext).payload.text);
      }
      return { invariant: order.join(',') === 'first,second', order, admittedBeforeFirstRelease };
    } finally { keys.encryptToBlob = original; gate.resolve(); }
  }
  const first = await encrypt(kind === 'ack-delta' ? ack() : message(1, 'agent_message_delta', { content: 'first' }));
  const second = await encrypt(message(2, 'agent_message_delta', { content: 'second' }));
  const original = keys.decryptFromBlob.bind(keys);
  const secondDone = deferred();
  const firstDone = deferred();
  keys.decryptFromBlob = async (...args) => {
    const result = await original(...args);
    if (args[0].blob === first.blob && kind !== 'control') { started.resolve(); await gate.promise; }
    if (args[0].blob === second.blob) secondDone.resolve();
    if (args[0].blob === first.blob) firstDone.resolve();
    return result;
  };
  const seen: string[] = [];
  instance.onMessage((m) => seen.push(m.type));
  try {
    const receive = (envelope: object) => kind === 'legacy-deltas'
      ? seams.handleMessage({ type: 'unicast', ...envelope, src: deviceId })
      : seams.handlePulseDelivered(JSON.stringify({ ...envelope, src: deviceId }), 'head');
    receive(first);
    if (kind !== 'control') await started.promise;
    if (kind === 'handover') {
      // Synthetic route state transition only, NOT a native local-link handshake.
      seams.localLink = { isLinked: () => true, stats: { staleHeadFrames: 0 } };
      useStore.getState().applyCardMessage(sessionId, 'fresh-link-snapshot', true);
      gate.resolve();
      await firstDone.promise;
      await new Promise((r) => setTimeout(r, 0));
      const text = useStore.getState().cards.get(sessionId)?.text;
      return { invariant: text === 'fresh-link-snapshot', text, staleDropped: seams.localLink.stats.staleHeadFrames };
    }
    if (kind === 'control') await until(() => seen.length === 1, 'first ordered delta');
    receive(second);
    // Observe actual second decryption completion even when subscription gating drops delivery.
    await secondDone.promise;
    await new Promise((r) => setTimeout(r, 0));
    gate.resolve();
    await firstDone.promise;
    await new Promise((r) => setTimeout(r, 0));
    const text = useStore.getState().cards.get(sessionId)?.text ?? '';
    return { invariant: text === (kind === 'ack-delta' ? 'second' : 'firstsecond'), text, liveReady: instance.isLiveReady(sessionId), seen };
  } finally { keys.decryptFromBlob = original; gate.resolve(); }
}

export async function ordinaryInputRetention() {
  const pending: Uint8Array[] = [];
  let now = 0;
  const delivered: string[] = [];
  const arm = new ArmPulse({ now: () => now, sendPulseFrame: (wire) => pending.push(Uint8Array.from(atob(wire), (c) => c.charCodeAt(0))), onDelivered: () => {}, onAcked: () => {} }, 'synthetic-arm');
  const peer = new StreamSet([
    new Endpoint({ epoch: 'synthetic-head:live', streamId: 0 }),
    new Endpoint({ epoch: 'synthetic-head:bulk', streamId: 1 }),
  ]);
  const feed = (effects: Effect[]) => {
    for (const e of effects) {
      if (e.t === 'transmit') arm.onFrame(btoa(String.fromCharCode(...e.bytes)));
      if (e.t === 'deliver') {
        const raw = new TextDecoder().decode(e.payload);
        delivered.push(raw);
      }
    }
  };
  const pump = () => { while (pending.length) for (const bytes of pending.splice(0)) feed(peer.onBytes(bytes, now)); };
  arm.onConnected(); feed(peer.onConnected(now)); pump();
  const wireSend = (msg: Record<string, unknown>) => arm.send(JSON.stringify(msg), deviceId, false);
  wireSend({ type: 'send_input', sessionId, payload: { text: 'synthetic input' } });
  pending.length = 0; // Fault injection: drop the DATA before it reaches peer (or after ACK for control).
  arm.onDisconnected(); peer.onDisconnected(now); now += 1000;
  arm.onConnected(); feed(peer.onConnected(now)); pump();
  return { invariant: delivered.length === 1 && JSON.parse(delivered[0]).type === 'send_input', delivered: delivered.map(raw => JSON.parse(raw).type) };
}


// These controls use actual two-stream Pulse delivery, optionally forwarded by
// LocalLinkClient.becomeReady. Only discovery/handshake/socket are synthetic.
export async function streamProgress(local: boolean, fragmented = false) {
  await reset();
  const { instance, seams, encrypt, keys } = await cryptoFixture();
  const frames: string[] = [];
  const deliveredStreams: number[] = [];
  let arm: ArmPulse;
  if (local) {
    const link = new LocalLinkClient({
      readDiscovery: async () => null, appId: () => appId,
      tentacleKey: () => undefined, sign: async () => '',
      onLinkChange: (id, linked) => seams.onLocalLinkChange(id, linked, []),
      onDelivered: (payload, streamId) => {
        deliveredStreams.push(streamId ?? 0);
        seams.handlePulseDelivered(payload, 'link', undefined, streamId);
      },
    });
    const internal = link as any;
    internal.handshake = { phase: 'ready', tentacleId: deviceId };
    internal.ws = { readyState: WebSocket.OPEN, send: (raw: string) => frames.push(JSON.parse(raw).pulse), close() {} };
    seams.localLink = link;
    internal.becomeReady();
    arm = internal.pulse;
  } else {
    arm = new ArmPulse({ now: () => 0, sendPulseFrame: (wire) => frames.push(wire), onAcked() {},
      onDelivered: (payload, streamId) => {
        deliveredStreams.push(streamId ?? 0);
        seams.handlePulseDelivered(payload, 'head', undefined, streamId);
      },
    }, 'order-head-arm');
    arm.onConnected();
  }
  const peer = new StreamSet([new Endpoint({ epoch: 'order-peer-live', streamId: 0 }), new Endpoint({ epoch: 'order-peer-bulk', streamId: 1 })]);
  const wire = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const feed = (effects: Effect[]) => { for (const e of effects) if (e.t === 'transmit') arm.onFrame(wire(e.bytes)); };
  const pump = () => { while (frames.length) for (const frame of frames.splice(0)) feed(peer.onBytes(Uint8Array.from(atob(frame), c => c.charCodeAt(0)), 0)); };
  feed(peer.onConnected(0)); pump();
  confirm(seams);
  const first = await encrypt(message(1, 'agent_message_delta', { content: 'bulk1' }));
  const second = await encrypt(message(2, 'agent_message_delta', { content: 'bulk2' }));
  const live = await encrypt(message(3, 'agent_message_delta', { content: 'live' }));
  const other = await encrypt(message(4, 'agent_message_delta', { content: 'other' }));
  const gate = deferred(), started = deferred(), secondDone = deferred(), firstDone = deferred();
  const original = keys.decryptFromBlob.bind(keys);
  keys.decryptFromBlob = async (...args) => {
    const result = await original(...args);
    if (args[0].blob === first.blob) { started.resolve(); await gate.promise; firstDone.resolve(); }
    if (args[0].blob === second.blob) secondDone.resolve();
    return result;
  };
  const send = (stream: number, envelope: object) => {
    const payload = JSON.stringify({ ...envelope, src: deviceId });
    const parts = fragmented ? fragmentPayload(payload, crypto.randomUUID(), 512, 1)! : [payload];
    for (const part of parts) {
      // Head normally stamps src on each fragment; the local link stamps it itself.
      const stamped = { ...JSON.parse(part), src: deviceId };
      feed(peer.send(stream, new TextEncoder().encode(JSON.stringify(stamped))).effects); pump();
    }
  };
  try {
    send(1, first); await started.promise;
    send(1, second); await secondDone.promise;
    send(0, live);
    await until(() => useStore.getState().cards.get(sessionId)?.text === 'live', 'live bypasses held bulk');
    // Another peer in the SAME stream must also progress independently.
    if (!local) {
      seams.handlePulseDelivered(JSON.stringify({ ...other, src: 'transport-other-peer' }), 'head', undefined, 1);
      await until(() => useStore.getState().cards.get(sessionId)?.text === 'liveother', 'other peer bypasses held bulk');
    }
    const beforeRelease = useStore.getState().cards.get(sessionId)?.text;
    gate.resolve(); await firstDone.promise; await new Promise(r => setTimeout(r, 0));
    const text = useStore.getState().cards.get(sessionId)?.text;
    return { invariant: text === (local ? 'livebulk1bulk2' : 'liveotherbulk1bulk2'), beforeRelease, text, deliveredStreams };
  } finally {
    gate.resolve(); keys.decryptFromBlob = original;
    if (local) (seams.localLink as unknown as LocalLinkClient).stop();
  }
}

export async function cryptoLifecycle(direction: 'receive' | 'send', event: 'identity' | 'connection' | 'route' | 'peer' | 'failure' | 'route-cycle') {
  await reset();
  const { instance, seams, encrypt, keys } = await cryptoFixture();
  let subscriptionSent = false;
  seams.route = () => { subscriptionSent = true; return 1n; };
  confirm(seams);
  await until(() => subscriptionSent, 'initial encrypted subscription');
  const first = await encrypt(message(1, 'agent_message_delta', { content: 'old' }));
  const second = await encrypt(message(2, 'agent_message_delta', { content: 'second' }));
  const fresh = await encrypt(message(3, 'agent_message_delta', { content: 'fresh' }));
  const originalDecrypt = keys.decryptFromBlob.bind(keys);
  const originalEncrypt = keys.encryptToBlob.bind(keys);
  const gate = deferred(), started = deferred(), secondDone = deferred(), firstDone = deferred();
  const sent: string[] = [], results: Array<bigint | null> = [];
  let count = 0;
  seams.route = (payload) => { sent.push(payload); return BigInt(sent.length); };
  if (direction === 'receive') keys.decryptFromBlob = async (...args) => {
    const result = await originalDecrypt(...args);
    if (args[0].blob === first.blob) { started.resolve(); await gate.promise; firstDone.resolve(); if (event === 'failure') throw new Error('synthetic rejection after real decrypt'); }
    if (args[0].blob === second.blob) secondDone.resolve();
    return result;
  };
  else keys.encryptToBlob = async (...args) => {
    const result = await originalEncrypt(...args);
    const ordinal = ++count;
    if (ordinal === 1) { started.resolve(); await gate.promise; firstDone.resolve(); if (event === 'failure') throw new Error('synthetic rejection after real encrypt'); }
    if (ordinal === 2) secondDone.resolve();
    return result;
  };
  const receive = (envelope: object) => seams.handlePulseDelivered(JSON.stringify({ ...envelope, src: deviceId }), 'head');
  const send = (text: string) => instance.sendEncrypted({ type: 'send_input', sessionId, payload: { text } }, seq => results.push(seq));
  try {
    direction === 'receive' ? receive(first) : send('old'); await started.promise;
    direction === 'receive' ? receive(second) : send('second'); await secondDone.promise;
    if (event === 'failure') {
      gate.resolve(); await firstDone.promise; await new Promise(r => setTimeout(r, 0));
      const text = useStore.getState().cards.get(sessionId)?.text ?? '';
      return { invariant: direction === 'receive' ? text === 'second' : results.length === 2 && results[0] === null && results[1] !== null, text, error: useStore.getState().lastError, results: results.map(String) };
    }
    if (event === 'identity') { instance.disconnect(); useStore.getState().reset(); useStore.getState().setAuth(appId); }
    if (event === 'connection') (seams as any).transport.callbacks.onClose();
    if (event === 'peer') seams.handleMessage({ type: 'device_joined', device: { ...useStore.getState().devices.get(deviceId), id: deviceId, role: 'tentacle' } });
    if (event === 'route' || event === 'route-cycle') {
      seams.localLink = { isLinked: () => true, stats: { staleHeadFrames: 0 }, stop() {} } as any;
      seams.onLocalLinkChange(deviceId, true, []);
      if (event === 'route-cycle') {
        seams.localLink = { isLinked: () => false, stats: { staleHeadFrames: 0 }, stop() {} } as any;
        seams.onLocalLinkChange(deviceId, false, []);
      }
    }
    // Fresh work uses the new authority and must not wait on detached crypto.
    if (event !== 'identity') {
      confirm(seams);
      useStore.getState().applyCardMessage(sessionId, 'snapshot-', true);
      if (direction === 'receive') {
        seams.handlePulseDelivered(JSON.stringify({ ...fresh, src: deviceId }), event === 'route' ? 'link' : 'head');
        await until(() => useStore.getState().cards.get(sessionId)?.text === 'snapshot-fresh', 'fresh authority progress');
      } else { send('fresh'); await until(() => sent.length >= 1, 'fresh send progresses'); }
    }
    const beforeRelease = useStore.getState().cards.get(sessionId)?.text ?? '';
    const countBeforeRelease = sent.length;
    gate.resolve(); await firstDone.promise; await new Promise(r => setTimeout(r, 0));
    const text = useStore.getState().cards.get(sessionId)?.text ?? '';
    return { invariant: direction === 'receive' ? text === beforeRelease : sent.length === countBeforeRelease && results.filter(x => x === null).length === 2, beforeRelease, text, sendsBeforeRelease: countBeforeRelease, sends: sent.length, cancellations: results.filter(x => x === null).length };
  } finally { gate.resolve(); keys.decryptFromBlob = originalDecrypt; keys.encryptToBlob = originalEncrypt; }
}

export async function independentSends(linkedHeadClose: boolean) {
  await reset();
  const { instance, seams, keys } = await cryptoFixture();
  if (linkedHeadClose) seams.localLink = { isLinked: (id?: string) => id === deviceId, stats: { staleHeadFrames: 0 } };
  const otherId = 'transport-other-tentacle';
  useStore.getState().upsertDevice({ id: otherId, name: 'Other synthetic tentacle', role: 'tentacle', online: true, encryptionKey: await keys.getPublicKey() });
  const gate = deferred(), started = deferred(), firstDone = deferred();
  const original = keys.encryptToBlob.bind(keys);
  let count = 0;
  keys.encryptToBlob = async (...args) => {
    const result = await original(...args);
    if (++count === 1) { started.resolve(); await gate.promise; firstDone.resolve(); }
    return result;
  };
  const targets: string[] = [], results: Array<bigint | null> = [];
  seams.route = (_payload, to) => { targets.push(to); return BigInt(targets.length); };
  try {
    instance.sendEncrypted({ type: 'send_input', sessionId, payload: { text: 'first' } }, seq => results.push(seq));
    await started.promise;
    if (linkedHeadClose) (seams as any).transport.callbacks.onClose();
    else {
      instance.sendEncrypted({ type: 'send_input', payload: { text: 'other', targetDeviceId: otherId } });
      await until(() => targets.length === 1, 'other peer outgoing progress');
    }
    const beforeRelease = [...targets];
    gate.resolve(); await firstDone.promise; await new Promise(r => setTimeout(r, 0));
    return { invariant: targets.join(',') === (linkedHeadClose ? deviceId : `${otherId},${deviceId}`) && results[0] !== null, beforeRelease, targets, cancellations: results.filter(x => x === null).length };
  } finally { gate.resolve(); keys.encryptToBlob = original; }
}

export async function subscriptionCancellation(rejectOld: boolean, prepare?: (transport: any) => Promise<void>) {
  await reset();
  const { instance, seams, keys, encrypt } = await cryptoFixture();
  const transport = (seams as any).transport;
  if (prepare) await prepare(transport);
  const gate = deferred(), started = deferred(), done = deferred();
  const original = keys.encryptToBlob.bind(keys);
  let count = 0;
  keys.encryptToBlob = async (...args) => {
    const result = await original(...args);
    if (++count === 1) { started.resolve(); await gate.promise; done.resolve(); if (rejectOld) throw new Error('old subscription encryption rejected'); }
    return result;
  };
  const sent: string[] = [];
  seams.route = payload => { sent.push(payload); return BigInt(sent.length); };
  const session = useStore.getState().sessions.get(sessionId)!;
  const device = useStore.getState().devices.get(deviceId)!;
  try {
    seams.subscription.onSessionList(deviceId); instance.setDesiredSession(sessionId);
    await started.promise;
    const oldFlight = (seams.subscription as any).inFlight;
    instance.disconnect();
    useStore.getState().reset(); useStore.getState().setAuth(appId); useStore.getState().setStatus('connected');
    useStore.getState().setDevices([device]); useStore.getState().setSessions([session]);
    seams.subscription.onSessionList(deviceId);
    const freshFlight = (seams.subscription as any).inFlight;
    await until(() => sent.length === 1, 'new subscription bypasses old encryption');
    gate.resolve(); await done.promise; await new Promise(r => setTimeout(r, 0));
    const error = useStore.getState().lastError;
    const sameFlight = freshFlight === (seams.subscription as any).inFlight;
    const oldAck = ack(); oldAck.payload.requestId = oldFlight.requestId;
    seams.subscription.onAck(oldAck);
    const oldRejected = !instance.isLiveReady(sessionId);
    const currentAck = ack(); currentAck.payload.requestId = freshFlight.requestId;
    const encrypted = await encrypt(currentAck);
    seams.handlePulseDelivered(JSON.stringify({ ...encrypted, src: deviceId }), 'head');
    await until(() => instance.isLiveReady(sessionId), 'current ACK accepted');
    return { invariant: error === null && sameFlight && oldRejected && sent.length === 1 && instance.isLiveReady(sessionId), error, sameFlight, oldRejected, sent: sent.length, ready: instance.isLiveReady(sessionId) };
  } finally { gate.resolve(); keys.encryptToBlob = original; }
}

export const scenarios: Record<string, () => Promise<any>> = {
  'F1-ack-delta': () => cryptoOrdering('ack-delta'),
  'F1-deltas': () => cryptoOrdering('deltas'),
  'F1-sends': () => cryptoOrdering('sends'),
  'F1-handover': () => cryptoOrdering('handover'),
  'F1-control': () => cryptoOrdering('control'),
  'legacy-deltas-control': () => cryptoOrdering('legacy-deltas'),
  'ordinary-retained-input-control': ordinaryInputRetention,
  'head-two-stream-control': () => streamProgress(false),
  'link-two-stream-control': () => streamProgress(true),
  'head-fragmented-stream-control': () => streamProgress(false, true),
  'link-fragmented-stream-control': () => streamProgress(true, true),
  'subscription-disconnect-release-control': () => subscriptionCancellation(false),
  'subscription-disconnect-reject-control': () => subscriptionCancellation(true),
  'outgoing-other-peer-control': () => independentSends(false),
  'outgoing-link-survives-head-close-control': () => independentSends(true),
};
for (const direction of ['receive', 'send'] as const) for (const event of ['identity', 'connection', 'route', 'peer', 'failure', 'route-cycle'] as const) {
  scenarios[`${direction}-${event}-control`] = () => cryptoLifecycle(direction, event);
}

Object.assign(scenarios, linkResponseScenarios);
