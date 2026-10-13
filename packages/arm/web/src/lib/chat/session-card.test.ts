import { outbox, checkDeadlines } from './outbox';
import { describe, expect, it } from 'vitest';
import { sessionTimeLabel, sessionTimestamp, sessionPendingPreview, type SessionPendingInput } from './session-card';

const pending = (values: Partial<SessionPendingInput> = {}): SessionPendingInput => ({
  clientId: 'a', sessionId: 's', text: 'hello\n world', timestamp: '2026-06-10T09:00:00Z', order: 1, state: 'sending', ...values,
});

describe('sessionTimeLabel (SessionTimeFormatter)', () => {
  const now = new Date(2026, 5, 10, 12, 0);
  it('uses local 24-hour time today and lowercase yesterday', () => {
    expect(sessionTimeLabel(new Date(2026, 5, 10, 9, 5).toISOString(), now)).toBe('09:05');
    expect(sessionTimeLabel(new Date(2026, 5, 9, 23, 59).toISOString(), now)).toBe('yesterday');
  });
  it('uses elapsed whole calendar days with a minimum of two, never weekdays/dates', () => {
    expect(sessionTimeLabel(new Date(2026, 5, 8, 23).toISOString(), now)).toBe('2d ago');
    expect(sessionTimeLabel(new Date(2026, 5, 7, 13).toISOString(), now)).toBe('2d ago');
    expect(sessionTimeLabel(new Date(2026, 5, 1, 9).toISOString(), now)).toBe('9d ago');
    expect(sessionTimeLabel(new Date(2026, 5, 11).toISOString(), now)).toBe('2d ago');
  });
  it('rejects empty or invalid timestamps', () => {
    expect(sessionTimeLabel('', now)).toBe('');
    expect(sessionTimeLabel('invalid', now)).toBe('');
  });
});

describe('sessionPendingPreview (SessionPendingPreview.select)', () => {
  it('prioritizes errors over newer pending sends, ignoring other sessions', () => {
    const result = sessionPendingPreview([pending({ state: 'failed' }), pending({ clientId: 'b', order: 3 }), pending({ sessionId: 'other', order: 4, state: 'failed' })], 's', true);
    expect(result).toEqual({ text: 'Send failed · hello world', status: 'failed', timestamp: pending().timestamp });
  });
  it('uses local order, timestamp and clientId tie breaks', () => {
    expect(sessionPendingPreview([pending({ text: 'old' }), pending({ order: 2, text: 'new' })], 's', true)?.text).toBe('new');
    expect(sessionPendingPreview([pending({ text: 'old' }), pending({ timestamp: '2026-06-11T00:00:00Z', text: 'new' })], 's', true)?.text).toBe('new');
    expect(sessionPendingPreview([pending({ text: 'old' }), pending({ clientId: 'b', text: 'new' })], 's', true)?.text).toBe('new');
  });
  it('queues sending offline, preserves failures and uses attachment/empty fallback', () => {
    expect(sessionPendingPreview([pending()], 's', false)?.text).toBe('Waiting for connection · hello world');
    expect(sessionPendingPreview([pending({ text: '', attachments: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] })], 's', true)?.text).toBe('[image]');
    expect(sessionPendingPreview([pending({ text: '' })], 's', true)?.text).toBe('…');
    expect(sessionPendingPreview([], 's', true)).toBeUndefined();
  });
  it('is ready for native unconfirmed and correcting states without treating local correction as transport', () => {
    expect(sessionPendingPreview([pending({ state: 'unconfirmed' })], 's', false)?.text).toBe('Awaiting confirmation · hello world');
    expect(sessionPendingPreview([pending({ state: 'correcting' })], 's', false)?.status).toBe('correcting');
  });
});


describe('sessionTimestamp (native effective preview date)', () => {
  const created = '2026-06-10T09:00:00Z';
  it('keeps a valid preview and falls back on missing, empty or invalid previews', () => {
    expect(sessionTimestamp('2026-06-11T09:00:00+00:00', created)).toBe('2026-06-11T09:00:00+00:00');
    for (const preview of [undefined, '', 'invalid']) expect(sessionTimestamp(preview, created)).toBe(created);
    expect(sessionTimestamp(undefined, 'invalid')).toBe('');
    expect(sessionTimestamp()).toBe('');
  });
});

describe('native delivery preview lifecycle producers', () => {
  it('projects actual correcting/unconfirmed outbox states, with failed-first native priority', () => {
    outbox.reset();
    outbox.configure({ send: async () => true, isDeliveryPathUp: () => true });
    outbox.setConfirmationTimeout(1000);
    const staged = outbox.stage('s', 'raw words');
    expect(sessionPendingPreview(outbox.forSession('s'), 's', false)).toMatchObject({ text: 'raw words', status: 'correcting' });
    outbox.dispatchStaged(staged, 'Fixed words');
    checkDeadlines(Date.now() + 2000);
    expect(sessionPendingPreview(outbox.forSession('s'), 's', false)).toMatchObject({ text: 'Awaiting confirmation · Fixed words', status: 'unconfirmed' });
    const failed = outbox.stage('s', 'older failure');
    outbox.failStaged(failed, 'older failure');
    outbox.stage('s', 'newer correcting');
    expect(sessionPendingPreview(outbox.forSession('s'), 's', true)).toMatchObject({ text: 'Send failed · older failure', status: 'failed' });
    outbox.reset();
    outbox.setConfirmationTimeout(30_000);
  });
});
