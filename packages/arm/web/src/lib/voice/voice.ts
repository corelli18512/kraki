/**
 * Voice input for the Web and Kraki for Windows — the Mac/iOS
 * KrakiVoiceInputController + VoiceInputCore, in the browser:
 *
 *   relay (auth_ok.voice) advertises the region's voice gateway;
 *   `request_voice_lease` → `voice_lease_grant` (signed, short-lived, cached);
 *   gateway WebSocket: authorize(lease) → authorized → start(context,
 *   vocabulary, correction, recordingId) → ready → 16 kHz PCM → finish →
 *   correction_delta… → transcript{sessionFinal}.
 *
 * Audio leaves the device only to Kraki's own speech service (`wss://` on
 * kraki.chat) or to the server of the relay you signed in to (self-hosting).
 * A one-time notice explains that voice input, unlike chat, is processed in
 * the cloud. Custom Words are account data, synced through the relay.
 */
import { t } from '../../i18n';
import { create } from 'zustand';
import type { VoiceCapability, VoiceLease, VoiceWord, VoiceWordOp } from '@kraki/protocol';
import { TARGET_RATE, loudness, toPcm16 } from './pcm';
import { applyOps, cleanWord, wordLine } from './words';
import type { VoiceContext } from './context';
import { diag } from '../diag';
import { VoiceTracker } from '../diag/experience';

class VoiceFailure extends Error {
  constructor(message: string, readonly metricCause: string) { super(message); }
}

// ── Settings (this device) ───────────────────────────────
const KEYS = { correction: 'kraki:voice.correction', share: 'kraki:voice.correctionContext', consent: 'kraki:voice.consent.v1' };
const bump = () => useVoice.setState((s) => ({ settingsRev: s.settingsRev + 1 }));
const readBool = (k: string, d: boolean) => { const v = localStorage.getItem(k); return v === null ? d : v === '1'; };
export const voiceSettings = {
  get correction() { return readBool(KEYS.correction, true); },
  set correction(v: boolean) { localStorage.setItem(KEYS.correction, v ? '1' : '0'); bump(); },
  get shareContext() { return readBool(KEYS.share, true); },
  set shareContext(v: boolean) { localStorage.setItem(KEYS.share, v ? '1' : '0'); bump(); },
  get consented() { return readBool(KEYS.consent, false); },
  grantConsent() { localStorage.setItem(KEYS.consent, '1'); },
};

export function consentTitle() { return t('settings:voice.consentTitle'); }
export function consentMessage() { return t('settings:voice.consentMessage'); }

export type VoicePhase = 'idle' | 'connecting' | 'recording' | 'finishing' | 'failed';
/** What the finished transcript is for: send it, or put it in the draft to edit. */
export type VoiceFinish = 'send' | 'edit';

/** A sent utterance lives in the local outbox while recognition/correction finishes. */
export interface StagedVoice {
  update: (text: string, rawText: string) => void;
  complete: (text: string, rawText: string, completed: boolean) => void;
}
export type StageVoice = (rawText: string) => StagedVoice | null;

interface VoiceState {
  capability: VoiceCapability | null;
  /** The recording's owner (a session id or 'new'), so only one composer shows it. */
  owner: string | null;
  phase: VoicePhase;
  staged: boolean;
  rawText: string;
  correctionText: string;
  levels: number[];
  startedAt: number | null;
  error: string | null;
  /** Custom Words: the account's list (optimistic: server + pending ops). */
  words: VoiceWord[];
  serverWords: VoiceWord[];
  outbox: VoiceWordOp[];
  consentPending: boolean;
  settingsRev: number;
}

export const useVoice = create<VoiceState>(() => ({
  capability: null, owner: null, phase: 'idle', staged: false, rawText: '', correctionText: '', levels: [], startedAt: null,
  error: null, words: [], serverWords: [], outbox: [], consentPending: false, settingsRev: 0,
}));

// ── Transport hooks (wired by ws-client) ─────────────────
interface Transport {
  sendRaw: (msg: Record<string, unknown>) => void;
  deviceId: () => string | null;
  userId: () => string | null;
  relayUrl: () => string;
  connected: () => boolean;
}
let transport: Transport | null = null;
export function configureVoiceTransport(t: Transport) { transport = t; }

