import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagRecorder } from './recorder';

const { recorders } = vi.hoisted(() => ({ recorders: [] as DiagRecorder[] }));
vi.mock('./client', () => ({
  DiagClient: class {
    enabled = true;
    constructor(private options: { recorder: DiagRecorder }) { recorders.push(options.recorder); }
    start() {}
    async flush() {}
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
