// Kraki mic test page.
//
// Pipeline:
//   getUserMedia → AudioContext (browser native rate, typically 44.1k or 48k)
//   → AudioWorklet captures Float32 frames
//   → main thread downsamples to 16 kHz mono Int16 PCM (box average)
//   → WebSocket binary frames to the broker
//   → renders transcript JSON the broker sends back
//
// Also keeps a copy of the downsampled PCM in memory so you can download it as
// a WAV and verify the bytes the broker is receiving — independent of whether
// the transcription itself looks right. That's the cheap way to triage "is the
// mic bad, the downsample bad, or the transcription bad?"

const $ = (id) => document.getElementById(id);

const TARGET_RATE = 16000;

// ── default broker url ──────────────────────────────────────────────────
const defaultBroker = (() => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.hostname || '127.0.0.1'}:7800/voice`;
})();

$('brokerUrl').value = localStorage.getItem('kraki.brokerUrl') || defaultBroker;
$('brokerUrl').addEventListener('change', (e) => localStorage.setItem('kraki.brokerUrl', e.target.value));

const savedMode = localStorage.getItem('kraki.triggerMode');
if (savedMode) $('modeSel').value = savedMode;
$('modeSel').addEventListener('change', (e) => {
  localStorage.setItem('kraki.triggerMode', e.target.value);
  applyMode();
});

const savedUid = localStorage.getItem('kraki.uid');
if (savedUid) $('uidInput').value = savedUid;
$('uidInput').addEventListener('change', (e) => localStorage.setItem('kraki.uid', e.target.value || 'kraki-mic-test'));

// ── state ───────────────────────────────────────────────────────────────
const state = {
  ws: null,
  ctx: null,
  worklet: null,
  source: null,
  stream: null,
  recording: false,
  startedAtMs: 0,
  bytesSent: 0,
  /** Int16Array chunks of downsampled PCM kept around for WAV download. */
  captured: [],
};

// ── tiny UI helpers ─────────────────────────────────────────────────────
function setWsBadge(text, kind) {
  const el = $('wsBadge');
  el.className = `badge${kind ? ` ${kind}` : ''}`;
  el.lastElementChild.textContent = text;
}
function setMicBadge(text, kind) {
  const el = $('micBadge');
  el.className = `badge${kind ? ` ${kind}` : ''}`;
  el.lastElementChild.textContent = text;
}
function setStats(durationSec, bytes, rate) {
  $('statsBadge').textContent = `${durationSec.toFixed(1)} s · ${(bytes / 1024).toFixed(1)} KB · ${rate} Hz`;
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
    el.textContent = update.text;
    el.classList.remove('partial');
  } else {
    el.innerHTML = `<span class="partial">${escapeHtml(update.text)}</span>`;
  }
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ── WAV encode ──────────────────────────────────────────────────────────
function encodeWav(int16Chunks, sampleRate) {
  let totalSamples = 0;
  for (const c of int16Chunks) totalSamples += c.length;
  const dataBytes = totalSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);                  // PCM
  view.setUint16(22, 1, true);                  // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);     // byte rate
  view.setUint16(32, 2, true);                  // block align
  view.setUint16(34, 16, true);                 // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (const c of int16Chunks) {
    for (let i = 0; i < c.length; i++) {
      view.setInt16(offset, c[i], true);
      offset += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// ── WS plumbing ─────────────────────────────────────────────────────────
async function openSocket() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return state.ws;
  if (state.ws && state.ws.readyState === WebSocket.CONNECTING) {
    await new Promise((r) => state.ws.addEventListener('open', r, { once: true }));
    return state.ws;
  }
  const url = $('brokerUrl').value.trim();
  log(`ws connecting ${url}`);
  setWsBadge('connecting…');
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('ws error'));
  });
  log('ws open');
  setWsBadge('connected', 'ok');

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case 'ready':
        log('broker ready');
        setWsBadge('ready', 'ok');
        break;
      case 'transcript':
        log(`transcript ${msg.sessionFinal ? '◆FINAL' : msg.finalSegment ? '◇seg' : '…part'} ${JSON.stringify(msg.text)}`);
        renderTranscript(msg);
        if (msg.sessionFinal) setWsBadge('final received', 'ok');
        break;
      case 'error':
        log(`error: ${msg.message}`);
        setWsBadge(`error: ${msg.message}`, 'err');
        break;
      case 'closed':
        log(`doubao closed code=${msg.code} reason=${msg.reason}`);
        break;
      default:
        log(`unknown msg: ${JSON.stringify(msg)}`);
    }
  };
  ws.onclose = (e) => {
    log(`ws closed code=${e.code} reason=${e.reason || '(none)'}`);
    setWsBadge('closed');
    state.ws = null;
  };
  ws.onerror = () => log('ws error');

  ws.send(JSON.stringify({ type: 'start', uid: $('uidInput').value.trim() || 'kraki-mic-test' }));
  return ws;
}

function sendBinary(int16) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  // Slice so we ship only the populated portion of the underlying buffer.
  const ab = int16.buffer.slice(int16.byteOffset, int16.byteOffset + int16.byteLength);
  state.ws.send(ab);
  state.bytesSent += int16.byteLength;
}

function sendFinish() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'finish' }));
  }
}

// ── AudioWorklet (inline blob to avoid a second file) ───────────────────
const workletSrc = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    // Copy: the underlying buffer is reused after process() returns.
    this.port.postMessage(input[0].slice(0));
    return true;
  }
}
registerProcessor('capture', CaptureProcessor);
`;

