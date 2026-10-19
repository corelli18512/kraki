import { describe, expect, it } from 'vitest';
import { ReplyTracker, VoiceTracker, type ReplySummary, type VoiceSummary } from './experience';

// ExperienceTrackersTests.swift, using the same sequences with a millisecond clock.
function voice() {
  let now = 100_000;
  const t = new VoiceTracker(), out: VoiceSummary[] = [];
  t.now = () => now;
  t.onSummary = (s) => out.push(s);
  return { t, out, go: (ms: number) => { now += ms; } };
}
function reply() {
  let now = 1000_000;
  const t = new ReplyTracker(), out: ReplySummary[] = [];
  t.now = () => now;
  t.onSummary = (s) => out.push(s);
  return { t, out, go: (ms: number) => { now += ms; } };
}

describe('VoiceTracker (ExperienceTrackers.swift port)', () => {
  it('successful recording times each step', () => {
    const { t, out, go } = voice();
    t.begin(false); t.stateChanged('obtainingLease');
    go(700); t.stateChanged('recording'); go(6000); t.stateChanged('finishing');
    go(1200); t.finalReceived(40, true); t.stateChanged('idle');
    expect(out).toEqual([{ outcome: 'final', stage: 'finishing', startMs: 700, recordMs: 6000, finalizeMs: 1200,
      correctionConfirmed: true, correctionEnabled: true, textLength: 40, warm: false, leaseRollovers: 0 }]);
  });
  it('failure records stage and cause only once', () => {
    const { t, out, go } = voice();
    t.begin(true); t.stateChanged('recording'); go(3000);
    t.cause(VoiceTracker.classify('broker socket closed: network connection lost'));
    t.stateChanged('failed'); t.stateChanged('idle');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ outcome: 'failed', stage: 'recording', cause: 'network', recordMs: 3000 });
  });
  it('preflight failure and departure are distinguished, cancel preserves the known outcome', () => {
    const { t, out } = voice();
    t.begin(false); t.cause('permission'); t.stateChanged('failed');
    t.begin(true); t.stateChanged('obtainingLease'); t.outcome('departed'); t.outcome('cancelled', false); t.stateChanged('idle');
    expect(out.map((s) => [s.outcome, s.stage, s.cause])).toEqual([
      ['failed', 'preflight', 'permission'], ['departed', 'lease', undefined],
    ]);
  });
  it('correction turned off is not a correction failure', () => {
    const { t, out, go } = voice();
    t.begin(true, false); t.stateChanged('recording'); go(2000); t.stateChanged('finishing');
    go(300); t.finalReceived(10, false); t.stateChanged('idle');
    expect(out[0]).toMatchObject({ outcome: 'final', correctionEnabled: false, correctionConfirmed: false });
  });
  it.each(['cancelled', 'suspended', 'ended'] as const)('%s ends permission admission with no recording duration', (outcome) => {
    const { t, out } = voice();
    t.begin(false); t.stateChanged('requestingPermission'); t.outcome(outcome); t.stateChanged('idle');
    expect(out[0]).toMatchObject({ outcome, stage: 'permission' });
    expect(out[0].startMs).toBeUndefined();
    expect(out[0].recordMs).toBeUndefined();
    expect(out[0].finalizeMs).toBeUndefined();
  });
  it('rollovers retain the first recording start and count once per rollover', () => {
    const { t, out, go } = voice();
    t.rollover(); t.finalReceived(10, true); t.cause('ignored'); t.stateChanged('failed');
    t.begin(false); go(100); t.stateChanged('recording'); go(500); t.rollover();
    t.stateChanged('obtainingLease'); go(200); t.stateChanged('recording'); go(300); t.stateChanged('finishing');
    go(50); t.cause('quota'); t.stateChanged('failed');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ startMs: 100, recordMs: 1000, finalizeMs: 50, leaseRollovers: 1, stage: 'finishing', cause: 'quota' });
  });
  it.each([
    ['permission denied', 'permission'], ['audio input unavailable', 'mic_unavailable'],
    ['audio capture stalled', 'capture_stalled'], ['audio input changed', 'capture_interrupted'],
    ['audio input format changed', 'capture_interrupted'], ['voice upload stalled', 'upload_stalled'],
    ['asr closed without final', 'asr_final_missing'], ['asr_closed_without_final', 'asr_final_missing'],
    ['quota_exhausted', 'quota'], ['lease_expired', 'lease_rejected'], ['authorization denied', 'lease_rejected'],
    ['signature invalid', 'lease_rejected'], ['wrong_day', 'lease_rejected'], ['The request timed out.', 'timeout'],
    ['timeout', 'timeout'], ['broker socket closed: network connection lost', 'network'], ['WS closed', 'network'],
    ['something odd with private transcript', 'gateway'],
  ])('cause class never carries reason text: %s → %s', (reason, cause) => {
    expect(VoiceTracker.classify(reason.toUpperCase())).toBe(cause);
  });
});

