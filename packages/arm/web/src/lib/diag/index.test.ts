import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagRecorder } from './recorder';

const { recorders, power } = vi.hoisted(() => ({ recorders: [] as DiagRecorder[], power: { handler: null as ((event: 'suspend' | 'resume') => void) | null } }));
vi.mock('../desktop', () => ({ desktop: { onPower: (handler: (event: 'suspend' | 'resume') => void) => { power.handler = handler; return () => {}; } } }));
vi.mock('./client', async (importOriginal) => ({
  ...await importOriginal<typeof import('./client')>(),
  DiagClient: class {
    enabled = true;
    constructor(private options: { recorder: DiagRecorder }) { recorders.push(options.recorder); }
    start() {}
    async flush() {}
    async configure() { this.options.recorder.setEnabled(this.enabled); }
    logout() { this.options.recorder.setEnabled(false); this.options.recorder.drain(); }
    setForeground() {}
    userActivity() {}
    async setEnabled(value: boolean) { this.options.recorder.setEnabled(value); this.enabled = value; }
  },
}));
import { Diag } from './index';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  vi.spyOn(document, 'addEventListener').mockImplementation(() => {});
  recorders.length = 0;
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function harness() {
  const d = new Diag();
  d.start(async () => ({ status: 204, body: '' }), { version: '1', build: '0' });
  const recorder = recorders[0];
  recorder.drain();
  return { d, recorder };
}

