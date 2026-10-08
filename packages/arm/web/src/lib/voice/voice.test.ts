import { describe, expect, it } from 'vitest';
import { applyVoiceWordOps } from '../../../../../head/src/voice-vocabulary';
import { isSensitive, sessionContext, newSessionContext } from './context';
import { loudness, toPcm16 } from './pcm';
import { applyOps, cleanWord, wordLine } from './words';

describe('voice PCM', () => {
  it('downsamples 48 kHz to 16 kHz Int16 by averaging and reports the peak', () => {
    const f = new Float32Array(480).fill(0.5);
    const { pcm, peak } = toPcm16(f, 48_000);
    expect(pcm.length).toBe(160);
    expect(pcm[0]).toBe(Math.round(0.5 * 32767));
    expect(peak).toBe(0.5);
  });
  it('upsamples slower input by interpolation', () => {
    const { pcm } = toPcm16(new Float32Array([0, 1, 0, 1]), 8_000);
    expect(pcm.length).toBe(8);
    expect(pcm[1]).toBe(Math.round(0.5 * 32767));
  });
  it('maps loudness like the native meter', () => {
    expect(loudness(0)).toBe(0);
    expect(loudness(1)).toBe(1);
    expect(loudness(10 ** (-48 / 20))).toBeCloseTo(0);
  });
});

describe('voice context (never leak)', () => {
  it('drops secrets, URLs, paths and long ids', () => {
    for (const s of ['ghp_abcdefghijklmnop', 'sk-live-xyz', 'AKIAABCDEFGHIJKLMNOP', 'https://x.y', 'a@b.c', 'src/app.ts', 'localhost:8080', 'deadbeefcafe1234', 'Ab3dE5gH7jK9mN2pQ4']) {
      expect(isSensitive(s), s).toBe(true);
    }
    for (const s of ['PulseManager.connect', 'reconnectStream', 'Kubernetes', 'date_parse']) expect(isSensitive(s), s).toBe(false);
  });
  it('takes only distinctive identifiers from recent messages, user words first', () => {
    const c = sessionContext({ id: 's', title: 'Fix stream', agent: 'claude', model: 'opus' },
      ['The stall is in PulseManager.connect() and token ghp_abcdefghijklmnopqrst', 'plain words only'], ['Kraki = cracky'], true);
    const terms = (c.fields.session as { terms: string[] }).terms;
    expect(terms).toContain('PulseManager.connect');
    expect(terms.some((t) => t.startsWith('ghp_'))).toBe(false);
    expect(terms).not.toContain('plain');
    expect(c.vocabulary[0]).toBe('Kraki = cracky');
  });
  it('shares nothing but words and locale when context sharing is off', () => {
    const c = sessionContext({ id: 's', title: 'Secret project', agent: 'claude' }, ['FooBar'], ['X'], false);
    expect(c.fields.session).toBeUndefined();
    expect(JSON.stringify(c)).not.toContain('Secret');
    expect(newSessionContext('codex', 'gpt', 'Office PC', [], true).vocabulary).toEqual(['codex', 'gpt', 'Office PC']);
  });
});

describe('Custom Words mirror Head exactly', () => {
  const cases: [string, Parameters<typeof applyOps>[0]][] = [
    ['add + merge heard', [{ op: 'add', term: 'Kubernetes', heardAs: 'cooper netties' }, { op: 'add', term: 'kubernetes', heardAs: 'cube nettis, cooper netties' }]],
    ['rename onto existing', [{ op: 'add', term: 'A' }, { op: 'add', term: 'B', heardAs: 'bee' }, { op: 'edit', from: 'A', term: 'b', heardAs: 'be' }]],
    ['edit same word', [{ op: 'add', term: 'kubectl', heardAs: 'cube control' }, { op: 'edit', from: 'KUBECTL', term: 'kubectl', heardAs: 'cube cuddle' }]],
    ['remove', [{ op: 'add', term: 'x' }, { op: 'remove', term: 'X' }]],
  ];
  for (const [name, ops] of cases) {
    it(name, () => expect(applyOps(ops, [])).toEqual(applyVoiceWordOps([], ops)));
  }
  it('cleans like Head and formats corrector lines', () => {
    expect(cleanWord('  PostgreSQL ', 'post gress，postgress')).toEqual({ term: 'PostgreSQL', heardAs: 'post gress, postgress' });
    expect(cleanWord('a = b')).toBeNull();
    expect(cleanWord('#comment')).toBeNull();
    expect(wordLine({ term: 'kubectl', heardAs: 'cube control' })).toBe('kubectl = cube control');
  });
});

