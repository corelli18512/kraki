import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { decodeFrame, Endpoint, type Effect } from '@kraki/pulse';
import { HeadServer } from '../server.js';
import { Storage } from '../storage.js';
import { OpenAuthProvider } from '../auth.js';

// A DATA frame whose destination the Head refuses must still be consumed on
// the sender's Pulse stream. Otherwise its seq is never ACKed, the sender
// resends it with the same target forever, and every later seq on that
// stream is a hole that is never delivered.

interface Peer {
  ws: WebSocket;
  deviceId: string;
  received: string[];
  errors: string[];
}

let httpServer: Server | null = null;
let storage: Storage | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  httpServer = null;
  storage?.close();
  storage = null;
});

async function startHead(): Promise<number> {
  storage = new Storage(':memory:');
  const server = new HeadServer(storage, { authProvider: new OpenAuthProvider() });
  httpServer = createServer();
  server.attach(httpServer);
  await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
  return (httpServer.address() as AddressInfo).port;
}

async function connectPeer(port: number, role: 'app' | 'tentacle', deviceId: string): Promise<Peer> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  await new Promise<void>((resolve) => ws.once('open', () => resolve()));
  const peer: Peer = { ws, deviceId, received: [], errors: [] };
  const authOk = new Promise<void>((resolve) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.type === 'auth_ok') resolve();
      if (msg.type === 'server_error') peer.errors.push(String(msg.message));
      if (typeof msg.pulse !== 'string') return;
      const frame = decodeFrame(new Uint8Array(Buffer.from(msg.pulse, 'base64')));
      if (frame?.t === 'data') peer.received.push(Buffer.from(frame.payload).toString('utf8'));
    });
  });
  ws.send(JSON.stringify({ type: 'auth', auth: { method: 'open' }, device: { name: deviceId, role, deviceId } }));
  await authOk;
  return peer;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('HeadServer: routing-rejected DATA frames', () => {
  it('consumes a unicast frame to an unreachable target so later frames still flow', async () => {
    const port = await startHead();
    const tentacle = await connectPeer(port, 'tentacle', 'tentacle-1');
    const app = await connectPeer(port, 'app', 'app-1');
    const endpoint = new Endpoint({ epoch: 'routing-reject-app', random: () => 0.5 });
    const transmit = (effects: Effect[], to: string) => {
      for (const e of effects) {
        if (e.t !== 'transmit') continue;
        app.ws.send(JSON.stringify({ type: 'unicast', to, pulse: Buffer.from(e.bytes).toString('base64'), blob: '', keys: {} }));
      }
    };
    transmit(endpoint.onConnected(Date.now()), '');
    await sleep(50);

    // Seq 1 to a device that does not exist (e.g. removed while this App was
    // offline with input queued for it), then seq 2 to a real Tentacle.
    transmit(endpoint.send(new TextEncoder().encode('{"n":"to-removed"}')).effects, 'removed-device');
    transmit(endpoint.send(new TextEncoder().encode('{"n":"to-tentacle"}')).effects, tentacle.deviceId);
    await sleep(200);

    expect(app.errors.some((e) => /not reachable/i.test(e))).toBe(true);
    expect(tentacle.received.some((p) => p.includes('"to-tentacle"'))).toBe(true);
    expect(tentacle.received.some((p) => p.includes('"to-removed"'))).toBe(false);
  });

  it('delivers a multicast frame to its allowed targets when one target is forbidden', async () => {
    const port = await startHead();
    const tentacle = await connectPeer(port, 'tentacle', 'tentacle-1');
    const app = await connectPeer(port, 'app', 'app-1');
    const endpoint = new Endpoint({ epoch: 'routing-reject-tentacle', random: () => 0.5 });
    const transmit = (effects: Effect[], to: string | string[]) => {
      for (const e of effects) {
        if (e.t !== 'transmit') continue;
        const pulse = Buffer.from(e.bytes).toString('base64');
        tentacle.ws.send(JSON.stringify(Array.isArray(to)
          ? { type: 'multicast', to, pulse, blob: '', keys: {} }
          : { type: 'unicast', to, pulse, blob: '', keys: {} }));
      }
    };
    transmit(endpoint.onConnected(Date.now()), '');
    await sleep(50);
    // Seed the App's Pulse stream: it fences DATA until its first HELLO.
    const appEndpoint = new Endpoint({ epoch: 'routing-reject-app-2', random: () => 0.5 });
    for (const e of appEndpoint.onConnected(Date.now())) {
      if (e.t === 'transmit') app.ws.send(JSON.stringify({ type: 'unicast', to: '', pulse: Buffer.from(e.bytes).toString('base64') }));
    }
    await sleep(50);

    transmit(endpoint.send(new TextEncoder().encode('{"n":"first"}')).effects, [app.deviceId, 'removed-app']);
    transmit(endpoint.send(new TextEncoder().encode('{"n":"second"}')).effects, [app.deviceId]);
    await sleep(200);

    expect(tentacle.errors.some((e) => /forbidden target/i.test(e))).toBe(true);
    expect(app.received.some((p) => p.includes('"first"'))).toBe(true);
    expect(app.received.some((p) => p.includes('"second"'))).toBe(true);
  });
});