async function ensureAudio() {
  if (state.ctx) return;
  setMicBadge('requesting…');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  state.stream = stream;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  state.ctx = ctx;
  log(`AudioContext rate=${ctx.sampleRate}`);
  setMicBadge(`mic @ ${ctx.sampleRate} Hz`, 'ok');

  const blob = new Blob([workletSrc], { type: 'application/javascript' });
  await ctx.audioWorklet.addModule(URL.createObjectURL(blob));

  const source = ctx.createMediaStreamSource(stream);
  state.source = source;
  const node = new AudioWorkletNode(ctx, 'capture');
  state.worklet = node;

  node.port.onmessage = (e) => {
    if (!state.recording) return;
    const float32 = e.data;
    const peak = peakLevel(float32);
    $('meter').style.width = `${Math.min(100, peak * 200)}%`;
    const int16 = downsampleFloat32ToInt16(float32, ctx.sampleRate, TARGET_RATE);
    if (int16.length === 0) return;
    state.captured.push(int16);
    sendBinary(int16);
    const dur = (performance.now() - state.startedAtMs) / 1000;
    setStats(dur, state.bytesSent, TARGET_RATE);
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

function downsampleFloat32ToInt16(float32, srcRate, dstRate) {
  if (dstRate > srcRate) throw new Error('upsampling not supported');
  if (dstRate === srcRate) return floatToInt16(float32);
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
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

// ── start/stop ──────────────────────────────────────────────────────────
async function startRecording() {
  if (state.recording) return;
  $('downloadBtn').disabled = true;
  state.captured = [];
  state.bytesSent = 0;
  try {
    await ensureAudio();
    await openSocket();
  } catch (err) {
    log(`start failed: ${err.message}`);
    setWsBadge(`error: ${err.message}`, 'err');
    return;
  }
  // Resume context (mobile browsers suspend it before first user gesture).
  if (state.ctx.state === 'suspended') await state.ctx.resume();
  state.recording = true;
  state.startedAtMs = performance.now();
  setMicBadge('recording', 'ok');
  $('recordBtn').classList.add('recording');
  $('recordBtn').innerHTML = '⏹<br/>stop';
}

function stopRecording() {
  if (!state.recording) return;
  state.recording = false;
  $('meter').style.width = '0%';
  $('recordBtn').classList.remove('recording');
  applyMode();
  setMicBadge('processing…');
  sendFinish();

  $('downloadBtn').disabled = state.captured.length === 0;

  // Close ws shortly after to let Doubao flush its final frame.
  setTimeout(() => {
    if (state.ws) state.ws.close(1000, 'mic stop');
    setMicBadge('idle');
  }, 1500);
}

// ── trigger modes ───────────────────────────────────────────────────────
const btn = $('recordBtn');

function applyMode() {
  const mode = $('modeSel').value;
  if (state.recording) return; // labels updated by start/stop
  btn.innerHTML = mode === 'hold' ? '🎙<br/>hold to talk' : '🎙<br/>tap to start';
}

let mouseDownHandler = null;
let mouseUpHandler = null;
let touchStartHandler = null;
let touchEndHandler = null;
let clickHandler = null;
function bindBtn() {
  if (mouseDownHandler) btn.removeEventListener('mousedown', mouseDownHandler);
  if (mouseUpHandler) btn.removeEventListener('mouseup', mouseUpHandler);
  if (mouseUpHandler) btn.removeEventListener('mouseleave', mouseUpHandler);
  if (touchStartHandler) btn.removeEventListener('touchstart', touchStartHandler);
  if (touchEndHandler) btn.removeEventListener('touchend', touchEndHandler);
  if (touchEndHandler) btn.removeEventListener('touchcancel', touchEndHandler);
  if (clickHandler) btn.removeEventListener('click', clickHandler);
  mouseDownHandler = mouseUpHandler = touchStartHandler = touchEndHandler = clickHandler = null;

  const mode = $('modeSel').value;
  if (mode === 'hold') {
    mouseDownHandler = (e) => { e.preventDefault(); startRecording(); };
    mouseUpHandler = () => stopRecording();
    touchStartHandler = (e) => { e.preventDefault(); startRecording(); };
    touchEndHandler = (e) => { e.preventDefault(); stopRecording(); };
    btn.addEventListener('mousedown', mouseDownHandler);
    btn.addEventListener('mouseup', mouseUpHandler);
    btn.addEventListener('mouseleave', mouseUpHandler);
    btn.addEventListener('touchstart', touchStartHandler, { passive: false });
    btn.addEventListener('touchend', touchEndHandler, { passive: false });
    btn.addEventListener('touchcancel', touchEndHandler, { passive: false });
  } else {
    clickHandler = () => (state.recording ? stopRecording() : startRecording());
    btn.addEventListener('click', clickHandler);
  }
}
applyMode();
bindBtn();
$('modeSel').addEventListener('change', () => { applyMode(); bindBtn(); });

// Spacebar shortcut on desktop.
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
  e.preventDefault();
  if ($('modeSel').value === 'hold') startRecording();
  else (state.recording ? stopRecording() : startRecording());
});
document.addEventListener('keyup', (e) => {
  if (e.code !== 'Space') return;
  if ($('modeSel').value !== 'hold') return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
  e.preventDefault();
  stopRecording();
});

// ── extra actions ───────────────────────────────────────────────────────
$('downloadBtn').addEventListener('click', () => {
  if (state.captured.length === 0) return;
  const blob = encodeWav(state.captured, TARGET_RATE);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url; a.download = `kraki-mic-${ts}.wav`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  log(`downloaded wav (${state.captured.reduce((s, c) => s + c.length, 0)} samples)`);
});

$('testBtn').addEventListener('click', async () => {
  log('test: sending 1s silence');
  state.captured = [];
  state.bytesSent = 0;
  try {
    await openSocket();
    const silence = new Int16Array(TARGET_RATE);
    state.captured.push(silence);
    sendBinary(silence);
    sendFinish();
    $('downloadBtn').disabled = false;
    setTimeout(() => { if (state.ws) state.ws.close(1000, 'test done'); }, 1500);
  } catch (err) {
    log(`test failed: ${err.message}`);
    setWsBadge(`error: ${err.message}`, 'err');
  }
});

$('clearBtn').addEventListener('click', () => {
  $('transcript').textContent = '';
  $('log').textContent = '';
  setStats(0, 0, TARGET_RATE);
});

// ── boot ────────────────────────────────────────────────────────────────
setWsBadge('idle');
setMicBadge('idle');
setStats(0, 0, TARGET_RATE);
log(`page loaded; broker = ${$('brokerUrl').value}`);
