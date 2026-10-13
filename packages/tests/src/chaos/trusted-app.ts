/** Local-only second-app probe. Real open auth, Pulse, pairing proof and v2. */
import { WebSocket } from 'ws';
import { generateKeyPair, exportPublicKey, generateIdentityKeyPair, generateE2EKeyPair, signMessage,
  encryptV2, decryptV2, isSignedMessage, verifySignature, pairingProof } from '@kraki/crypto';
import { createPulseAppLayer } from '../helpers.js';

export async function connectTrustedApp(port: number, link: string) {
  const params = new URL(link).searchParams;
  const computer = params.get('tid')!;
  const ik = generateIdentityKeyPair();
  const xk = generateE2EKeyPair();
  const rsa = generateKeyPair();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: Record<string, unknown>[] = [];
  let id = '';
  const pulse = createPulseAppLayer(ws, (text) => {
    try {
      const envelope = JSON.parse(text);
      if (envelope.v !== 2 || !id) return;
      const signed = JSON.parse(decryptV2(envelope.blob, id, xk.privateKey));
      if (!isSignedMessage(signed) || !verifySignature(signed, params.get('ik')!) || signed.from !== computer || ![id, '*'].includes(signed.to)) return;
      messages.push(JSON.parse(signed.body));
    } catch { /* unrelated broadcasts */ }
  });
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === 'auth_ok') { id = frame.deviceId; pulse.onConnected(); }
    if (typeof frame.pulse === 'string') pulse.onRawFrame(frame.pulse);
  });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'auth', auth: { method: 'open' }, device: {
    name: 'Second App Probe', role: 'app', kind: 'phone', publicKey: exportPublicKey(rsa.publicKey),
  } }));
  async function wait(check: () => boolean) {
    const until = Date.now() + 15000;
    while (!check()) {
      if (Date.now() > until) { ws.close(); throw new Error('second app probe timeout'); }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  await wait(() => !!id);
  function send(type: string, payload: Record<string, unknown>, sessionId?: string) {
    const body = JSON.stringify({ type, deviceId: id, seq: 0, timestamp: new Date().toISOString(), payload, ...(sessionId && { sessionId }) });
    const signed = signMessage(body, id, computer, ik.privateKey);
    const blob = encryptV2(JSON.stringify(signed), [{ recipientId: computer, publicKey: params.get('xk')! }]);
    pulse.sendReliable(JSON.stringify({ v: 2, blob }), computer);
  }
  const claim = { tentacleId: computer, appId: id, identityKey: ik.publicKey, encryptionKey: xk.publicKey,
    rsaKey: exportPublicKey(rsa.publicKey), ts: Date.now() };
  send('pair_request', { claim, proof: pairingProof(params.get('ps')!, claim), name: 'Second App Probe' });
  await wait(() => messages.some((m) => m.type === 'pair_result'));
  return { id, messages, send, close: () => ws.close() };
}
