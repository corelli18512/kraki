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
  /** Tick once a second from `from` for `seconds`; returns the last time. */
  const run = (from: number, seconds: number) => {
    for (let i = 1; i <= seconds; i++) checkDeadlines(from + i * 1_000);
    return from + seconds * 1_000;
  };

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

  it('becomes unconfirmed only after the full window of stalled time; retry keeps the clientId', () => {
    const id = outbox.send('s', 'hi');
    let t = Date.now();
    pathUp = false;
    t = run(t, 60);
    expect(outbox.forSession('s')[0].state).toBe('sending');
    pathUp = true;
    t = run(t, 19);
    expect(outbox.forSession('s')[0].state).toBe('sending');
    t = run(t, 2);
    expect(outbox.forSession('s')[0].state).toBe('unconfirmed');
    outbox.retry(id);
    expect(outbox.forSession('s')[0].state).toBe('sending');
    expect(payload().clientId).toBe(id);
  });

  it('a transient send refusal keeps a typed input queued and dispatches it once, same clientId (Mac parity)', async () => {
    transportOk = false; // e.g. the Tentacle's key is not known yet
    const id = outbox.send('s', 'hi');
    await Promise.resolve();
    await Promise.resolve();
    expect(outbox.forSession('s')[0]).toMatchObject({ state: 'sending', needsDispatch: true });
    // Key arrives: the next tick dispatches it, with the same clientId.
    transportOk = true;
    sent = [];
    checkDeadlines(Date.now() + 1_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(payload()).toEqual({ text: 'hi', clientId: id });
    expect(outbox.forSession('s')[0].needsDispatch).toBeUndefined();
    checkDeadlines(Date.now() + 2_000);
    expect(sent).toHaveLength(1);
  });

  it('a normal prompt waiting behind a running turn does not accrue unconfirmed time; a steer does', () => {
    let running = true;
    outbox.configure({
      send: async (msg) => { sent.push(msg); return true; },
      isDeliveryPathUp: () => true,
      isTurnRunning: () => running,
    });
    outbox.send('s', 'queued prompt');
    outbox.send('s', 'steer now', { delivery: 'steer' });
    const t = run(Date.now(), 25);
    const [prompt, steer] = outbox.forSession('s');
    expect(prompt.state).toBe('sending');
    expect(steer.state).toBe('unconfirmed');
    // The turn ends; the prompt dispatches but its echo never comes: now it counts.
    running = false;
    run(t, 25);
    expect(outbox.forSession('s')[0].state).toBe('unconfirmed');
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
    pathUp = false; // e.g. half-open: quiet socket, or reconnecting
    run(Date.now(), 600);
    expect(outbox.forSession('s')[0].state).toBe('sending');
  });

  it('down time is not counted even when the link is up at the old deadline (soak seed 1300)', () => {
    // Sent into a blackhole: 26 s dead, then reconnected and catching up.
    outbox.setConfirmationTimeout(30_000);
    outbox.send('s', 'hi');
    let t = Date.now();
    pathUp = false;
    t = run(t, 26);
    pathUp = true;
    t = run(t, 6); // 32 s after sending, but only 6 s stalled
    expect(outbox.forSession('s')[0].state).toBe('sending');
    t = run(t, 25);
    expect(outbox.forSession('s')[0].state).toBe('unconfirmed');
  });

  it('a busy link pauses the confirmation clock but never delays a resend', () => {
    outbox.setConfirmationTimeout(30_000);
    let busy = true;
    const resent: Record<string, unknown>[] = [];
    outbox.configure({
      send: async (msg) => { resent.push(msg); return true; },
      isDeliveryPathUp: () => true,
      isLinkBusy: () => busy,
      acceptsResend: () => true,
    });
    outbox.send('s', 'hi');
    let t = run(Date.now(), 120);
    expect(outbox.forSession('s')[0].state).toBe('sending'); // busy: not stalled
    // A restored / re-offered input goes out at once even while busy.
    outbox.resendUnconfirmed(() => true);
    expect(resent.length).toBe(2);
    busy = false;
    t = run(t, 31);
    expect(outbox.forSession('s')[0].state).toBe('unconfirmed');
  });

  it('a throttled background tick counts at most 2 s', () => {
    outbox.setConfirmationTimeout(30_000);
    outbox.send('s', 'hi');
    let t = Date.now();
    for (let i = 0; i < 10; i++) { t += 60_000; checkDeadlines(t); }
    expect(outbox.forSession('s')[0].state).toBe('sending');
  });

  it('halfway through, a deduplicating Tentacle gets the input once more (same clientId)', () => {
    outbox.setConfirmationTimeout(30_000);
    outbox.configure({
      send: async (msg) => { sent.push(msg); return true; },
      isDeliveryPathUp: () => true,
      acceptsResend: () => true,
    });
    const id = outbox.send('s', 'hi');
    let t = Date.now();
    t = run(t, 14);
    expect(sent).toHaveLength(1);
    t = run(t, 2);
    expect(sent.map((m) => (m.payload as Record<string, unknown>).clientId)).toEqual([id, id]);
    t = run(t, 10);
    expect(sent).toHaveLength(2);
    expect(outbox.forSession('s')[0].state).toBe('sending');
  });

  it('an older Tentacle never gets an automatic resend', () => {
    outbox.setConfirmationTimeout(30_000);
    outbox.configure({
      send: async (msg) => { sent.push(msg); return true; },
      isDeliveryPathUp: () => true,
      acceptsResend: () => false,
    });
    outbox.send('s', 'hi');
    run(Date.now(), 31);
    expect(sent).toHaveLength(1);
    expect(outbox.forSession('s')[0].state).toBe('unconfirmed');
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
    run(Date.now(), 22);
    expect(fresh.outbox.forSession('s')[0].state).toBe('unconfirmed');
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
    // An older Tentacle re-greeting (e.g. on our reconnect) must not fail
    // inputs that are simply still in flight, nor resend them.
    accepts = false;
    sent = [];
    outbox.resendUnconfirmed((sid) => sid === 's');
    expect(sent).toEqual([]);
    expect(outbox.forSession('s')[0].state).toBe('sending');
  });

  it('a late echo clears an unconfirmed input instead of leaving a failed preview', () => {
    const id = outbox.send('s', 'hi');
    run(Date.now(), 22);
    expect(outbox.forSession('s')[0].state).toBe('unconfirmed');
    expect(outbox.confirm('s', id, 'hi')).toBe(true);
    expect(outbox.forSession('s')).toEqual([]);
  });

  it('unconfirmed inputs re-greet and reload with the same id, never create a duplicate', () => {
    outbox.configure({ send: async (m) => { sent.push(m); return true; }, isDeliveryPathUp: () => true, acceptsResend: () => true });
    const id = outbox.send('s', 'hi');
    let t = run(Date.now(), 22);
    expect(outbox.forSession('s')[0].state).toBe('unconfirmed');
    outbox.resendUnconfirmed(() => true);
    expect(outbox.forSession('s')[0].state).toBe('sending');
    t = run(t, 22);
    expect(outbox.forSession('s')[0].state).toBe('unconfirmed');
    outbox.reloadForTesting();
    checkDeadlines();
    expect(outbox.forSession('s')[0]).toMatchObject({ clientId: id, state: 'sending' });
    expect(new Set(sent.map((m) => (m.payload as { clientId: string }).clientId))).toEqual(new Set([id]));
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