/** The microphone may stream only to Kraki's speech service or your own relay's host. */
export function brokerAllowed(brokerUrl: string, relayUrl: string): boolean {
  try {
    const b = new URL(brokerUrl);
    const host = b.hostname.toLowerCase();
    if (b.protocol === 'wss:' && (host === 'kraki.chat' || host.endsWith('.kraki.chat'))) return true;
    const relay = new URL(relayUrl.replace(/^http/, 'ws'));
    const relayIsKraki = relay.hostname === 'kraki.chat' || relay.hostname.endsWith('.kraki.chat');
    return !relayIsKraki && (b.protocol === 'wss:' || b.protocol === 'ws:') && host === relay.hostname.toLowerCase();
  } catch {
    return false;
  }
}

/** auth_ok: the region's voice gateway (absent → no mic) and the account's words. */
export function onAuthOk(voice: VoiceCapability | undefined, words: VoiceWord[] | undefined) {
  const cap = voice && transport && brokerAllowed(voice.brokerUrl, transport.relayUrl()) ? voice : null;
  const { outbox } = useVoice.getState();
  const server = Array.isArray(words) ? words : useVoice.getState().serverWords;
  useVoice.setState({ capability: cap, serverWords: server, words: applyOps(outbox, server) });
  if (outbox.length) flushWords();
}

// ── Lease ────────────────────────────────────────────────
let lease: VoiceLease | null = null;
let leaseWaiters: { resolve: (l: VoiceLease) => void; reject: (e: Error) => void }[] = [];

function denialMessage(reason: string): string | undefined {
  if (reason === 'quota_exhausted') return t('settings:voice.errors.quota');
  if (reason === 'not_entitled') return t('settings:voice.errors.notEntitled');
  return undefined;
}

export function onLeaseGrant(l: VoiceLease) {
  lease = l;
  const w = leaseWaiters; leaseWaiters = [];
  w.forEach((x) => x.resolve(l));
}
export function onLeaseDenied(reason: string, detail?: string) {
  const w = leaseWaiters; leaseWaiters = [];
  const tag = ['quota_exhausted', 'not_entitled', 'invalid_request'].includes(reason) ? `lease_denied_${reason}` : 'lease_rejected';
  const err = new VoiceFailure(denialMessage(reason) ?? detail ?? t('settings:voice.errors.rejected'), tag);
  w.forEach((x) => x.reject(err));
}

function getLease(): Promise<VoiceLease> {
  const now = Date.now() / 1000;
  if (lease && lease.payload.exp - now > 60 && lease.payload.did === transport?.deviceId()) return Promise.resolve(lease);
  return new Promise((resolve, reject) => {
    const first = leaseWaiters.length === 0;
    leaseWaiters.push({ resolve, reject });
    if (first) {
      const cap = useVoice.getState().capability;
      transport?.sendRaw({ type: 'request_voice_lease', deviceId: transport.deviceId(), resource: cap?.resource ?? 'voice/doubao' });
    }
    setTimeout(() => {
      const i = leaseWaiters.findIndex((x) => x.resolve === resolve);
      if (i >= 0) { leaseWaiters.splice(i, 1); reject(new VoiceFailure(t('settings:voice.errors.leaseTimeout'), 'lease_timeout')); }
    }, 10_000);
  });
}

// ── Microphone ───────────────────────────────────────────
const WORKLET = `class C extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('kraki-capture',C);`;
interface Capture { stop: () => void }

async function openMicrophone(onPcm: (pcm: Int16Array, level: number) => void): Promise<Capture> {
  if (!navigator.mediaDevices?.getUserMedia) throw new VoiceFailure(t('settings:voice.errors.noMicrophone'), 'mic_unavailable');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    const name = (e as DOMException).name;
    const denied = name === 'NotAllowedError' || name === 'SecurityError';
    throw new VoiceFailure(denied
      ? t('settings:voice.errors.permission')
      : t('settings:voice.errors.noMicrophone'), denied ? 'permission' : 'mic_unavailable');
  }
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'kraki-capture');
  node.port.onmessage = (e) => { const { pcm, peak } = toPcm16(e.data as Float32Array, ctx.sampleRate, TARGET_RATE); if (pcm.length) onPcm(pcm, loudness(peak)); };
  src.connect(node);
  if (ctx.state === 'suspended') await ctx.resume();
  return { stop: () => { try { node.disconnect(); src.disconnect(); } catch { /* gone */ } stream.getTracks().forEach((t) => t.stop()); void ctx.close(); } };
}