describe('Diag experience summary wiring', () => {
  it('maps voice and reply summaries to exactly the collector vocabulary, without content or ids', () => {
    const { d, recorder } = harness();
    let now = 0;
    d.voices.now = d.replies.now = () => now;
    d.voices.begin(false, false); now = 10; d.voices.stateChanged('recording');
    now = 2010; d.voices.stateChanged('finishing'); now = 2310;
    d.voices.finalReceived(15, false); d.voices.stateChanged('idle');
    d.replies.started('private-session', 'answer'); now = 2400; d.replies.delta('private-session', false);
    now = 2500; d.replies.finish('private-session', 'completed');
    expect(recorder.drain().events.map(({ ev, sid, d }) => ({ ev, sid, d }))).toEqual([
      { ev: 'voice.summary', sid: undefined, d: { outcome: 'final', stage: 'finishing', confirmed: false,
        correctionOn: false, textLength: 15, warm: false, count: 0, startMs: 10, recordMs: 2000, finalizeMs: 300 } },
      { ev: 'reply.summary', sid: undefined, d: { kind: 'answer', outcome: 'completed', durationMs: 190,
        firstActivityMs: 90, firstTextMs: 90, deltas: 1, maxGapMs: 0, stalls: 0 } },
    ]);
  });
  it('maps open.summary with the reconnecting flag, like native AppState', () => {
    const { d, recorder } = harness();
    let now = 0;
    d.stability.now = () => now;
    d.stability.conversationOpened('private-session', 4, 2, false); // the cold app opening is in progress
    now = 120; d.stability.conversationRendered('private-session', 4, 4, true);
    expect(recorder.drain().events.filter((e) => e.ev === 'open.summary').map(({ sid, d }) => ({ sid, d }))).toEqual([
      { sid: undefined, d: { outcome: 'current', gap: 2, firstContentMs: 120, viewCurrentMs: 120, reconnecting: true } },
    ]);
  });
  it('desktop sleep finishes records and goes background; resume while visible is a wake opening (Mac willSleep)', () => {
    const { d, recorder } = harness();
    let now = 0;
    d.stability.now = () => now;
    d.stability.authenticated(); d.stability.sessionListApplied(null); recorder.drain();
    now = 1000; power.handler!('suspend');
    now = 61_000; power.handler!('resume');
    d.stability.authenticated(); d.stability.sessionListApplied(null);
    expect(recorder.drain().events.map(({ ev, d }) => ev === 'app.phase' ? d.phase : ev === 'ready.summary' ? `${d.kind}:${d.backgroundMs}` : ev))
      .toEqual(['background', 'active', 'wake:60000']);
  });
  it('keeps events recorded before start (the outbox restores at module load) and records them at start', () => {
    const d = new Diag();
    d.record('outbox.state', 'private-session', { clientId: 'c1', phase: 'restored' });
    d.start(async () => ({ status: 204, body: '' }), { version: '1', build: '0' });
    d.record('outbox.state', 'private-session', { clientId: 'c1', phase: 'sending' });
    expect(recorders[0]!.drain().events.filter((e) => e.ev === 'outbox.state').map(({ sid, d }) => ({ sid, d }))).toEqual([
      { sid: 'private-session', d: { clientId: 'c1', phase: 'restored' } },
      { sid: 'private-session', d: { clientId: 'c1', phase: 'sending' } },
    ]);
  });
  it('wires longtask completion into ui.busy and suppresses background observations', () => {
    let observed!: PerformanceObserverCallback;
    vi.stubGlobal('PerformanceObserver', class {
      static supportedEntryTypes = ['longtask'];
      constructor(callback: PerformanceObserverCallback) { observed = callback; }
      observe() {}
    });
    const { d, recorder } = harness();
    const feed = () => observed({ getEntries: () => [{ startTime: performance.now() + 1, duration: 60 }] } as PerformanceObserverEntryList, {} as PerformanceObserver);
    feed(); d.phase('background'); feed();
    expect(recorder.drain().events.filter((e) => e.ev === 'ui.busy').map((e) => e.d)).toEqual([{ durationMs: 60 }]);
  });
  it('closes open replies when backgrounded or inactive, not when active', () => {
    const { d, recorder } = harness();
    d.replies.started('s', 'typed'); d.phase('active'); expect(d.replies.inFlight).toBe(1);
    d.phase('background'); d.replies.started('s', 'answer'); d.phase('inactive');
    expect(recorder.drain().events.filter((e) => e.ev === 'reply.summary').map((e) => e.d.outcome)).toEqual(['backgrounded', 'backgrounded']);
  });
  it('browser calls execute the body but never start timing or answer bookkeeping', () => {
    const d = new Diag();
    const now = vi.spyOn(performance, 'now');
    expect(d.work('web/session_list', undefined, () => 42)).toBe(42);
    d.answer('s', 'q', 10, 0, 'web/outbox');
    expect(now).not.toHaveBeenCalled();
  });
  it('work.slow includes the 8 ms boundary, preserves return/errors and does nothing when disabled', async () => {
    const { d, recorder } = harness();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    expect(d.work('web/session_list', undefined, () => { now += 7; return 42; })).toBe(42);
    d.work('web/message_batch', 's', () => { now += 8; });
    expect(() => d.work('web/session_list', undefined, () => { now += 10; throw new Error('private message'); })).toThrow('private message');
    expect(recorder.drain().events.map(({ ev, sid, d }) => ({ ev, sid, d }))).toEqual([
      { ev: 'work.slow', sid: 's', d: { source: 'web/message_batch', durationMs: 8 } },
      { ev: 'work.slow', sid: undefined, d: { source: 'web/session_list', durationMs: 10 } },
    ]);
    await d.setEnabled(false);
    d.work('web/session_list', undefined, () => { now += 50; });
    d.answer('s', 'q', 10, 0, 'web/outbox');
    expect(recorder.drain().events).toEqual([]);
  });
  it('cmd.answer detects repeated calls per session/question without rejecting them', () => {
    const { d, recorder } = harness();
    d.answer('s', 'q', 10, 0, 'web/outbox');
    d.answer('s', 'q', 20, 1, 'web/voice');
    d.answer('other', 'q', 30, 0, 'web/outbox');
    expect(recorder.drain().events.map(({ ev, sid, d }) => ({ ev, sid, d }))).toEqual([
      { ev: 'cmd.answer', sid: 's', d: { questionId: 'q', textLength: 10, pending: 0, duplicate: false, source: 'web/outbox' } },
      { ev: 'cmd.answer', sid: 's', d: { questionId: 'q', textLength: 20, pending: 1, duplicate: true, source: 'web/voice' } },
      { ev: 'cmd.answer', sid: 'other', d: { questionId: 'q', textLength: 30, pending: 0, duplicate: false, source: 'web/outbox' } },
    ]);
  });
  it('cmd.answer history is bounded and drops stale entries at capacity, like native', () => {
    const { d, recorder } = harness();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    for (let i = 0; i < 1024; i++) { d.answer('s', `q${i}`, 0, 0, 'web/outbox'); now += 1000; recorder.drain(); }
    d.answer('s', 'extra', 0, 0, 'web/outbox');
    d.answer('s', 'q0', 0, 0, 'web/outbox');
    expect(recorder.drain().events.at(-1)?.d.duplicate).toBe(false);
  });
});

