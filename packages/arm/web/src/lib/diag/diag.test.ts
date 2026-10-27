import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { DiagRecorder } from './recorder';
import { DiagClient, diagBase, type DiagHttpRequest } from './client';
import { MemorySpoolStore } from './spool';
import { SendTracker, StabilityTracker, sendFalseAlarm } from './stability';

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
}

function harness(responses: Partial<Record<'config' | 'batch', { status: number; body?: string }>> = {}) {
  let t = 1_760_000_000_000;
  const calls: DiagHttpRequest[] = [];
  const signed: string[] = [];
  const recorder = new DiagRecorder(1024, 200, () => t);
  const store = new MemorySpoolStore();
  const storage = memoryStorage();
  const client = new DiagClient({
    recorder, store, storage, platform: 'windows', version: '0.1.7', build: '0', now: () => t, random: () => 0,
    http: async (req) => {
      calls.push(req);
      const r = responses[req.path] ?? (req.path === 'config' ? { status: 200, body: '{"schema":1,"enabled":true}' } : { status: 204 });
      return { status: r.status, body: r.body ?? '' };
    },
  });
  const advance = (ms: number) => { t += ms; };
  return { client, recorder, store, storage, calls, signed, advance, configure: () => client.configure('wss://relay.kraki.chat', 'dev_abc', async (m) => { signed.push(m); return 'c2ln'; }) };
}

describe('DiagRecorder (native bounds)', () => {
  it('caps the pending queue and the per-second admission, counting drops', () => {
    let now = 0;
    const r = new DiagRecorder(3, 2, () => now);
    expect([1, 2, 3].map(() => r.record('app.launch', undefined))).toEqual([true, true, false]);
    now = 1000;
    expect(r.record('app.launch', undefined)).toBe(true);
    expect(r.record('app.launch', undefined)).toBe(false); // capacity 3
    const { events, dropped } = r.drain();
    expect(events.map((e) => e.seq)).toEqual([1, 2, 4]);
    expect(dropped).toBe(2);
  });
  it('clamps values like DiagValue: negative/non-finite numbers → 0, long tags cut to 512', () => {
    const r = new DiagRecorder();
    r.record('ws.state', undefined, { attempt: -3, count: Number.NaN, source: 'x'.repeat(600), state: undefined });
    const d = r.drain().events[0]!.d;
    expect(d).toEqual({ attempt: 0, count: 0, source: 'x'.repeat(512) });
  });
});

