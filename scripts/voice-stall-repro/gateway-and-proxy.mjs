// Local repro harness for Doubao 45000081 (PACKET_WAIT_TIMEOUT).
//
//   client (VoiceInputCore) ──ws──▶ stall proxy :PROXY_PORT ──▶ mock gateway :GW_PORT
//
// Mock gateway: speaks the @coinfra/voice client protocol (authorize → authorized,
// start → ready, binary PCM, finish → transcript sessionFinal) and emulates
// Doubao's measured rule: no audio for 8 s → error providerCode=45000081.
//
// Stall proxy: STALL_MODE=hold      keep reading from the client, but hold the
//                                    upstream bytes (packets stuck in the path),
//                                    flush after STALL_MS.
//              STALL_MODE=stop-read  stop reading from the client (kernel buffers
//                                    fill, sender eventually back-pressures).
// The stall starts STALL_AT_MS after the first upstream binary data.
import net from 'node:net';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WebSocketServer } = require(process.env.WS_PATH);

const GW_PORT = Number(process.env.GW_PORT ?? 19402);
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 19401);
const STALL_MODE = process.env.STALL_MODE ?? 'hold';
const STALL_AT_MS = Number(process.env.STALL_AT_MS ?? 3000);
const STALL_MS = Number(process.env.STALL_MS ?? 10000);
const PACKET_WAIT_MS = 8000;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s]`, ...a);

// ── mock gateway ────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: GW_PORT });
wss.on('connection', (ws) => {
  log('gw: client connected');
  let recordingId = null, bytes = 0, waitTimer = null, startedAt = 0, lastAudio = 0, maxGap = 0;
  const send = (o) => ws.send(JSON.stringify(recordingId ? { ...o, recordingId } : o));
  const arm = () => {
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => {
      log(`gw: ASR error providerCode=45000081 sessionAudioBytes=${bytes} (${(bytes / 32000).toFixed(1)}s audio in ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
      send({ type: 'error', code: 'asr_error', providerCode: 45000081, message: 'Doubao ASR error 45000081: wait packet timeout' });
      recordingId = null;
    }, PACKET_WAIT_MS);
  };
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!recordingId) return;
      const now = Date.now();
      if (lastAudio) maxGap = Math.max(maxGap, now - lastAudio);
      if (lastAudio && now - lastAudio > 500) log(`gw: audio resumed after ${now - lastAudio}ms gap`);
      lastAudio = now; bytes += data.length; arm();
      return;
    }
    const m = JSON.parse(data.toString());
    if (m.type === 'authorize') { ws.send(JSON.stringify({ type: 'authorized' })); log('gw: authorized'); }
    else if (m.type === 'start') {
      recordingId = m.recordingId; bytes = 0; startedAt = Date.now(); lastAudio = 0; maxGap = 0;
      send({ type: 'ready' }); arm(); log('gw: recording started');
    } else if (m.type === 'finish') {
      clearTimeout(waitTimer);
      log(`gw: finish, ${(bytes / 32000).toFixed(1)}s audio, maxGap=${maxGap}ms`);
      send({ type: 'transcript', text: 'ok', rawText: 'ok', sessionFinal: true });
      recordingId = null;
    }
  });
  ws.on('close', (code) => { clearTimeout(waitTimer); log(`gw: client disconnected code=${code}`); });
});

// ── stall proxy ─────────────────────────────────────────────────────────────
net.createServer((client) => {
  const upstream = net.connect(GW_PORT, '127.0.0.1');
  let firstBinaryAt = 0, stalling = false, held = [], heldBytes = 0, stalledOnce = false;
  upstream.on('data', (d) => client.write(d));
  client.on('data', (d) => {
    // Frames >1 KB are PCM; start the stall clock on the first one.
    if (!firstBinaryAt && d.length > 1000) {
      firstBinaryAt = Date.now();
      setTimeout(() => {
        if (stalledOnce) return;
        stalledOnce = true; stalling = true;
        log(`proxy: STALL begins (mode=${STALL_MODE}, ${STALL_MS}ms)`);
        if (STALL_MODE === 'stop-read') client.pause();
        setTimeout(() => {
          stalling = false;
          log(`proxy: STALL ends, flushing ${heldBytes} held bytes`);
          for (const h of held) upstream.write(h);
          held = []; heldBytes = 0;
          if (STALL_MODE === 'stop-read') client.resume();
        }, STALL_MS);
      }, STALL_AT_MS);
    }
    if (stalling) { held.push(d); heldBytes += d.length; return; }
    upstream.write(d);
  });
  const end = () => { client.destroy(); upstream.destroy(); };
  client.on('error', end); upstream.on('error', end); client.on('close', end); upstream.on('close', end);
}).listen(PROXY_PORT, '127.0.0.1', () => log(`ready: proxy :${PROXY_PORT} → gateway :${GW_PORT}, mode=${STALL_MODE}`));
