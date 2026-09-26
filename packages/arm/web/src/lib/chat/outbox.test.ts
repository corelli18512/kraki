import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkDeadlines, outbox, useOutbox } from './outbox';

describe('outbox', () => {
  let sent: Record<string, unknown>[];
  let pathUp: boolean;
  let transportOk: boolean;

  beforeEach(() => {
    sent = [];
    pathUp = true;
    transportOk = true;
    outbox.reset();
    outbox.setConfirmationTimeout(20_000);
    outbox.configure({
      send: async (msg) => { sent.push(msg); return transportOk; },
      isDeliveryPathUp: () => pathUp,
    });
  });
  afterEach(() => vi.useRealTimers());

  const payload = () => sent.at(-1)!.payload as Record<string, unknown>;

  it('sends at once and is confirmed by the echo', () => {
    const id = outbox.send('s', 'hi');
    expect(payload()).toEqual({ text: 'hi', clientId: id });
    expect(outbox.forSession('s')[0].state).toBe('sending');
    expect(outbox.confirm('s', id, 'hi')).toBe(true);
    expect(outbox.forSession('s')).toEqual([]);
  });

  it('an answer carries answerTo and is never a steer', () => {
    outbox.send('s', 'Blue', { answerTo: 'q1', delivery: 'steer' });
    expect(payload()).toMatchObject({ text: 'Blue', answerTo: 'q1' });
    expect(payload().delivery).toBeUndefined();
    outbox.send('s', 'also', { delivery: 'steer' });
    expect(payload().delivery).toBe('steer');
  });

  it('fails only while the delivery path is up; retry keeps the clientId', () => {
    const id = outbox.send('s', 'hi');
    const t0 = Date.now();
    pathUp = false;
    checkDeadlines(t0 + 21_000);
    expect(outbox.forSession('s')[0].state).toBe('sending');
    pathUp = true;
    checkDeadlines(t0 + 42_000);
    expect(outbox.forSession('s')[0].state).toBe('failed');
    outbox.retry(id);
    expect(outbox.forSession('s')[0].state).toBe('sending');
    expect(payload().clientId).toBe(id);
  });

  it('a transport failure marks it failed', async () => {
    transportOk = false;
    outbox.send('s', 'hi');
    await Promise.resolve();
    await Promise.resolve();
    expect(outbox.forSession('s')[0].state).toBe('failed');
  });

  it('an echo without clientId matches by text', () => {
    outbox.send('s', 'hi');
    expect(outbox.confirm('s', undefined, 'other')).toBe(false);
    expect(outbox.confirm('s', undefined, 'hi')).toBe(true);
  });

  it('persists and restores as failed', () => {
    outbox.send('s', 'hi', { answerTo: 'q1' });
    const stored = JSON.parse(localStorage.getItem('kraki-outbox-v1')!);
    expect(stored[0]).toMatchObject({ text: 'hi', answerTo: 'q1' });
    expect(useOutbox.getState().entries).toHaveLength(1);
  });

  it('discard returns the text', () => {
    const id = outbox.send('s', 'hi');
    expect(outbox.discard(id)).toBe('hi');
    expect(outbox.forSession('s')).toEqual([]);
  });
});