// ── One recording ────────────────────────────────────────
interface Recording {
  ws: WebSocket;
  recordingId: string;
  capture: Capture | null;
  pending: Int16Array[];
  ready: boolean;
  finishSent: boolean;
  done: boolean;
  finishMode: VoiceFinish | null;
  onFinal: (text: string, mode: VoiceFinish) => void;
  onStage?: StageVoice;
  staged?: StagedVoice;
  rawText: string;
  timer: ReturnType<typeof setTimeout> | null;
}
let rec: Recording | null = null;

function fail(message: string, cause = VoiceTracker.classify(message)) {
  diag.voices.cause(cause);
  diag.voices.stateChanged('failed');
  rec?.staged?.complete(rec.rawText, rec.rawText, false);
  cleanup();
  useVoice.setState({ phase: 'failed', error: message });
}

function cleanup() {
  if (!rec) return;
  rec.capture?.stop();
  if (rec.timer) clearTimeout(rec.timer);
  try { rec.ws.close(1000, 'done'); } catch { /* gone */ }
  rec = null;
}

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16)));

/**
 * Start dictating for `owner`. Returns false when the one-time notice must be
 * accepted first (it is shown; call again after `acceptConsent`).
 */
export async function startDictation(owner: string, context: VoiceContext, onFinal: (text: string, mode: VoiceFinish) => void, onStage?: StageVoice): Promise<boolean> {
  const st = useVoice.getState();
  if (!st.capability) {
    diag.voices.begin(false, voiceSettings.correction);
    diag.voices.cause('unavailable');
    diag.voices.stateChanged('failed');
    useVoice.setState({ phase: 'failed', owner, error: t('settings:voice.errors.unavailable') }); return true;
  }
  if (!voiceSettings.consented) { useVoice.setState({ consentPending: true, owner }); return false; }
  if (rec) cancelDictation();
  // Web opens a fresh broker socket for every attempt; a cached lease is not a warm connection.
  diag.voices.begin(false, voiceSettings.correction);
  if (!transport?.connected()) {
    diag.voices.cause('offline');
    diag.voices.stateChanged('failed');
    useVoice.setState({ phase: 'failed', owner, error: t('settings:voice.errors.offline') }); return true;
  }
  useVoice.setState({ owner, phase: 'connecting', staged: false, rawText: '', correctionText: '', levels: [], error: null, startedAt: Date.now() });
  const recordingId = uuid();
  let ws: WebSocket;
  try {
    ws = new WebSocket(st.capability.brokerUrl);
  } catch {
    fail(t('settings:voice.errors.invalidAddress'), 'config');
    return true;
  }
  ws.binaryType = 'arraybuffer';
  const r: Recording = { ws, recordingId, capture: null, pending: [], ready: false, finishSent: false, done: false, finishMode: null, onFinal, onStage, rawText: '', timer: null };
  rec = r;
  const send = (m: Record<string, unknown>) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  const flush = () => { if (!r.ready) return; for (const p of r.pending) ws.send(p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength)); r.pending = []; if (r.finishMode && !r.finishSent) sendFinish(); };
  const sendFinish = () => { r.finishSent = true; send({ type: 'finish', recordingId }); };
  r.timer = setTimeout(() => { if (rec === r && useVoice.getState().phase === 'connecting') fail(t('settings:voice.errors.unreachable'), 'timeout'); }, 12_000);

  ws.onmessage = (ev) => {
    if (rec !== r || typeof ev.data !== 'string') return;
    let m: Record<string, unknown>;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (typeof m.recordingId === 'string' && m.recordingId !== recordingId) return;
    switch (m.type) {
      case 'authorized':
        send({
          type: 'start', recordingId, uid: transport?.userId() ?? undefined, deviceId: transport?.deviceId() ?? undefined,
          sampleRate: TARGET_RATE, correction: voiceSettings.correction,
          context: { ...context.fields, ...(context.vocabulary.length ? { vocabulary: context.vocabulary } : {}) },
        });
        break;
      case 'ready':
        r.ready = true;
        if (useVoice.getState().phase === 'connecting') useVoice.setState({ phase: 'recording' });
        flush();
        break;
      case 'transcript':
        if (m.sessionFinal === true) {
          const text = String(m.text ?? '').trim();
          const mode = r.finishMode ?? 'edit';
          const raw = typeof m.rawText === 'string' ? m.rawText : r.rawText || text;
          const correction = useVoice.getState().correctionText.trim();
          diag.voices.finalReceived(new TextEncoder().encode(text).length,
            (typeof m.rawText === 'string' && m.rawText.length > 0) || (correction.length > 0 && correction === text));
          diag.voices.stateChanged('idle');
          r.done = true;
          cleanup();
          useVoice.setState({ phase: 'idle', staged: false, rawText: '', correctionText: '', levels: [], owner: null, startedAt: null });
          if (r.staged) r.staged.complete(text, raw, true);
          else r.onFinal(text, mode);
        } else {
          r.rawText = String(m.text ?? '');
          r.staged?.update(r.rawText, r.rawText);
          useVoice.setState({ rawText: r.rawText });
        }
        break;
      case 'correction_delta':
        if (voiceSettings.correction) {
          const text = String(m.text ?? '');
          r.staged?.update(text, r.rawText);
          useVoice.setState({ correctionText: text });
        }
        break;
      case 'session_denied':
        fail(denialMessage(String(m.reason)) ?? String(m.detail ?? t('settings:voice.errors.refused')), VoiceTracker.classify(String(m.reason ?? 'denied')));
        break;
      case 'error':
        fail(t('settings:voice.errors.failed', { message: String(m.message ?? t('settings:voice.errors.unknown')) }), VoiceTracker.classify(String(m.message ?? 'unknown error')));
        break;
      default:
        break;
    }
  };
  ws.onclose = () => { if (rec === r && !r.done) fail(t('settings:voice.errors.closed'), 'network'); };
  ws.onerror = () => { /* onclose reports it */ };

  diag.voices.stateChanged('obtainingLease');
  try {
    const [l] = await Promise.all([
      getLease(),
      new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve(), { once: true }); ws.addEventListener('error', () => reject(new VoiceFailure(t('settings:voice.errors.unreachable'), 'network')), { once: true }); }),
    ]);
    if (rec !== r) return true;
    send({ type: 'authorize', uid: transport?.userId() ?? undefined, deviceId: transport?.deviceId() ?? undefined, authorization: l });
    diag.voices.stateChanged('requestingPermission');
    r.capture = await openMicrophone((pcm, level) => {
      if (rec !== r || r.finishMode) return;
      const lv = useVoice.getState().levels;
      useVoice.setState({ levels: [...lv.slice(-7), level] });
      if (r.ready) ws.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
      else if (r.pending.reduce((n, p) => n + p.byteLength, 0) < 384_000) r.pending.push(pcm);
    }).catch((e: Error) => { throw e instanceof VoiceFailure ? e : new VoiceFailure(e.message, 'audio_session'); });
    if (rec !== r) { r.capture.stop(); return true; }
    diag.voices.stateChanged('recording');
    if (useVoice.getState().phase === 'connecting') useVoice.setState({ phase: 'recording' });
  } catch (e) {
    if (rec === r) fail((e as Error).message, e instanceof VoiceFailure ? e.metricCause : VoiceTracker.classify((e as Error).message));
  }
  return true;
}