describe('diagnostic identity isolation', () => {
  const sign = async () => 'signature';
  const accountA = (d: Diag) => d.configure('wss://a.example/ws', 'device-a', sign);
  const accountB = (d: Diag) => d.configure('wss://a.example/ws', 'device-b', sign);

  it('logout discards A\'s pending reply before configuring B and backgrounding', () => {
    const { d, recorder } = harness();
    accountA(d);
    d.replies.started('session-a', 'typed');
    d.phase('logout');
    expect(d.replies.inFlight).toBe(0);
    accountB(d);
    d.phase('background');
    expect(recorder.drain().events.filter((e) => e.ev === 'reply.summary')).toEqual([]);
    expect(d.replies.inFlight).toBe(0);
    d.replies.started('session-b', 'answer');
    d.replies.finish('session-b', 'completed');
    expect(recorder.drain().events.filter((e) => e.ev === 'reply.summary').map((e) => e.d.kind)).toEqual(['answer']);
  });

  it.each(['logout', 'device', 'relay'] as const)('%s discards pending send, voice, reply, open and answer-duplicate state without summaries', (transition) => {
    const { d, recorder } = harness();
    accountA(d);
    d.stability.authenticated(); d.stability.sessionListApplied(null);
    d.stability.conversationOpened('session-a', 5, 0, true);
    d.sends.created('send-a', 'typed', 10, 0, true);
    d.voices.begin(false); d.voices.stateChanged('recording');
    d.replies.started('session-a', 'typed');
    d.answer('session-a', 'question', 10, 0, 'web/outbox');
    recorder.drain();

    if (transition === 'logout') { d.phase('logout'); accountA(d); }
    else if (transition === 'device') accountB(d);
    else d.configure('wss://b.example/ws', 'device-a', sign);

    expect(d.sends.inFlight).toBe(0);
    expect(d.replies.inFlight).toBe(0);
    expect(d.stability.wantsConversationUpdates).toBe(false);
    d.sends.finished('send-a', 'delivered');
    d.voices.finalReceived(10, true); d.voices.stateChanged('idle');
    d.replies.finish('session-a', 'completed');
    d.stability.conversationRendered('session-a', 5, 5, true);
    d.phase('background');
    expect(recorder.drain().events.filter((e) => e.ev.endsWith('.summary'))).toEqual([]);
    d.answer('session-a', 'question', 10, 0, 'web/outbox');
    expect(recorder.drain().events.find((e) => e.ev === 'cmd.answer')?.d.duplicate).toBe(false);

    d.sends.created('send-b', 'typed', 10, 0, true); d.sends.finished('send-b', 'delivered');
    d.voices.begin(false); d.voices.finalReceived(10, false); d.voices.stateChanged('idle');
    expect(recorder.drain().events.map((e) => e.ev)).toEqual(['send.summary', 'voice.summary']);
  });

  it.each(['ready', 'open', 'outage'] as const)('realm change discards pending %s summaries and their scheduled callbacks', (kind) => {
    const { d, recorder } = harness();
    accountA(d);
    if (kind !== 'ready') {
      d.stability.authenticated(); d.stability.sessionListApplied(null);
      if (kind === 'open') d.stability.conversationOpened('session-a', 5, 0, true);
      else d.stability.transportLost('peer_closed', 1006, 100);
    }
    recorder.drain();
    accountB(d);
    // No authentication for B yet: A's everAuthenticated flag must not survive.
    d.stability.transportLost('peer_closed', 1006, 100);
    vi.advanceTimersByTime(600_000);
    d.stability.appHidden();
    expect(d.stability.wantsConversationUpdates).toBe(false);
    expect(recorder.drain().events.filter((e) => e.ev.endsWith('.summary'))).toEqual([]);
  });

  it('old readiness timeout cannot finish B\'s new opening; process launch metadata and callbacks survive', () => {
    const { d, recorder } = harness();
    d.stability.previousExit = () => 'clean';
    accountA(d);
    vi.advanceTimersByTime(5000);
    accountB(d);
    d.stability.appVisible(false, false);
    recorder.drain();
    vi.advanceTimersByTime(25_000);
    expect(recorder.drain().events.filter((e) => e.ev === 'ready.summary')).toEqual([]);
    expect(d.stability.wantsConversationUpdates).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(recorder.drain().events.filter((e) => e.ev === 'ready.summary').map((e) => e.d)).toEqual([
      expect.objectContaining({ kind: 'cold', outcome: 'timeout', previousExit: 'clean' }),
    ]);
  });

  it('realm change immediately drains already-recorded A events and ignores A long tasks delivered later', () => {
    let observed!: PerformanceObserverCallback;
    vi.stubGlobal('PerformanceObserver', class {
      static supportedEntryTypes = ['longtask'];
      constructor(callback: PerformanceObserverCallback) { observed = callback; }
      observe() {}
    });
    const { d, recorder } = harness();
    accountA(d);
    d.answer('session-a', 'question', 10, 0, 'web/outbox');
    vi.advanceTimersByTime(100);
    accountB(d);
    observed({ getEntries: () => [{ startTime: 0, duration: 60 }] } as PerformanceObserverEntryList, {} as PerformanceObserver);
    expect(recorder.drain().events.map((e) => e.ev)).toEqual(['app.phase']);
  });

  it('first authentication and reconnects to the same normalized realm preserve pending state', () => {
    const { d, recorder } = harness();
    accountA(d);
    expect(d.stability.wantsConversationUpdates).toBe(true);
    d.replies.started('session-a', 'typed');
    d.answer('session-a', 'question', 10, 0, 'web/outbox');
    recorder.drain();
    d.configure('wss://a.example/other?route=1', 'device-a', sign);
    d.configure('not a relay', 'device-b', sign);
    expect(d.replies.inFlight).toBe(1);
    d.answer('session-a', 'question', 10, 0, 'web/outbox');
    d.phase('background');
    const events = recorder.drain().events;
    expect(events.find((e) => e.ev === 'cmd.answer')?.d.duplicate).toBe(true);
    expect(events.find((e) => e.ev === 'reply.summary')?.d.outcome).toBe('backgrounded');
  });
});