describe('DiagClient (native DiagClient protocol)', () => {
  it('maps the relay to its https origin, loopback ws only', () => {
    expect(diagBase('wss://relay.kraki.chat/ws?x=1')).toBe('https://relay.kraki.chat');
    expect(diagBase('ws://localhost:4000')).toBe('http://localhost:4000');
    expect(diagBase('ws://relay.example')).toBeNull();
    expect(diagBase('wss://u:p@relay.example')).toBeNull();
  });

  it('asks config first, then uploads a signed gzip batch in the native format', async () => {
    const h = harness();
    h.recorder.record('app.launch', undefined);
    await h.configure();
    await h.client.tick(); // flush only: config not due yet
    expect(h.calls).toEqual([]);
    h.advance(5_000); await h.client.tick();
    expect(h.calls.map((c) => c.path)).toEqual(['config']);
    h.advance(15_000); await h.client.tick();
    const batch = h.calls[1]!;
    expect(batch.path).toBe('batch');
    expect(batch.base).toBe('https://relay.kraki.chat');
    expect(batch.headers).toMatchObject({ 'X-Kraki-Device': 'dev_abc', 'Content-Encoding': 'gzip', 'Content-Type': 'application/json', 'X-Kraki-Signature': 'c2ln' });
    const json = JSON.parse(gunzipSync(Buffer.from(batch.body!)).toString());
    expect(json).toMatchObject({ schema: 1, platform: 'windows', version: '0.1.7', build: '0' });
    expect(json.events.map((e: { ev: string }) => e.ev)).toEqual(['app.launch']);
    // Signing text: kraki-diag-v1 \n POST \n path \n device \n time \n requestId \n sha256(body)
    const lines = h.signed[1]!.split('\n');
    expect(lines.slice(0, 4)).toEqual(['kraki-diag-v1', 'POST', '/api/diag/v1/batch', 'dev_abc']);
    expect(lines[5]).toBe(batch.headers['X-Kraki-Request']);
    expect(lines[5]).toBe(json.batchId);
    expect(h.store.rows.size).toBe(0); // 204 removes it
  });

  it('fails closed: no upload until the collector opts in; 410 stops and clears', async () => {
    const off = harness({ config: { status: 200, body: '{"schema":1,"enabled":false}' } });
    await off.configure(); off.recorder.record('app.launch', undefined);
    off.advance(5_000); await off.client.tick(); off.advance(30_000); await off.client.tick();
    expect(off.calls.map((c) => c.path)).toEqual(['config']);
    expect(off.recorder.isEnabled).toBe(false);

    const gone = harness({ batch: { status: 410 } });
    await gone.configure(); gone.recorder.record('app.launch', undefined);
    gone.advance(5_000); await gone.client.tick(); gone.advance(15_000); await gone.client.tick();
    expect(gone.calls.map((c) => c.path)).toEqual(['config', 'batch']);
    expect(gone.store.rows.size).toBe(0);
    expect(gone.recorder.isEnabled).toBe(false);
  });

  it('overlapping ticks send one request at a time and count the daily bytes once (native single task)', async () => {
    const h = harness();
    await h.configure(); h.recorder.record('app.launch', undefined);
    h.advance(5_000); await Promise.all([h.client.tick(), h.client.tick()]);
    expect(h.calls.map((c) => c.path)).toEqual(['config']);
    h.advance(15_000); await Promise.all([h.client.tick(), h.client.tick(), h.client.tick()]);
    expect(h.calls.map((c) => c.path)).toEqual(['config', 'batch']);
    expect(Number(h.storage.m.get('kraki.diag.bytes'))).toBe(h.calls[1]!.body!.byteLength);
  });

  it('a transient failure keeps the identical batch for a backed-off retry', async () => {
    const h = harness({ batch: { status: 503 } });
    await h.configure(); h.recorder.record('app.launch', undefined);
    h.advance(5_000); await h.client.tick(); h.advance(15_000); await h.client.tick();
    expect(h.store.rows.size).toBe(1);
    const first = h.calls[1]!.headers['X-Kraki-Request'];
    h.advance(60_000); await h.client.tick();
    expect(h.calls.length).toBe(2); // 120 s backoff after one failure
    h.advance(61_000); await h.client.tick();
    expect(h.calls[2]!.headers['X-Kraki-Request']).toBe(first);
  });

  it('turning it off deletes unsent data and records nothing more; persists', async () => {
    const h = harness();
    await h.configure(); h.recorder.record('app.launch', undefined); await h.client.flush();
    expect(h.store.rows.size).toBe(1);
    await h.client.setEnabled(false);
    expect(h.store.rows.size).toBe(0);
    expect(h.recorder.record('app.launch', undefined)).toBe(false);
    expect(h.storage.m.get('kraki.diag.enabled')).toBe('false');
  });

  it('another relay/device never uploads the previous one\'s spool', async () => {
    const h = harness();
    await h.configure(); h.recorder.record('app.launch', undefined); await h.client.flush();
    expect(h.store.rows.size).toBe(1);
    await h.client.configure('wss://other.example', 'dev_other', async () => 'x');
    expect(h.store.rows.size).toBe(0);
  });
});