/** Stop listening; the final (corrected) transcript is sent or put in the draft. */
export function finishDictation(mode: VoiceFinish) {
  const r = rec;
  if (!r || r.finishMode) return;
  if (mode === 'send' && r.onStage) {
    const staged = r.onStage(r.rawText);
    if (!staged) return;
    r.staged = staged;
  }
  r.finishMode = mode;
  // Send during lease/microphone admission must not open the mic afterwards.
  if (!r.capture && useVoice.getState().phase === 'connecting') {
    fail(t('settings:voice.errors.unfinished'), 'gateway');
    return;
  }
  r.capture?.stop();
  r.capture = null;
  diag.voices.stateChanged('finishing');
  useVoice.setState({ phase: 'finishing', staged: !!r.staged, levels: [] });
  if (r.ready && !r.finishSent) { r.finishSent = true; r.ws.send(JSON.stringify({ type: 'finish', recordingId: r.recordingId })); }
  if (r.timer) clearTimeout(r.timer);
  r.timer = setTimeout(() => { if (rec === r) fail(t('settings:voice.errors.finishTimeout'), 'timeout'); }, 25_000);
}

export function cancelDictation() {
  diag.voices.outcome('cancelled', false);
  diag.voices.stateChanged('idle');
  rec?.staged?.complete(rec.rawText, rec.rawText, false);
  cleanup();
  useVoice.setState({ phase: 'idle', staged: false, rawText: '', correctionText: '', levels: [], error: null, owner: null, startedAt: null });
}

