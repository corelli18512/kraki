import { beforeEach, describe, expect, it, vi } from 'vitest';
import { outbox, useOutbox, checkDeadlines } from '../chat/outbox';
import { alignedRawPrefixLength, mergeVoiceDraft, stagedVoice } from './staged-input';

describe('staged voice input — IOSVoiceComposer completion', () => {
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    outbox.reset();
    send = vi.fn(async () => true);
    outbox.configure({ send, isDeliveryPathUp: () => true });
  });
  it('stages locally, streams corrected text, then dispatches the same clientId', () => {
    const id = outbox.stage('s', 'base raw words', { answerTo: 'q', delivery: 'steer' });
    const voice = stagedVoice(id, 'base', false, vi.fn());
    expect(send).not.toHaveBeenCalled();
    expect(outbox.forSession('s')[0].state).toBe('correcting');
    voice.update('Raw', 'raw words');
    expect(outbox.forSession('s')[0].text).toBe('base Raw words');
    voice.complete('Correct words', 'raw words', true);
    expect(send).toHaveBeenCalledWith({ type: 'send_input', sessionId: 's', payload: { text: 'base Correct words', clientId: id, answerTo: 'q' } });
    expect(outbox.forSession('s')[0].state).toBe('sending');
    outbox.confirm('s', id, 'base Correct words');
    expect(outbox.forSession('s')).toEqual([]);
  });
  it('recognition error/cancel returns heard text to the draft, never sends it', () => {
    const restore = vi.fn();
    const id = outbox.stage('s', 'raw');
    stagedVoice(id, 'base', false, restore).complete('raw', 'raw', false);
    expect(restore).toHaveBeenCalledWith('base raw');
    expect(outbox.forSession('s')).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
  it('recognition failure with an image keeps the original failed bubble for Retry', () => {
    const id = outbox.stage('s', 'raw', { attachments: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] });
    stagedVoice(id, '', true, vi.fn()).complete('half corrected', 'raw', false);
    expect(outbox.forSession('s')[0]).toMatchObject({ state: 'failed', text: 'raw' });
    expect(send).not.toHaveBeenCalled();
    outbox.retry(id);
    expect(send).toHaveBeenCalledOnce();
  });
  it('silence discards an empty send but preserves existing text and images', () => {
    const empty = outbox.stage('s', '');
    stagedVoice(empty, '', false, vi.fn()).complete('', '', true);
    expect(outbox.forSession('s')).toEqual([]);
    const base = outbox.stage('s', 'draft');
    stagedVoice(base, 'draft', false, vi.fn()).complete('', '', false);
    expect(outbox.forSession('s')[0]).toMatchObject({ state: 'sending', text: 'draft' });
    const image = outbox.stage('s', '');
    stagedVoice(image, '', true, vi.fn()).complete('', '', true);
    expect(outbox.forSession('s')[1].text).toBe('[image]');
  });
  it('late correction never resurrects a deleted, edited or sent-original message', () => {
    const id = outbox.stage('s', 'raw');
    const voice = stagedVoice(id, '', false, vi.fn());
    outbox.discard(id);
    voice.update('fixed', 'raw');
    voice.complete('fixed', 'raw', true);
    expect(send).not.toHaveBeenCalled();
    const original = outbox.stage('s', 'raw');
    const second = stagedVoice(original, '', false, vi.fn());
    outbox.retry(original);
    second.complete('fixed', 'raw', true);
    expect(send).toHaveBeenCalledOnce();
    expect(outbox.forSession('s')[0].text).toBe('raw');
  });
  it.each([true, false])('network returns %s before/after correction: correction is always first', async (onlineInitially) => {
    let online = onlineInitially;
    outbox.configure({ send: async (msg) => { if (!online) return false; return send(msg); }, isDeliveryPathUp: () => online });
    const id = outbox.stage('s', 'raw');
    const voice = stagedVoice(id, '', false, vi.fn());
    checkDeadlines();
    expect(send).not.toHaveBeenCalled();
    voice.complete('fixed', 'raw', true);
    await Promise.resolve(); await Promise.resolve();
    expect(outbox.forSession('s')[0].state).toBe('sending');
    if (!online) { expect(send).not.toHaveBeenCalled(); online = true; checkDeadlines(); }
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].payload.text).toBe('fixed');
  });
  it('reload during correction fails with the original transcript, never auto-sends', () => {
    const id = outbox.stage('s', 'raw');
    outbox.updateStaged(id, 'partially fixed', 'raw');
    outbox.reloadForTesting();
    expect(useOutbox.getState().entries[0]).toMatchObject({ state: 'failed', text: 'raw' });
    checkDeadlines();
    expect(send).not.toHaveBeenCalled();
  });
  it('preserves native whitespace, punctuation and CJK boundaries when appending speech', () => {
    expect(mergeVoiceDraft('Hello ', 'world')).toBe('Hello world');
    expect(mergeVoiceDraft('Hello', 'world')).toBe('Hello world');
    expect(mergeVoiceDraft('Hello', ', world')).toBe('Hello, world');
    expect(mergeVoiceDraft('你好', '世界')).toBe('你好世界');
  });
  it('aligns corrected prefixes ignoring case/whitespace and retaining raw tails', () => {
    expect(alignedRawPrefixLength('hello', 'Hello world')).toBe(5);
    expect(alignedRawPrefixLength('  HELLO', 'Hello world')).toBe(5);
    expect(alignedRawPrefixLength('', 'raw')).toBe(0);
  });
});
