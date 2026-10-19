import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelDictation, configureVoiceTransport, dismissVoiceError, finishDictation, onAuthOk, onLeaseDenied, onLeaseGrant, resetVoice, startDictation, useVoice, voiceSettings } from './voice';
import { diag } from '../diag';

class SpeechSocket {
  static OPEN = 1;
  static latest: SpeechSocket;
  readyState = 1;
  onmessage?: (ev: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  send = vi.fn();
  close = vi.fn();
  constructor() { SpeechSocket.latest = this; }
  addEventListener(name: string, callback: () => void) { if (name === 'open') queueMicrotask(callback); }
  feed(message: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', SpeechSocket);
  vi.stubGlobal('AudioContext', class {
    audioWorklet = { addModule: async () => {} };
    state = 'running'; sampleRate = 48000;
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async close() {}
  });
  vi.stubGlobal('AudioWorkletNode', class { port = {}; disconnect() {} });
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:voice-test'; } });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
  configureVoiceTransport({ sendRaw: () => {}, deviceId: () => 'd', userId: () => 'u', relayUrl: () => 'ws://localhost:4430', connected: () => true });
  onAuthOk({ brokerUrl: 'ws://localhost:4430/voice', resource: 'voice/doubao' }, []);
  voiceSettings.grantConsent();
  voiceSettings.correction = true;
  onLeaseGrant({ payload: { exp: Date.now() / 1000 + 3600, did: 'd' } } as never);
});
afterEach(() => { resetVoice(); if (diag.voices) diag.voices.onSummary = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('voice staged send callbacks', () => {
  it('send frees the editor, updates the staged input and completes only on the final transcript', async () => {
    const stage = { update: vi.fn(), complete: vi.fn() }, onStage = vi.fn(() => stage), final = vi.fn();
    await startDictation('s', { fields: {}, vocabulary: [] }, final, onStage);
    SpeechSocket.latest.feed({ type: 'ready' });
    SpeechSocket.latest.feed({ type: 'transcript', text: 'raw' });
    finishDictation('send');
    expect(onStage).toHaveBeenCalledWith('raw');
    expect(useVoice.getState()).toMatchObject({ phase: 'finishing', staged: true });
    SpeechSocket.latest.feed({ type: 'correction_delta', text: 'Fixed' });
    expect(stage.update).toHaveBeenCalledWith('Fixed', 'raw');
    SpeechSocket.latest.feed({ type: 'transcript', sessionFinal: true, text: 'Fixed', rawText: 'raw' });
    expect(stage.complete).toHaveBeenCalledWith('Fixed', 'raw', true);
    expect(final).not.toHaveBeenCalled();
    expect(useVoice.getState()).toMatchObject({ phase: 'idle', staged: false });
  });
  it.each(['cancel', 'error', 'timeout'])('staged %s completes as not recognized, never as a final send', async (cause) => {
    const stage = { update: vi.fn(), complete: vi.fn() }, final = vi.fn();
    await startDictation('s', { fields: {}, vocabulary: [] }, final, () => stage);
    SpeechSocket.latest.feed({ type: 'ready' });
    SpeechSocket.latest.feed({ type: 'transcript', text: 'raw' });
    finishDictation('send');
    if (cause === 'cancel') cancelDictation();
    else if (cause === 'error') SpeechSocket.latest.feed({ type: 'error', message: 'upload failed' });
    else await vi.advanceTimersByTimeAsync(25_000);
    expect(stage.complete).toHaveBeenCalledExactlyOnceWith('raw', 'raw', false);
    expect(final).not.toHaveBeenCalled();
  });
  it('Edit and new-session final-only flows never stage an input', async () => {
    const onStage = vi.fn(), final = vi.fn();
    await startDictation('new', { fields: {}, vocabulary: [] }, final, onStage);
    SpeechSocket.latest.feed({ type: 'ready' });
    finishDictation('edit');
    SpeechSocket.latest.feed({ type: 'transcript', sessionFinal: true, text: 'final' });
    expect(final).toHaveBeenCalledWith('final', 'edit');
    expect(onStage).not.toHaveBeenCalled();
  });
});

describe('voice.summary controller hooks', () => {
  function summaries() {
    const summary = vi.fn();
    diag.voices.onSummary = summary;
    return summary;
  }
  it('times a final recording and uses UTF-8 length and native correction confirmation', async () => {
    const summary = summaries();
    await startDictation('s', { fields: {}, vocabulary: [] }, vi.fn());
    await vi.advanceTimersByTimeAsync(2000);
    finishDictation('edit');
    await vi.advanceTimersByTimeAsync(300);
    SpeechSocket.latest.feed({ type: 'transcript', sessionFinal: true, text: 'café', rawText: 'cafe' });
    dismissVoiceError(); cancelDictation();
    expect(summary).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'final', stage: 'finishing',
      warm: false, leaseRollovers: 0, textLength: 5, recordMs: 2000, finalizeMs: 300, correctionConfirmed: true }));
  });
  it.each([true, false])('correctionOn=%s is captured at begin, unchanged final confirmation uses the stream', async (enabled) => {
    const summary = summaries();
    voiceSettings.correction = enabled;
    await startDictation('s', { fields: {}, vocabulary: [] }, vi.fn());
    SpeechSocket.latest.feed({ type: 'correction_delta', text: '  Final  ' });
    finishDictation('edit');
    SpeechSocket.latest.feed({ type: 'transcript', sessionFinal: true, text: 'Final' });
    expect(summary).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'final', correctionEnabled: enabled, correctionConfirmed: enabled }));
  });
  it('an unconfirmed raw final is a final outcome, not a correction failure', async () => {
    const summary = summaries();
    await startDictation('s', { fields: {}, vocabulary: [] }, vi.fn());
    finishDictation('edit');
    SpeechSocket.latest.feed({ type: 'transcript', sessionFinal: true, text: 'raw final' });
    expect(summary).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'final', correctionConfirmed: false }));
  });
  it.each(['unavailable', 'offline'] as const)('preflight %s has a coarse cause and no recording duration', async (cause) => {
    const summary = summaries();
    if (cause === 'unavailable') onAuthOk(undefined, []);
    else configureVoiceTransport({ sendRaw: () => {}, deviceId: () => 'd', userId: () => 'u', relayUrl: () => 'ws://localhost:4430', connected: () => false });
    await startDictation('s', { fields: {}, vocabulary: [] }, vi.fn());
    dismissVoiceError();
    expect(summary).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'failed', stage: 'preflight', cause }));
    expect(summary.mock.calls[0][0].recordMs).toBeUndefined();
  });
  it.each(['NotAllowedError', 'NotFoundError'])('microphone %s is reported in permission admission', async (name) => {
    const summary = summaries();
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('private error', name); };
    await startDictation('s', { fields: {}, vocabulary: [] }, vi.fn());
    expect(summary).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'failed', stage: 'permission', cause: name === 'NotAllowedError' ? 'permission' : 'mic_unavailable' }));
  });
  it('broker socket connection failure is network, not the localized error message', async () => {
    const summary = summaries();
    vi.stubGlobal('WebSocket', class extends SpeechSocket {
      addEventListener(name: string, callback: () => void) { if (name === 'error') queueMicrotask(callback); }
    });
    await startDictation('s', { fields: {}, vocabulary: [] }, vi.fn());
    expect(summary).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'failed', stage: 'lease', cause: 'network' }));
  });
  it('invalid broker configuration fails at preflight', async () => {
    const summary = summaries();
    vi.stubGlobal('WebSocket', class { constructor() { throw new Error('private URL'); } });
    await startDictation('s', { fields: {}, vocabulary: [] }, vi.fn());
    expect(summary).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'failed', stage: 'preflight', cause: 'config' }));
  });
  it('audio setup failure is audio_session, never its error text', async () => {
    const summary = summaries();
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('private audio error'); } });
    await startDictation('s', { fields: {}, vocabulary: [] }, vi.fn());
    expect(summary).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'failed', stage: 'permission', cause: 'audio_session' }));
  });
  it.each(['denied', 'timeout'])('lease %s is reported in lease admission', async (mode) => {
    const summary = summaries();
    onLeaseGrant({ payload: { exp: 0, did: 'd' } } as never);
    const starting = startDictation('s', { fields: {}, vocabulary: [] }, vi.fn());
    if (mode === 'denied') onLeaseDenied('quota_exhausted', 'private detail');
    else await vi.advanceTimersByTimeAsync(10_000);
    await starting;
    expect(summary).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'failed', stage: 'lease', cause: mode === 'denied' ? 'lease_denied_quota_exhausted' : 'lease_timeout' }));
  });
  it.each(['cancel', 'reset', 'gateway', 'timeout'])('%s closes the attempt once with the right outcome and stage', async (mode) => {
    const summary = summaries();
    await startDictation('s', { fields: {}, vocabulary: [] }, vi.fn());
    if (mode === 'cancel') cancelDictation();
    else if (mode === 'reset') resetVoice();
    else if (mode === 'gateway') SpeechSocket.latest.feed({ type: 'error', message: 'voice upload stalled: secret transcript' });
    else { finishDictation('edit'); await vi.advanceTimersByTimeAsync(25_000); }
    dismissVoiceError();
    expect(summary).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      outcome: mode === 'cancel' ? 'cancelled' : mode === 'reset' ? 'suspended' : 'failed',
      stage: mode === 'timeout' ? 'finishing' : 'recording',
      ...(mode === 'gateway' ? { cause: 'upload_stalled' } : mode === 'timeout' ? { cause: 'timeout' } : {}),
    }));
    expect(JSON.stringify(summary.mock.calls)).not.toContain('secret');
  });
});
