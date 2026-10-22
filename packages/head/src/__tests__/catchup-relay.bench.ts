// Manual benchmark (not part of the suite): how long the Head's event loop
// blocks, and how far its heap grows, while it relays an App's reconnect
// catch-up (log audit 2026-10-22 (h): CN Head stalls 20–540 ms and heap
// 19→80 MB within 30 s of the iPhone authenticating).
//
// The Head runs in this process; the Tentacle and App run in a child process
// (their own event loop) and speak real Pulse over WebSockets.
//
// Scenarios:
//   online  — the App is connected; the Tentacle answers its catch-up
//             requests: SESSIONS replies of MESSAGES messages of MSG_BYTES.
//   backlog — the same bytes were sent while the App was away (< 5 min, so
//             not yet purged); the App's reconnect resends them all at once.
// Run: SESSIONS=7 MESSAGES=100 MSG_BYTES=8000 npx tsx src/__tests__/catchup-relay.bench.ts
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Endpoint, StreamSet, type Effect } from '@kraki/pulse';
import { PAYLOAD_FRAGMENT_SIZE } from '@kraki/protocol';
import { Storage } from '../storage.js';
import { HeadServer } from '../server.js';
import { OpenAuthProvider } from '../auth.js';
import { Logger, setGlobalLogger } from '../logger.js';

const SESSIONS = Number(process.env.SESSIONS ?? 7);
const MESSAGES = Number(process.env.MESSAGES ?? 100);
const MSG_BYTES = Number(process.env.MSG_BYTES ?? 8_000);
const ROUNDS = Number(process.env.ROUNDS ?? 3);

/** One sealed reply as the Tentacle sends it: split into fragments. */
function replyFrames(bytes: number): Uint8Array[] {
  // Encrypted + base64: incompressible ASCII.
  const body = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) body[i] = 65 + ((i * 7919) % 58);
  const frames: Uint8Array[] = [];
  for (let at = 0; at < bytes; at += PAYLOAD_FRAGMENT_SIZE) frames.push(body.subarray(at, Math.min(bytes, at + PAYLOAD_FRAGMENT_SIZE)));
  return frames;
}

async function client(port: number): Promise<void> {
  const streams = (name: string) => new StreamSet([
    new Endpoint({ epoch: `${name}:live`, streamId: 0, random: () => 0.5 }),
    new Endpoint({ epoch: `${name}:bulk`, streamId: 1, random: () => 0.5 }),
  ]);
  async function connect(name: string, role: 'app' | 'tentacle', set: StreamSet, onDeliver: (bytes: number) => void) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((r) => ws.on('open', r));
    const flush = (effects: Effect[], to = '') => {
      for (const e of effects) {
        if (e.t === 'transmit') ws.send(JSON.stringify({ type: 'unicast', to, pulse: Buffer.from(e.bytes).toString('base64') }));
        if (e.t === 'deliver') onDeliver(e.payload.length);
      }
    };
    const authed = new Promise<void>((resolve) => ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth_ok') { flush(set.onConnected(Date.now())); resolve(); }
      if (typeof msg.pulse === 'string') flush(set.onBytes(new Uint8Array(Buffer.from(msg.pulse, 'base64')), Date.now()));
    }));
    ws.send(JSON.stringify({ type: 'auth', auth: { method: 'open' }, device: { name, role, deviceId: name, pulseProgressAck: true } }));
    await authed;
    // Acks and heartbeats, as the real clients' Pulse timers do.
    const ticker = setInterval(() => { if (ws.readyState === WebSocket.OPEN) flush(set.onTick(Date.now())); }, 50);
    ws.on('close', () => clearInterval(ticker));
    return { ws, flush };
  }
  let received = 0;
  let expected = 0;
  let notify: () => void = () => {};
  const appSet = streams('phone');
  const tentacleSet = streams('mac');
  let app = await connect('phone', 'app', appSet, (n) => { received += n; if (received >= expected) notify(); });
  const mac = await connect('mac', 'tentacle', tentacleSet, () => {});
  await new Promise((r) => setTimeout(r, 300));
  const sendReplies = () => {
    for (let s = 0; s < SESSIONS; s++) {
      for (const frame of replyFrames(MESSAGES * MSG_BYTES)) mac.flush(tentacleSet.send(1, frame).effects, 'phone');
    }
  };
  const total = SESSIONS * MESSAGES * MSG_BYTES;
  process.on('message', async (cmd: { scenario: 'online' | 'backlog' }) => {
    received = 0;
    expected = total;
    const done = new Promise<void>((r) => { notify = r; });
    if (cmd.scenario === 'online') {
      process.send!({ t: 'start' });
      sendReplies();
    } else {
      app.ws.terminate();
      appSet.onDisconnected(Date.now());
      await new Promise((r) => setTimeout(r, 200));
      sendReplies();
      await new Promise((r) => setTimeout(r, 1_000)); // the Head has queued it all
      process.send!({ t: 'start' });
      app = await connect('phone', 'app', appSet, (n) => { received += n; if (received >= expected) notify(); });
    }
    await done;
    process.send!({ t: 'done' });
  });
  process.send!({ t: 'ready' });
}

async function head(): Promise<void> {
  setGlobalLogger(new Logger({ level: 'error', stdout: false }));
  const storage = new Storage(':memory:');
  const server = new HeadServer(storage, { authProvider: new OpenAuthProvider() });
  const http = createServer();
  server.attach(http);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  const child = fork(fileURLToPath(import.meta.url), ['client', String(port)], { stdio: 'inherit' });
  const next = (t: string) => new Promise<void>((resolve) => {
    const on = (m: { t: string }) => { if (m.t === t) { child.off('message', on); resolve(); } };
    child.on('message', on);
  });
  await next('ready');
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  console.log(`catch-up: ${SESSIONS} sessions × ${MESSAGES} messages × ${MSG_BYTES} B = ${(SESSIONS * MESSAGES * MSG_BYTES / 1e6).toFixed(1)} MB`);
  for (const scenario of ['online', 'backlog'] as const) {
    for (let round = 0; round < ROUNDS; round++) {
      global.gc?.();
      const heapBefore = process.memoryUsage().heapTotal;
      let heapPeak = heapBefore;
      const sampler = setInterval(() => { heapPeak = Math.max(heapPeak, process.memoryUsage().heapTotal); }, 5);
      const started = next('start');
      child.send({ scenario });
      await started;
      loop.reset();
      const t0 = performance.now();
      await next('done');
      const ms = performance.now() - t0;
      clearInterval(sampler);
      const relayMax = Math.max(0, loop.max / 1e6 - 10);
      console.log(`${scenario.padEnd(7)} round ${round}: delivered in ${ms.toFixed(0)} ms, Head loop max stall ${relayMax.toFixed(1)} ms, heapTotal ${(heapBefore / 1048576).toFixed(0)} → peak ${(heapPeak / 1048576).toFixed(0)} MB`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  child.kill();
  server.close();
  http.close();
  storage.close();
}

if (process.argv[2] === 'client') await client(Number(process.argv[3]));
else await head();
