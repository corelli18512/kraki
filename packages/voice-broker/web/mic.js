// Mic capture + downsample + WS streaming to the Kraki voice broker.
//
// Pipeline:
//   getUserMedia → AudioContext (browser native rate, usually 48k)
//   → AudioWorklet captures Float32 frames
//   → main thread downsamples to 16 kHz mono Int16 PCM
//   → WebSocket to broker (control JSON + binary chunks)
//   → renders {type:"transcript"} updates
//
// AudioWorklet is loaded inline via Blob so we don't need a second file.

const $ = (id) => document.getElementById(id);

const defaultBroker = (() => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Default to the same host on port 7800 (the broker's default port).
  return `${proto}//${location.hostname || '127.0.0.1'}:7800/voice`;
})();

$('brokerUrl').value = localStorage.getItem('kraki.brokerUrl') || defaultBroker;
$('brokerUrl').addEventListener('change', (e) => localStorage.setItem('kraki.brokerUrl', e.target.value));

const TARGET_RATE = 16000;

const state = {
  ws: null,
  ctx: null,
  worklet: null,
  stream: null,
  recording: false,
  buffered: [], // queue of Int16 chunks awaiting transcript
};

function setStatus(text) {
  $('status').textContent = text;
}

function log(line) {
  const el = $('log');
  const ts = new Date().toISOString().slice(11, 23);
  el.textContent += `${ts} ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

function renderTranscript(update) {
  const el = $('transcript');
  if (update.sessionFinal || update.finalSegment) {
    el.innerHTML = '';
    el.appendChild(document.createTextNode(update.text));
  } else {
    el.innerHTML = `<span class="partial">${escapeHtml(update.text)}</span>`;
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ─── WS plumbing ─────────────────────────────────────────────────────────

async function openSocket() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return state.ws;
  const url = $('brokerUrl').value.trim();
  log(`connecting ${url}`);
  setStatus('connecting…');
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  await new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(new Error('ws error'));
  });
  log('ws open');

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'transcript') {
      log(`transcript ${msg.finalSegment ? '◇' : '…'} ${msg.text}`);
      renderTranscript(msg);
    } else if (msg.type === 'ready') {
      log('broker ready');
    } else if (msg.type === 'error') {
      log(`error: ${msg.message}`);
      setStatus(`error: ${msg.message}`);
    } else if (msg.type === 'closed') {
      log(`doubao closed code=${msg.code} reason=${msg.reason}`);
    }
  };
  ws.onclose = (e) => {
    log(`ws closed code=${e.code} reason=${e.reason}`);
    state.ws = null;
  };

  ws.send(JSON.stringify({ type: 'start', uid: 'mic-test-page' }));
  return ws;
}

function sendBinary(int16) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(int16.buffer.slice(int16.byteOffset, int16.byteOffset + int16.byteLength));
}

function sendFinish() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'finish' }));
  }
}

// ─── AudioWorklet (inline) ───────────────────────────────────────────────

const workletSrc = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    // mono: take channel 0
    const ch0 = input[0];
    // copy because the buffer is reused
    this.port.postMessage(ch0.slice(0));
    return true;
  }
}
registerProcessor('capture', CaptureProcessor);
`;

async function ensureAudio() {
  if (state.ctx) return;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  state.stream = stream;

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  state.ctx = ctx;
  log(`AudioContext rate=${ctx.sampleRate}`);

  const blob = new Blob([workletSrc], { type: 'application/javascript' });
  await ctx.audioWorklet.addModule(URL.createObjectURL(blob));

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'capture');
  state.worklet = node;

  node.port.onmessage = (e) => {
    if (!state.recording) return;
    const float32 = e.data;
    const peak = peakLevel(float32);
    $('meter').style.width = Math.min(100, peak * 200) + '%';
    const down = downsampleAndFloat32ToInt16(float32, ctx.sampleRate, TARGET_RATE);
    if (down.length > 0) sendBinary(down);
  };

  source.connect(node);
}

function peakLevel(float32) {
  let p = 0;
  for (let i = 0; i < float32.length; i++) {
    const v = Math.abs(float32[i]);
    if (v > p) p = v;
  }
  return p;
}

function downsampleAndFloat32ToInt16(float32, srcRate, dstRate) {
  if (dstRate === srcRate) return floatToInt16(float32);
  if (dstRate > srcRate) throw new Error('upsampling not supported');
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    // Simple box average over the src window — fine for 48k→16k speech.
    const srcStart = Math.floor(i * ratio);
    const srcEnd = Math.min(float32.length, Math.floor((i + 1) * ratio));
    let acc = 0;
    let n = 0;
    for (let j = srcStart; j < srcEnd; j++) {
      acc += float32[j];
      n += 1;
    }
    const sample = n > 0 ? acc / n : 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  }
  return out;
}

function floatToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32767)));
  }
  return out;
}

// ─── UI ──────────────────────────────────────────────────────────────────

async function startRecording() {
  if (state.recording) return;
  try {
    await ensureAudio();
    await openSocket();
  } catch (err) {
    log(`start failed: ${err.message}`);
    setStatus(`error: ${err.message}`);
    return;
  }
  state.recording = true;
  setStatus('🎙 recording…');
  $('recordBtn').textContent = '⏹ Release to stop';
}

function stopRecording() {
  if (!state.recording) return;
  state.recording = false;
  setStatus('processing…');
  $('recordBtn').textContent = '🎙 Hold to speak';
  $('meter').style.width = '0%';
  sendFinish();
  setTimeout(() => {
    if (state.ws) state.ws.close(1000, 'mic stop');
    setStatus('idle');
  }, 1500);
}

const btn = $('recordBtn');
btn.addEventListener('mousedown', startRecording);
btn.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); });
btn.addEventListener('mouseup', stopRecording);
btn.addEventListener('mouseleave', stopRecording);
btn.addEventListener('touchend', stopRecording);
btn.addEventListener('touchcancel', stopRecording);

$('testBtn').addEventListener('click', async () => {
  setStatus('sending 1s silence…');
  try {
    await openSocket();
    // 1 second of silence at 16k mono Int16 = 32000 bytes
    sendBinary(new Int16Array(TARGET_RATE));
    sendFinish();
    setTimeout(() => { if (state.ws) state.ws.close(1000, 'test done'); setStatus('idle'); }, 1500);
  } catch (err) {
    setStatus(`error: ${err.message}`);
    log(`test failed: ${err.message}`);
  }
});

setStatus('idle');
log(`page loaded; default broker = ${defaultBroker}`);