export function dismissVoiceError() {
  if (useVoice.getState().phase === 'failed') useVoice.setState({ phase: 'idle', error: null, owner: null });
}

export function acceptConsent() { voiceSettings.grantConsent(); useVoice.setState({ consentPending: false }); }
export function declineConsent() { useVoice.setState({ consentPending: false, owner: null }); }

/** What the composer shows while dictating (VoiceComposerPresentation). */
export function transcriptPieces(s: Pick<VoiceState, 'phase' | 'rawText' | 'correctionText'>): { text: string; opacity: number }[] {
  if (s.phase === 'connecting') return [{ text: t('settings:voice.connecting'), opacity: 0.45 }];
  if (s.phase === 'recording') return [{ text: s.rawText || t('settings:voice.listening'), opacity: s.rawText ? 1 : 0.45 }];
  if (s.phase === 'finishing') {
    if (!s.correctionText) return [{ text: s.rawText || t('settings:voice.correcting'), opacity: 0.82 }];
    const chars = [...s.correctionText];
    const tail = [0.48, 0.64, 0.78, 0.9];
    return chars.map((c, i) => ({ text: c, opacity: tail[chars.length - 1 - i] ?? 0.96 }));
  }
  return [];
}

// ── Custom Words (account) ───────────────────────────────
let inFlight: { id: string; count: number } | null = null;
let resendTimer: ReturnType<typeof setTimeout> | null = null;

export function wordLines(): string[] { return useVoice.getState().words.map(wordLine); }

export function editWords(ops: VoiceWordOp[]): string | null {
  const clean: VoiceWordOp[] = [];
  for (const op of ops) {
    if (op.op === 'remove') { clean.push(op); continue; }
    const w = cleanWord(op.term, op.heardAs ?? '');
    if (!w) return t('settings:voice.invalidWord');
    clean.push({ ...op, ...w });
  }
  const st = useVoice.getState();
  const outbox = [...st.outbox, ...clean];
  useVoice.setState({ outbox, words: applyOps(outbox, st.serverWords) });
  flushWords();
  return null;
}

export function flushWords() {
  if (!transport?.connected()) return;
  const st = useVoice.getState();
  const count = inFlight?.count ?? Math.min(st.outbox.length, 200);
  if (!count) return;
  const id = inFlight?.id ?? uuid();
  inFlight = { id, count };
  transport.sendRaw({ type: 'update_voice_vocabulary', requestId: id, ops: st.outbox.slice(0, count) });
  if (resendTimer) clearTimeout(resendTimer);
  resendTimer = setTimeout(flushWords, 5000);
}

/** voice_vocabulary_updated: the account's list (and, with our requestId, an ack). */
export function onWordsUpdated(words: VoiceWord[], requestId?: string) {
  const st = useVoice.getState();
  let outbox = st.outbox;
  if (requestId && inFlight?.id === requestId) {
    outbox = outbox.slice(inFlight.count);
    inFlight = null;
    if (resendTimer) clearTimeout(resendTimer);
  }
  useVoice.setState({ serverWords: words, outbox, words: applyOps(outbox, words) });
  if (outbox.length) flushWords();
}

/** Signed out / account deleted: nothing of the account stays. */
export function resetVoice() {
  diag.voices.outcome('suspended');
  cancelDictation();
  lease = null; inFlight = null;
  useVoice.setState({ capability: null, words: [], serverWords: [], outbox: [], consentPending: false });
}
