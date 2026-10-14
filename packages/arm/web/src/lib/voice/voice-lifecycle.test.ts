import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelDictation, configureVoiceTransport, finishDictation, onAuthOk, onLeaseGrant, resetVoice, startDictation, useVoice, voiceSettings } from './voice';

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
  onLeaseGrant({ payload: { exp: Date.now() / 1000 + 3600, did: 'd' } } as never);
});
afterEach(() => { resetVoice(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

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
