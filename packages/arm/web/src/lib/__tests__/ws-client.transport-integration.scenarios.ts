// Combined real WS/controller/WebCrypto gate. Only the outbound wire sink is synthetic.
import { useStore } from '../../hooks/useStore';
import { ack, appId, cryptoFixture, deferred, deviceId, reset, sessionId, until } from './ws-client.transport-order.scenarios';

export async function obsoleteEncryptedAck(newIdentity: boolean) {
  await reset();
  const { instance, seams, keys, encrypt } = await cryptoFixture();
  const a = sessionId, b = `${a}-B`, c = `${a}-C`;
  const session = useStore.getState().sessions.get(a)!;
  useStore.getState().upsertSession({ ...session, id: b });
  useStore.getState().upsertSession({ ...session, id: c });
  useStore.getState().applyCardMessage(a, 'original-A', true);
  const sessions = [...useStore.getState().sessions.values()];
  const devices = [...useStore.getState().devices.values()];
  const sent: string[] = [];
  seams.route = payload => { sent.push(payload); return BigInt(sent.length); };
  seams.subscription.onSessionList(deviceId);
  instance.setDesiredSession(a);
  await until(() => sent.length === 1, 'A subscription reaches encrypted sink');
  const request = async (index: number) => JSON.parse(await keys.decryptFromBlob(JSON.parse(sent[index]), deviceId));
  const firstRequest = await request(0);
  const ackA = ack(a, 0, 'OBSOLETE-A');
  ackA.payload.requestId = firstRequest.payload.requestId;
  const heldAck = await encrypt(ackA);
  const oldDelta = await encrypt({ type: 'agent_message_delta', deviceId, sessionId: a, seq: 2, timestamp: '', payload: { content: 'RESURRECT-A' } });
  const original = keys.decryptFromBlob.bind(keys);
  const gate = deferred(), started = deferred();
  const decryptBlob = seams.encryption.decryptBlob.bind(seams.encryption);
  const completions: Array<ReturnType<typeof decryptBlob>> = [];
  seams.encryption.decryptBlob = (...args) => {
    const completion = decryptBlob(...args); completions.push(completion); return completion;
  };
  keys.decryptFromBlob = async (...args) => {
    const plaintext = await original(...args);
    if (args[0].blob === heldAck.blob) { started.resolve(); await gate.promise; }
    return plaintext;
  };
  const receive = (envelope: object) => seams.handlePulseDelivered(JSON.stringify({ ...envelope, src: deviceId }), 'head', undefined, 0);
  const seen: string[] = [];
  const off = instance.onMessage(msg => seen.push(msg.type));
  try {
    receive(heldAck); await started.promise;
    instance.setDesiredSession(b); instance.setDesiredSession(c);
    receive(oldDelta);
    // Prove the delta really finished crypto but cannot overtake ACK(A).
    await until(() => [...(seams as any).inboundCrypto.domains.values()].some((entries: any) => entries.length === 2 && entries[1].ready), 'delta completed behind held ACK(A)');
    const beforeRelease = { sent: sent.length, seen: [...seen], a: useStore.getState().cards.get(a)?.text };
    let currentAppId = appId;
    if (newIdentity) {
      instance.disconnect();
      currentAppId = `${appId}-replacement`;
      useStore.getState().reset(); useStore.getState().setAuth(currentAppId); useStore.getState().setStatus('connected');
      useStore.getState().setDevices(devices); useStore.getState().setSessions(sessions);
      useStore.getState().applyCardMessage(a, 'replacement-A', true);
      seams.subscription.onSessionList(deviceId);
      await until(() => sent.length === 2, 'replacement identity subscription bypasses old crypto');
    }
    gate.resolve(); await Promise.all(completions);
    await until(() => sent.length === 2, 'C subscription encrypted after obsolete ACK');
    const noResurrection = !instance.isLiveReady(a) && !seams.subscription.acceptsLive(a)
      && !instance.isLiveReady(c) && useStore.getState().cards.get(a)?.text === (newIdentity ? 'replacement-A' : 'original-A');
    const currentRequest = await request(1);
    const ackC = ack(c, 0, 'current-C'); ackC.payload.requestId = currentRequest.payload.requestId;
    const encryptCurrent = async (inner: unknown) => keys.encryptToBlob(JSON.stringify(inner), [{ deviceId: currentAppId, publicKeyBase64: await keys.getPublicKey() }]);
    receive(await encryptCurrent(ackC));
    receive(await encryptCurrent({ type: 'agent_message_delta', deviceId, sessionId: c, seq: 3, timestamp: '', payload: { content: '+live' } }));
    await Promise.all(completions);
    const text = useStore.getState().cards.get(c)?.text;
    const requests = [firstRequest.payload.sessionId, currentRequest.payload.sessionId];
    const invariant = beforeRelease.sent === 1 && beforeRelease.seen.length === 0 && beforeRelease.a === 'original-A'
      && noResurrection && requests.join(',') === `${a},${c}` && firstRequest.payload.requestId !== currentRequest.payload.requestId
      && instance.isLiveReady(c) && text === 'current-C+live' && !seams.subscription.acceptsLive(a);
    return { invariant, newIdentity, beforeRelease, noResurrection, requests, text, currentReady: instance.isLiveReady(c), aReady: instance.isLiveReady(a), seen };
  } finally { gate.resolve(); keys.decryptFromBlob = original; seams.encryption.decryptBlob = decryptBlob; off(); instance.disconnect(); }
}

export const integrationScenarios = {
  'encrypted-obsolete-A-to-B-to-C': () => obsoleteEncryptedAck(false),
  'encrypted-obsolete-disconnect-new-identity-current-ACK': () => obsoleteEncryptedAck(true),
};
