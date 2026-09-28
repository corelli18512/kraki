import Database from 'better-sqlite3';
import { decodeFrameWithStream, Endpoint } from '@coinfra/pulse';
import { describe, expect, it } from 'vitest';
import { PulseHub, PULSE_ACK_EVERY_BYTES } from '../pulse-hub.js';

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

function setup(accepts: boolean) {
  const db = new Database(':memory:');
  const toApp: Array<{ t: string; ack?: bigint }> = [];
  const hub = new PulseHub(db, {
    now: () => 1_000,
    sendPulseTo: (device, pulse) => {
      if (device === 'app') {
        const d = decodeFrameWithStream(new Uint8Array(Buffer.from(pulse, 'base64')));
        if (d) toApp.push(d.frame as { t: string; ack?: bigint });
      }
      return true;
    },
    broadcastTargets: () => [],
    onDeliverToSelf: () => {},
    acceptsProgressAck: () => accepts,
  });
  hub.onDeviceConnected('app');
  const app = new Endpoint({ epoch: 'app-epoch', random: () => 0.5 });
  const feed = (effects: ReturnType<Endpoint['onConnected']>) => {
    for (const e of effects) if (e.t === 'transmit') hub.onPulseEnvelope('app', { pulse: b64(e.bytes), to: 'tentacle' });
  };
  feed(app.onConnected(1_000));
  return { hub, app, feed, toApp, db };
}

describe('pulse-hub progress acks', () => {
  it('acknowledges an upload every PULSE_ACK_EVERY_BYTES for clients that declared support', () => {
    const { app, feed, toApp, db } = setup(true);
    toApp.length = 0;
    const part = new Uint8Array(32 * 1024);
    for (let i = 0; i < 6; i++) feed(app.send(part).effects);
    const acks = toApp.filter((f) => f.t === 'heartbeat');
    expect(acks.length).toBe(Math.floor((6 * part.length) / PULSE_ACK_EVERY_BYTES));
    expect(acks.map((f) => f.ack)).toEqual([2n, 4n, 6n]);
    // The sender (Pulse ≥0.5.1) prunes and does not resend on these.
    let resent = 0;
    for (const f of acks) {
      for (const e of app.onFrame({ t: 'heartbeat', ack: f.ack! }, 1_100)) if (e.t === 'transmit') resent += 1;
    }
    expect(resent).toBe(0);
    expect(app.outboxSize).toBe(0);
    db.close();
  });

  it('never sends progress acks to clients that did not declare support', () => {
    const { app, feed, toApp, db } = setup(false);
    toApp.length = 0;
    for (let i = 0; i < 6; i++) feed(app.send(new Uint8Array(32 * 1024)).effects);
    expect(toApp.filter((f) => f.t === 'heartbeat')).toHaveLength(0);
    db.close();
  });
});

describe('progress-ack negotiation', () => {
  it('advertises pulseAckBytes and records only explicit client declarations', async () => {
    const { createTestEnv, connectDevice } = await import('./integration-helpers.js');
    const { WebSocket } = await import('ws');
    const env = await createTestEnv();
    try {
      const plain = await connectDevice(env.port, 'Old App', 'app');
      const authOk = plain.messages.find((m) => m.type === 'auth_ok');
      expect(authOk?.pulseAckBytes).toBe(PULSE_ACK_EVERY_BYTES);
      const host = (env.server as unknown as { pulseHub: { host: { acceptsProgressAck(id: string): boolean } } }).pulseHub.host;
      expect(host.acceptsProgressAck(String(authOk?.deviceId))).toBe(false);

      const ws = new WebSocket(`ws://127.0.0.1:${env.port}`);
      await new Promise((r) => ws.on('open', r));
      const ok = new Promise<Record<string, unknown>>((resolve) => ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'auth_ok') resolve(m);
      }));
      ws.send(JSON.stringify({ type: 'auth', auth: { method: 'open' }, device: { name: 'New App', role: 'app', pulseProgressAck: true } }));
      const declared = await ok;
      expect(host.acceptsProgressAck(String(declared.deviceId))).toBe(true);
      ws.close();
      plain.close();
    } finally {
      await env.cleanup();
    }
  });
});