import { brokerAllowed, transcriptPieces, startDictation, useVoice, configureVoiceTransport, onAuthOk, voiceSettings, acceptConsent, cancelDictation } from './voice';

describe('voice controller rules', () => {
  it('sends audio only to Kraki speech service or your own relay host', () => {
    expect(brokerAllowed('wss://stt.kraki.chat/voice', 'wss://relay.kraki.chat')).toBe(true);
    expect(brokerAllowed('ws://stt.kraki.chat/voice', 'wss://relay.kraki.chat')).toBe(false);
    expect(brokerAllowed('wss://evil.example/voice', 'wss://relay.kraki.chat')).toBe(false);
    expect(brokerAllowed('ws://10.0.2.2:7890/voice', 'ws://10.0.2.2:4470')).toBe(true);
    expect(brokerAllowed('ws://10.0.2.3:7890/voice', 'ws://10.0.2.2:4470')).toBe(false);
  });
  it('shows Listening…, the raw words, then the correction with a fading tail', () => {
    expect(transcriptPieces({ phase: 'recording', rawText: '', correctionText: '' })).toEqual([{ text: 'Listening…', opacity: 0.45 }]);
    expect(transcriptPieces({ phase: 'recording', rawText: 'hi', correctionText: '' })).toEqual([{ text: 'hi', opacity: 1 }]);
    const t = transcriptPieces({ phase: 'finishing', rawText: 'x', correctionText: 'Hello' });
    expect(t.map((p) => p.text).join('')).toBe('Hello');
    expect(t[t.length - 1].opacity).toBe(0.48);
  });
  it('asks once before the first recording; nothing is sent until accepted', async () => {
    localStorage.clear();
    const sent: unknown[] = [];
    configureVoiceTransport({ sendRaw: (m) => sent.push(m), deviceId: () => 'd', userId: () => 'u', relayUrl: () => 'wss://relay.kraki.chat', connected: () => true });
    onAuthOk({ brokerUrl: 'wss://stt.kraki.chat/voice', resource: 'voice/doubao' }, []);
    expect(voiceSettings.consented).toBe(false);
    const started = await startDictation('s1', { fields: {}, vocabulary: [] }, () => {});
    expect(started).toBe(false);
    expect(useVoice.getState().consentPending).toBe(true);
    expect(sent).toEqual([]);
    acceptConsent();
    expect(voiceSettings.consented).toBe(true);
    cancelDictation();
  });
  it('no voice gateway advertised → no mic', () => {
    onAuthOk(undefined, []);
    expect(useVoice.getState().capability).toBeNull();
  });
});

describe('context terms are names, not sentence words', () => {
  it('skips sentence punctuation and capitalized ordinary words', () => {
    const c = sessionContext({ id: 's', agent: 'pi', model: 'deepseek/flash' },
      ['Since you asked, use PulseManager.connect() here. Do anything. Try kube-proxy and my_var or HTTP2.'], [], true);
    const terms = (c.fields.session as { terms: string[] }).terms;
    expect(terms).toEqual(expect.arrayContaining(['PulseManager.connect', 'kube-proxy', 'my_var', 'HTTP2']));
    for (const w of ['Since', 'anything', 'anything.', 'here.', 'Do', 'Try']) expect(terms).not.toContain(w);
  });
});
