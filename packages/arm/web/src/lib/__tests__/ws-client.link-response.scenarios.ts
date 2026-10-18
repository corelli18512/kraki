// Real consumer / WebCrypto / Pulse controls; synthetic identity, socket and send sink only.
import { Endpoint, StreamSet, type Effect } from '@kraki/pulse';
import { useStore } from '../../hooks/useStore';
import { outbox, useOutbox } from '../chat/outbox';
import { LocalLinkClient } from '../local-link';
import { cryptoFixture, reset, confirm, deferred, until, deviceId, sessionId, appId } from './ws-client.transport-order.scenarios';

type Transition = 'loss' | 'replacement' | 'identity' | 'peer' | 'head-close';
export async function linkResponseConsumer(queued: boolean, transition: Transition) {
  await reset();
  const { instance, seams, encrypt, keys } = await cryptoFixture();
  const internal = seams as any;
  const frames: string[] = [];
  const link = new LocalLinkClient({
    readDiscovery: async () => null, appId: () => appId, tentacleKey: () => undefined, sign: async () => '',
    onLinkChange: (id, linked) => seams.onLocalLinkChange(id, linked, []),
    onDelivered: (payload, stream) => seams.handlePulseDelivered(payload, 'link', undefined, stream),
  });
  seams.localLink = link;
  const ready = () => {
    (link as any).handshake = { phase: 'ready', tentacleId: deviceId };
    (link as any).ws = { readyState: WebSocket.OPEN, send: (raw: string) => frames.push(JSON.parse(raw).pulse), close() {} };
    (link as any).becomeReady();
    const arm = (link as any).pulse;
    const peer = new StreamSet([new Endpoint({ epoch: `response-live-${crypto.randomUUID()}`, streamId: 0 }), new Endpoint({ epoch: `response-bulk-${crypto.randomUUID()}`, streamId: 1 })]);
    const feed = (effects: Effect[]) => { for (const e of effects) if (e.t === 'transmit') arm.onFrame(btoa(String.fromCharCode(...e.bytes))); };
    const pump = () => { while (frames.length) for (const frame of frames.splice(0)) feed(peer.onBytes(Uint8Array.from(atob(frame), c => c.charCodeAt(0)), 0)); };
    feed(peer.onConnected(0)); pump();
    return (envelope: object) => { feed(peer.send(0, new TextEncoder().encode(JSON.stringify(envelope))).effects); pump(); };
  };
  let deliver = ready();
  const outgoing: string[] = [];
  seams.route = payload => { outgoing.push(payload); return BigInt(outgoing.length); };
  confirm(seams);
  await until(() => outgoing.length === 1, 'initial subscription encrypted');
  const prompt = 'synthetic retained first input';
  instance.createSession({ targetDeviceId: deviceId, model: 'synthetic-model', prompt });
  await until(() => outgoing.length === 2, 'synthetic create encrypted to sink');
  const command = JSON.parse(await keys.decryptFromBlob(JSON.parse(outgoing[1]), deviceId));
  const requestId = command.payload.requestId;
  const createdId = `${sessionId}-created`;
  const state = internal.cmdState;
  const requestOwnedBefore = state.pendingCreateRequests.has(requestId) && state.pendingPrompts.get(requestId) === prompt;
  const inputs: Array<Record<string, any>> = [];
  outbox.configure({ send: async msg => { inputs.push(msg); return true; }, isDeliveryPathUp: () => false });
  const response = await encrypt({ type: 'session_created', deviceId, sessionId: createdId, seq: 0, timestamp: '', payload: { agent: 'pi', model: 'synthetic-model', requestId } });
  const staleLive = await encrypt({ type: 'agent_message_delta', deviceId, sessionId, seq: 1, timestamp: '', payload: { content: 'STALE' } });
  const freshLive = await encrypt({ type: 'agent_message_delta', deviceId, sessionId, seq: 2, timestamp: '', payload: { content: 'fresh' } });
  const original = keys.decryptFromBlob.bind(keys);
  const gate = deferred(), held = deferred();
  const decryptBlob = seams.encryption.decryptBlob.bind(seams.encryption);
  const completions: Array<ReturnType<typeof decryptBlob>> = [];
  seams.encryption.decryptBlob = (...args) => {
    const completion = decryptBlob(...args);
    completions.push(completion);
    return completion;
  };
  const heldBlob = queued ? staleLive.blob : response.blob;
  keys.decryptFromBlob = async (...args) => {
    const plaintext = await original(...args);
    if (args[0].blob === heldBlob) { held.resolve(); await gate.promise; }
    return plaintext;
  };
  let createdDispatches = 0;
  const off = instance.onMessage(msg => { if ((msg as { type: string }).type === 'session_created') createdDispatches++; });
  try {
    deliver(queued ? staleLive : response); await held.promise;
    deliver(queued ? response : staleLive);
    // Observe the actual second admission becoming ready behind the held slot.
    await until(() => [...internal.inboundCrypto.domains.values()].some((entries: any) => entries.length === 2 && entries[1].ready), 'response/live completed but queued');
    const responseCompletedBeforeTransition = [...internal.inboundCrypto.domains.values()].some((entries: any) => entries[queued ? 1 : 0]?.ready);
    const beforeTransition = { createdDispatches, inputCount: inputs.length, requestOwned: state.pendingCreateRequests.has(requestId), responseCompletedBeforeTransition };
    if (transition === 'identity') {
      instance.disconnect();
      useStore.getState().reset(); useStore.getState().setAuth(appId);
    } else if (transition === 'peer') {
      link.dropForTesting();
      seams.handleMessage({ type: 'device_left', deviceId });
    } else if (transition === 'head-close') {
      internal.transport.callbacks.onClose();
    } else {
      link.dropForTesting();
      if (transition === 'replacement') deliver = ready();
    }
    const revoked = transition === 'identity' || transition === 'peer';
    if (!revoked) {
      confirm(seams);
      useStore.getState().applyCardMessage(sessionId, 'snapshot-', true);
      if (transition === 'loss') seams.handlePulseDelivered(JSON.stringify({ ...freshLive, src: deviceId }), 'head');
      else if (transition === 'replacement') deliver(freshLive);
      else seams.handlePulseDelivered(JSON.stringify({ ...freshLive, src: deviceId }), 'link', undefined, 1);
      await until(() => useStore.getState().cards.get(sessionId)?.text === 'snapshot-fresh', 'new generation/stream progresses before old gate release');
    }
    const progressedBeforeRelease = revoked || useStore.getState().cards.get(sessionId)?.text === 'snapshot-fresh';
    const noPrematureConsumer = createdDispatches === 0 && inputs.length === 0 && state.pendingCreateRequests.has(requestId);
    gate.resolve();
    // OrderedCrypto registered its settlement handlers at admission, before this
    // await. Await the real decrypt promises rather than sleeping for delivery.
    await Promise.all(completions);
    // session_created intentionally dispatches its retained prompt via dynamic
    // import. Await that real consumer continuation, never a fixed sleep.
    if (!revoked && createdDispatches === 1) await until(() => inputs.length === 1, 'retained first input consumer continuation');
    const text = useStore.getState().cards.get(sessionId)?.text ?? '';
    const responseApplied = useStore.getState().sessions.has(createdId);
    const pendingOwned = state.pendingCreateRequests.has(requestId);
    const promptOwned = state.pendingPrompts.has(requestId);
    const navigated = useStore.getState().navigateToSession === createdId;
    const inputEntries = useOutbox.getState().entries.filter(e => e.sessionId === createdId && e.text === prompt).length;
    const inputMatches = inputs.length === 1 && inputs[0].type === 'send_input' && inputs[0].sessionId === createdId && inputs[0].payload.text === prompt;
    // An unchanged local route is NOT stale merely because Head closed.
    const expectedText = transition === 'head-close' ? 'snapshot-freshSTALE' : revoked ? '' : 'snapshot-fresh';
    const invariant = requestOwnedBefore && responseCompletedBeforeTransition === queued && noPrematureConsumer && progressedBeforeRelease && text === expectedText
      && (revoked ? !responseApplied && createdDispatches === 0 && inputs.length === 0 && pendingOwned && promptOwned
        : responseApplied && createdDispatches === 1 && !pendingOwned && !promptOwned && navigated && inputMatches && inputEntries === 1);
    return { invariant, queued, transition, requestOwnedBefore, beforeTransition, progressedBeforeRelease, noPrematureConsumer, text, expectedText, responseApplied, createdDispatches, pendingOwned, promptOwned, navigated, inputCount: inputs.length, inputEntries, inputMatches };
  } finally { gate.resolve(); keys.decryptFromBlob = original; seams.encryption.decryptBlob = decryptBlob; off(); link.stop(); }
}

export const linkResponseScenarios: Record<string, () => Promise<any>> = {};
for (const queued of [false, true]) for (const transition of ['loss', 'replacement', 'identity', 'peer', 'head-close'] as const) {
  linkResponseScenarios[`link-response-${queued ? 'completed-queued' : 'pending'}-${transition}`] = () => linkResponseConsumer(queued, transition);
}