describe('StabilityTracker (port)', () => {
  function tracker() {
    let now = 0;
    const t = new StabilityTracker();
    const timers: Array<[number, () => void]> = [];
    t.now = () => now;
    t.schedule = (ms, w) => { timers.push([now + ms, w]); };
    const out: unknown[] = [];
    t.onReady = (r) => out.push({ ready: r });
    t.onOutage = (o) => out.push({ outage: o });
    t.onOpen = (o) => out.push({ open: o });
    return { t, out, go: (ms: number) => { now += ms; for (const [at, w] of timers.splice(0)) if (at <= now) w(); else timers.push([at, w]); } };
  }
  it('cold opening: milestones until the viewed conversation is current', () => {
    const { t, out, go } = tracker();
    t.appVisible(false, true);
    t.connecting(); go(100); t.socketOpen(); go(50); t.authenticated(); go(100);
    t.sessionListApplied({ sessionId: 's', lastSeq: 10, localSeq: 7 });
    go(200); t.conversationRendered('s', 10, 10, true);
    expect(out).toEqual([{ ready: expect.objectContaining({ kind: 'cold', outcome: 'ready', wsOpenMs: 100, authedMs: 150, listFreshMs: 250, viewCurrentMs: 450, gap: 3, attempts: 0, viewing: true }) }]);
  });
  it('outage: detection from last data, reconnect and catch-up; another drop before catch-up is the same outage', () => {
    const { t, out, go } = tracker();
    t.appVisible(true, false); t.authenticated(); t.sessionListApplied(null); out.length = 0;
    go(1000); t.transportLost('peer_closed', 1006, 400);
    t.connecting(); go(300); t.authenticated();
    t.transportLost('transport_silent', undefined, 0); // dropped again before catching up
    t.connecting(); go(200); t.authenticated(); t.sessionListApplied(null);
    expect(out).toEqual([{ outage: expect.objectContaining({ reason: 'peer_closed', code: 1006, detectMs: 400, outcome: 'recovered', attempts: 2, reconnectMs: 500, impactMs: 900 }) }]);
  });
  it('an opening during an outage or app opening is recorded with reconnecting, without cancelling that record (native)', () => {
    const { t, out, go } = tracker();
    t.appVisible(true, false); t.authenticated(); t.sessionListApplied(null); out.length = 0;
    t.conversationOpened('s', 3, 3, true); t.conversationRendered('s', 3, 3, true);
    go(1000); t.transportLost('peer_closed', 1006, 0);
    t.conversationOpened('s', 5, 3, false);
    t.connecting(); go(300); t.authenticated(); t.sessionListApplied({ sessionId: 's', lastSeq: 5, localSeq: 3 });
    go(200); t.conversationRendered('s', 5, 5, true);
    expect(out).toEqual([
      { open: expect.objectContaining({ outcome: 'current', reconnecting: false }) },
      { open: expect.objectContaining({ outcome: 'current', reconnecting: true, gap: 2, currentMs: 500 }) },
      { outage: expect.objectContaining({ outcome: 'recovered', reconnectMs: 300 }) },
    ]);
    out.length = 0;
    t.appHidden(); go(1000); t.appVisible(true, true); // warm opening in progress
    t.conversationOpened('s', 5, 5, false);
    go(StabilityTracker.readyTimeout);
    expect(out).toEqual([
      { ready: expect.objectContaining({ kind: 'warm', outcome: 'timeout' }) },
      { open: expect.objectContaining({ outcome: 'timeout', reconnecting: true }) },
    ]);
  });
  it('sleep: the next visibility is a wake opening, even when the window was also hidden; later outages count from the wake', () => {
    const { t, out, go } = tracker();
    t.appVisible(true, false); t.authenticated(); t.sessionListApplied(null); out.length = 0;
    t.systemWillSleep(); t.appHidden(); go(60_000);
    t.appVisible(true, false); t.authenticated(); t.sessionListApplied(null);
    go(1000); t.transportLost('peer_closed', 1006, 120_000);
    t.connecting(); go(100); t.authenticated(); t.sessionListApplied(null);
    expect(out).toEqual([
      { ready: expect.objectContaining({ kind: 'wake', backgroundMs: 60_000, outcome: 'ready' }) },
      { outage: expect.objectContaining({ afterWake: true, detectMs: 1000, outcome: 'recovered' }) },
    ]);
  });
  it('offline with no reconnect running, an opening is not recorded', () => {
    const { t, out, go } = tracker();
    t.appVisible(true, false); t.authenticated(); t.sessionListApplied(null); out.length = 0;
    t.conversationOpened('s', 5, 3, false);
    go(StabilityTracker.readyTimeout);
    expect(out).toEqual([]);
  });
});

describe('SendTracker (port)', () => {
  it('a delivered input that was shown unconfirmed is a false alarm, with shown time', () => {
    let now = 0;
    const s = new SendTracker();
    s.now = () => now;
    const got: unknown[] = [];
    s.onSummary = (x) => got.push(x);
    s.created('c', 'typed', 5, 0, true);
    now = 20_000; s.state('c', 'unconfirmed', 'stalled');
    now = 23_000; s.retried('c', false); s.finished('c', 'delivered');
    const summary = got[0] as Parameters<typeof sendFalseAlarm>[0];
    expect(summary).toMatchObject({ kind: 'typed', shown: 'unconfirmed', shownMs: 3000, confirmMs: 23_000, autoResends: 1, cause: 'stalled' });
    expect(sendFalseAlarm(summary)).toBe(true);
  });
});
