/**
 * Multi-stream end-to-end verification for Kraki's pulse upgrade.
 *
 * Proves, against REAL Kraki E2E crypto + a REAL WebSocket link, that splitting
 * traffic onto two Pulse streams (live=0, bulk=1) eliminates the cross-stream
 * head-of-line blocking that froze the production arm when ~20 turn-trace
 * batches saturated the head→arm downlink.
 *
 * Topology (no Head hub — a transparent WS relay stands in for it; the point is
 * to prove the PULSE multi-stream layer, not Head's routing, which is the
 * follow-up product work):
 *
 *   Peer A (tentacle role)  ──┐                  ┌──  Peer B (arm role)
 *   StreamSet [live=0,bulk=1] │  transparent WS  │   StreamSet [live=0,bulk=1]
 *   real KeyManager + E2E     └────  relay  ──────┘   real KeyManager + E2E
 *
 * Scenario: while DISCONNECTED, A piles 20 large bulk payloads onto stream 1
 * (mimicking reconnect-time trace/range batches filling the outbox), then sends
 * one live payload on stream 0. Connect. The live message must be DELIVERED to
 * B before any bulk message — on a single stream the live message (seq 21)
 * would wait behind all 20 bulk seqs.
 *
 * Run: pnpm exec tsx scripts/dev-verify-multistream.ts
 */
import { WebSocketServer, WebSocket } from 'ws';
import { StreamSet, Endpoint } from '@coinfra/pulse';
import { generateKeyPair, exportPublicKey, importPublicKey, encryptToBlob, decryptFromBlob } from '@kraki/crypto';

