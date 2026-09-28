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

  it('persists across a reload', () => {
    outbox.send('s', 'hi', { answerTo: 'q1' });
    const stored = JSON.parse(localStorage.getItem('kraki-outbox-v1')!);
    expect(stored[0]).toMatchObject({ text: 'hi', answerTo: 'q1' });
    expect(useOutbox.getState().entries).toHaveLength(1);
  });

  it('a dead or reconnecting link never fails an input (time only counts while live)', () => {
    outbox.setConfirmationTimeout(30_000);
    outbox.send('s', 'hi');
    const t0 = Date.now();
    pathUp = false; // e.g. half-open: quiet socket, or reconnecting
    for (let t = 1; t <= 10; t++) checkDeadlines(t0 + t * 60_000);
    expect(outbox.forSession('s')[0].state).toBe('sending');
  });

  it('a restored (reloaded) input is resent once its Tentacle is known to deduplicate', async () => {
    const id = outbox.send('s', 'hi');
    sent = [];
    // Simulate a page reload: state re-read from storage.
    outbox.reloadForTesting();
    const fresh = { outbox, checkDeadlines };
    let accepts: boolean | undefined;
    const resent: Record<string, unknown>[] = [];
    fresh.outbox.configure({
      send: async (msg) => { resent.push(msg); return true; },
      isDeliveryPathUp: () => true,
      acceptsResend: () => accepts,
    });
    expect(fresh.outbox.forSession('s')[0].state).toBe('sending');
    fresh.checkDeadlines();
    expect(resent).toEqual([]); // Tentacle not greeted yet
    accepts = true;
    fresh.checkDeadlines();
    expect((resent[0].payload as Record<string, unknown>).clientId).toBe(id);
    fresh.checkDeadlines();
    expect(resent).toHaveLength(1);
    fresh.outbox.reset();
  });

  it('a restored input is left to the user when the Tentacle would run it twice', async () => {
    outbox.send('s', 'hi');
    outbox.reloadForTesting();
    const fresh = { outbox, checkDeadlines };
    const resent: Record<string, unknown>[] = [];
    fresh.outbox.configure({
      send: async (msg) => { resent.push(msg); return true; },
      isDeliveryPathUp: () => true,
      acceptsResend: () => false,
    });
    fresh.checkDeadlines();
    expect(resent).toEqual([]);
    expect(fresh.outbox.forSession('s')[0].state).toBe('failed');
    fresh.outbox.reset();
  });

  it('a Tentacle re-greeting re-offers unconfirmed inputs (same clientId)', () => {
    let accepts = true;
    outbox.configure({
      send: async (msg) => { sent.push(msg); return true; },
      isDeliveryPathUp: () => pathUp,
      acceptsResend: () => accepts,
    });
    const id = outbox.send('s', 'hi');
    outbox.send('other', 'x');
    sent = [];
    outbox.resendUnconfirmed((sid) => sid === 's');
    expect(sent.map((m) => (m.payload as Record<string, unknown>).clientId)).toEqual([id]);
    accepts = false;
    outbox.resendUnconfirmed((sid) => sid === 's');
    expect(outbox.forSession('s')[0].state).toBe('failed');
  });

  it('discard returns the text', () => {
    const id = outbox.send('s', 'hi');
    expect(outbox.discard(id)).toBe('hi');
    expect(outbox.forSession('s')).toEqual([]);
  });
});

describe('outbox and sign-out', () => {
  it('store reset (sign-out) forgets unsent messages', async () => {
    const { useStore } = await import('../../hooks/useStore');
    outbox.configure({ send: async () => true, isDeliveryPathUp: () => true });
    outbox.send('s', 'secret');
    useStore.getState().reset();
    expect(useOutbox.getState().entries).toEqual([]);
    expect(localStorage.getItem('kraki-outbox-v1')).toBeNull();
  });
});