describe('ReplyTracker (ExperienceTrackers.swift port)', () => {
  it('first activity, first text and stalls', () => {
    const { t, out, go } = reply();
    t.started('s', 'typed'); go(1200); t.activity('s'); go(800); t.delta('s', true);
    go(100); t.delta('s', false); go(3500); t.delta('s', false); go(200); t.delta('s', false);
    go(300); t.message('s'); go(500); t.finish('s', 'completed');
    expect(out).toEqual([{ kind: 'typed', outcome: 'completed', firstActivityMs: 1200, firstTextMs: 2000,
      deltas: 4, maxGapMs: 3500, stalls: 1, durationMs: 6600 }]);
    expect(t.inFlight).toBe(0);
  });
  it('tool step between text runs is not a stall', () => {
    const { t, out, go } = reply();
    t.started('s', 'answer'); t.delta('s', true); t.activity('s'); go(40_000); t.delta('s', false); t.finish('s', 'completed');
    expect(out[0]).toMatchObject({ kind: 'answer', stalls: 0, maxGapMs: 0, firstTextMs: 0 });
  });
  it('new turn supersedes and background closes all', () => {
    const { t, out, go } = reply();
    t.started('a', 'typed'); go(1000); t.started('a', 'typed'); t.started('b', 'typed'); t.backgrounded();
    expect(out.map((s) => s.outcome)).toEqual(['superseded', 'backgrounded', 'backgrounded']);
    expect(out[0].firstActivityMs).toBeUndefined();
    expect(t.inFlight).toBe(0);
  });
  it('empty reset is not reply text', () => {
    const { t, out, go } = reply();
    t.started('s', 'typed'); go(1000); t.delta('s', true, true); t.finish('s', 'stopped');
    expect(out[0].firstTextMs).toBeUndefined();
    expect(out[0].firstActivityMs).toBeUndefined();
    expect(out[0].deltas).toBe(0);
  });
  it('turns without an end expire and are bounded', () => {
    const { t, out, go } = reply();
    t.started('old', 'typed'); go(ReplyTracker.maxAge); t.expire(); expect(out).toEqual([]);
    go(1); t.started('new', 'typed');
    expect(out.map((s) => s.outcome)).toEqual(['abandoned']);
    expect(t.inFlight).toBe(1);
    for (let i = 0; i < ReplyTracker.maxOpen + 5; i++) { t.started(`s${i}`, 'typed'); go(1000); }
    expect(t.inFlight).toBe(ReplyTracker.maxOpen);
    expect(t.openSessions).not.toContain('new');
    expect(out.every((s) => s.outcome === 'abandoned')).toBe(true);
  });
  it('a stale turn is abandoned, not superseded, when the same session starts again', () => {
    const { t, out, go } = reply();
    t.started('s', 'typed'); go(ReplyTracker.maxAge + 1); t.started('s', 'typed');
    expect(out.map((s) => s.outcome)).toEqual(['abandoned']);
  });
  it('events for untracked sessions are ignored', () => {
    const { t, out } = reply();
    t.delta('x', false); t.activity('x'); t.message('x'); t.finish('x', 'completed'); t.missedEnd('x');
    expect(out).toEqual([]);
  });
  it('resets, empty deltas and whole messages break gaps; the 3000 ms stall boundary is inclusive', () => {
    const { t, out, go } = reply();
    t.started('s', 'typed'); t.delta('s', false); go(3000); t.delta('s', false);
    go(9000); t.delta('s', true); t.delta('s', false, true); go(9000); t.delta('s', false);
    t.message('s'); go(9000); t.delta('s', false); t.missedEnd('s');
    expect(out[0]).toMatchObject({ outcome: 'abandoned', stalls: 1, maxGapMs: 3000, deltas: 5 });
  });
  it.each(['completed', 'failed', 'stopped'] as const)('finishes %s exactly once', (outcome) => {
    const { t, out } = reply();
    t.started('s', 'typed'); t.message('s'); t.finish('s', outcome); t.finish('s', outcome);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ outcome, firstActivityMs: 0, firstTextMs: 0 });
  });
});