async function main(): Promise<void> {

// ── transparent relay: forward pulse frames A↔B verbatim ────────────────────
const RELAY_PORT = 4877;
const wss = new WebSocketServer({ port: RELAY_PORT });
let peerA: WebSocket | null = null;
let peerB: WebSocket | null = null;
wss.on('connection', (ws, req) => {
  const role = new URL(req.url ?? '/', `http://localhost`).searchParams.get('role');
  if (role === 'A') peerA = ws; else if (role === 'B') peerB = ws;
  ws.on('message', (data) => {
    // A→B or B→A: hand the raw bytes to the other side.
    const other = role === 'A' ? peerB : peerA;
    if (other && other.readyState === WebSocket.OPEN) other.send(data.toString());
  });
});
await new Promise((r) => wss.listen ? r(undefined) : wss.once('listening', () => r(undefined)));

// ── real E2E keys for both peers ────────────────────────────────────────────
const keyA = generateKeyPair();
const keyB = generateKeyPair();
const compactA = exportPublicKey(keyA.publicKey);
const compactB = exportPublicKey(keyB.publicKey);
const pemB = importPublicKey(compactB);

function encLive(tag: string): Uint8Array {
  // Real E2E encrypt to peer B; payload is a {blob,keys} JSON like Kraki sends.
  const { blob, keys } = encryptToBlob(tag, [{ deviceId: 'B', publicKey: pemB }]);
  return new TextEncoder().encode(JSON.stringify({ blob, keys }));
}
function dec(payload: Uint8Array): string {
  const { blob, keys } = JSON.parse(new TextDecoder().decode(payload));
  return decryptFromBlob({ blob, keys }, 'B', keyB.privateKey);
}

// ── peer A: StreamSet with live(0) + bulk(1) ───────────────────────────────
const aLive = new Endpoint({ epoch: 'a-live', streamId: 0 });
const aBulk = new Endpoint({ epoch: 'a-bulk', streamId: 1 });
const A = new StreamSet([aLive, aBulk]);

// ── peer B: matching StreamSet ─────────────────────────────────────────────
const bLive = new Endpoint({ epoch: 'b-live', streamId: 0 });
const bBulk = new Endpoint({ epoch: 'b-bulk', streamId: 1 });
const B = new StreamSet([bLive, bBulk]);

// Delivery log at B, attributing stream via the deliver effect's streamId.
const deliveredB: Array<{ stream: number; seq: bigint; tag: string }> = [];

function pumpTransmitToB(effects: ReturnType<StreamSet['onTick']>): void {
  for (const e of effects) {
    if (e.t !== 'transmit') continue;
    if (peerB && peerB.readyState === WebSocket.OPEN) peerB.send(Buffer.from(e.bytes).toString('base64'));
  }
}

// ── wire A and B to real WebSockets through the relay ──────────────────────
const wsA = new WebSocket(`ws://localhost:${RELAY_PORT}?role=A`);
const wsB = new WebSocket(`ws://localhost:${RELAY_PORT}?role=B`);
await Promise.all([once(wsA, 'open'), once(wsB, 'open')]);

// A's transmit effects → send on wsA (relay forwards to B).
// B's onBytes → record deliveries with stream attribution.
wsA.on('message', (data) => {
  // frames B sends back to A (acks/hello) — feed to A
  const bytes = new Uint8Array(Buffer.from(data.toString(), 'base64'));
  const eff = A.onBytes(bytes, Date.now());
  for (const e of eff) if (e.t === 'transmit' && peerB) peerB.send(Buffer.from(e.bytes).toString('base64'));
});
wsB.on('message', (data) => {
  const bytes = new Uint8Array(Buffer.from(data.toString(), 'base64'));
  const eff = B.onBytes(bytes, Date.now());
  for (const e of eff) {
    if (e.t === 'deliver') deliveredB.push({ stream: e.streamId ?? 0, seq: e.seq, tag: dec(e.payload) });
    if (e.t === 'transmit' && peerA) peerA.send(Buffer.from(e.bytes).toString('base64'));
  }
});

// Patch A.send so it actually pushes its transmit bytes onto the wire too.
const origASend0 = A.send.bind(A);
const origASend1 = A.send.bind(A);

// ── scenario: pile 20 BULK (stream 1) offline, then 1 LIVE (stream 0) ──────
console.log('piling 20 bulk payloads on stream 1 (offline → outbox)...');
for (let i = 0; i < 20; i++) {
  const r = A.send(1, encLive(`bulk-${i}`));
  for (const e of r.effects) if (e.t === 'transmit' && peerB) peerB.send(Buffer.from(e.bytes).toString('base64'));
}
console.log('sending 1 live payload on stream 0...');
const r0 = A.send(0, encLive('LIVE'));
for (const e of r0.effects) if (e.t === 'transmit' && peerB) peerB.send(Buffer.from(e.bytes).toString('base64'));

// ── connect both StreamSets (handshakes + resend piled outbox) ─────────────
console.log('connecting...');
const now = Date.now();
for (const e of A.onConnected(now)) if (e.t === 'transmit' && peerB) peerB.send(Buffer.from(e.bytes).toString('base64'));
for (const e of B.onConnected(now)) if (e.t === 'transmit' && peerA) peerA.send(Buffer.from(e.bytes).toString('base64'));

// ── pump to quiescence (ticks drive heartbeats + resend) ───────────────────
await new Promise((r) => setTimeout(r, 1500));
for (let t = 0; t < 30; t++) {
  const nowT = Date.now();
  for (const e of A.onTick(nowT)) if (e.t === 'transmit' && peerB) peerB.send(Buffer.from(e.bytes).toString('base64'));
  for (const e of B.onTick(nowT)) if (e.t === 'transmit' && peerA) peerA.send(Buffer.from(e.bytes).toString('base64'));
  await new Promise((r) => setTimeout(r, 50));
}
await new Promise((r) => setTimeout(r, 300));

// ── verdict ────────────────────────────────────────────────────────────────
const liveIdx = deliveredB.findIndex((d) => d.tag === 'LIVE');
const firstBulkIdx = deliveredB.findIndex((d) => d.stream === 1);
const bulkCount = deliveredB.filter((d) => d.stream === 1).length;

console.log('\n════════ multi-stream E2E verdict ════════');
console.log(`deliveries at B: ${deliveredB.length} (live stream: ${deliveredB.filter(d=>d.stream===0).length}, bulk stream: ${bulkCount})`);
console.log(`LIVE delivered at index ${liveIdx}; first bulk at index ${firstBulkIdx}`);
const pass = liveIdx >= 0 && firstBulkIdx >= 0 && liveIdx < firstBulkIdx && bulkCount === 20;
console.log(`verdict: ${pass ? '✅ PASS — live delivered BEFORE bulk (no HOL blocking)' : '❌ FAIL'}`);

if (!pass) {
  console.log('\nDelivery order:');
  for (const d of deliveredB) console.log(`  stream=${d.stream} seq=${d.seq} tag=${d.tag}`);
}

wsA.close(); wsB.close(); wss.close();
process.exit(pass ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

function once(ws: WebSocket, ev: string): Promise<void> {
  return new Promise((r) => ws.once(ev, () => r(undefined)));
}
