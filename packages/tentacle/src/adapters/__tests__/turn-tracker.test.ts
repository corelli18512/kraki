import { describe, it, expect } from 'vitest';
import { TurnTracker } from '../turn-tracker.js';

/** Records every callback as a compact line, in order. */
function harness() {
  const log: string[] = [];
  const t = (e?: { turnId?: string }) => (e?.turnId ? `@${e.turnId}` : '');
  const sink = {
    onNarration: (_s: string, e: { content: string; turnId?: string }) => log.push(`draft ${e.content}${t(e)}`),
    onNarrationTrace: (_s: string, e: { content: string; turnId?: string }) => log.push(`step ${e.content}${t(e)}`),
    onMessage: (_s: string, e: { content: string; turnId?: string }) => log.push(`reply ${e.content}${t(e)}`),
    onError: (_s: string, e: { message: string; turnId?: string }) => log.push(`error ${e.message}${t(e)}`),
    onIdle: (_s: string, e?: { turnId?: string }) => log.push(`idle${t(e)}`),
  };
  const tracker = new TurnTracker(sink, 's1');
  return { tracker, log };
}

describe('TurnTracker', () => {
  it('the last prose with no tool after it is the reply, never also a step', () => {
    const { tracker, log } = harness();
    tracker.beginTurn();
    tracker.proseSegment('Looking.');
    tracker.toolStarted();
    tracker.proseSegment('Done: 3 files.');
    tracker.finish();
    expect(log).toEqual(['draft Looking.', 'step Looking.', 'draft Done: 3 files.', 'reply Done: 3 files.', 'idle']);
  });

  it('a turn that ends on a tool has no reply: its prose is a step', () => {
    const { tracker, log } = harness();
    tracker.beginTurn();
    tracker.proseSegment('Running tests.');
    tracker.toolStarted();
    tracker.finish();
    expect(log).toEqual(['draft Running tests.', 'step Running tests.', 'idle']);
  });

  it('a newer segment turns the previous one into a step', () => {
    const { tracker, log } = harness();
    tracker.beginTurn();
    tracker.proseSegment('First.');
    tracker.proseSegment('Second.');
    tracker.finish();
    // Pi's order: the new segment reconciles the draft, then the old one is recorded.
    expect(log).toEqual(['draft First.', 'draft Second.', 'step First.', 'reply Second.', 'idle']);
  });

  it('streamed prose is joined and classified at the next boundary', () => {
    const { tracker, log } = harness();
    tracker.beginTurn();
    tracker.appendProse('a');
    tracker.appendProse('b');
    tracker.toolStarted();
    tracker.appendProse('c', '\n\n');
    tracker.appendProse('d', '\n\n');
    tracker.finish();
    expect(log).toEqual(['draft a\nb', 'step a\nb', 'draft c\n\nd', 'reply c\n\nd', 'idle']);
  });

  it('an error replaces the reply', () => {
    const { tracker, log } = harness();
    tracker.beginTurn();
    tracker.appendProse('Half an ans');
    tracker.setError('rate limited');
    tracker.finish();
    expect(log).toEqual(['error rate limited', 'idle']);
    expect(tracker.pendingError).toBeUndefined();
  });

  it('a later success clears a held error', () => {
    const { tracker, log } = harness();
    tracker.beginTurn();
    tracker.setError('overloaded, retrying');
    tracker.clearError();
    tracker.proseSegment('Answer.');
    tracker.finish();
    expect(log).toEqual(['draft Answer.', 'reply Answer.', 'idle']);
  });

  it('a user stop ends silently: no reply, error or idle', () => {
    const { tracker, log } = harness();
    tracker.beginTurn();
    tracker.appendProse('working on');
    expect(tracker.abort()).toBe(true);
    expect(tracker.isSettled).toBe(false);
    tracker.appendProse('late words');
    tracker.finish({ error: 'interrupted' });
    expect(log).toEqual([]);
    expect(tracker.isSettled).toBe(true);
  });

  it('ends once: a second finish or idle source is ignored', () => {
    const { tracker, log } = harness();
    tracker.beginTurn();
    tracker.proseSegment('Hi.');
    expect(tracker.finish()).toBe(true);
    expect(tracker.finish()).toBe(false);
    expect(tracker.settleSilently()).toBe(false);
    expect(tracker.abort()).toBe(false);
    expect(log).toEqual(['draft Hi.', 'reply Hi.', 'idle']);
  });

  it('finish({ idle: false }) concludes the reply but leaves idle to a continuation', () => {
    const { tracker, log } = harness();
    tracker.beginTurn();
    tracker.proseSegment('Part one.');
    tracker.finish({ idle: false });
    expect(log).toEqual(['draft Part one.', 'reply Part one.']);
    expect(tracker.isSettled).toBe(true);
  });

  it('holdOpen makes prose so far a step and keeps the turn open', () => {
    const { tracker, log } = harness();
    tracker.beginTurn();
    tracker.proseSegment('Started two subagents.');
    tracker.holdOpen();
    expect(tracker.isSettled).toBe(false);
    tracker.proseSegment('Both finished: all good.');
    tracker.finish();
    expect(log).toEqual([
      'draft Started two subagents.', 'step Started two subagents.',
      'draft Both finished: all good.', 'reply Both finished: all good.', 'idle',
    ]);
  });

  it('stamps the turn the agent works on; a new prompt id applies once captured', () => {
    const { tracker, log } = harness();
    tracker.relayTurnId = 't1';
    tracker.beginTurn({ captureNow: true });
    tracker.relayTurnId = 't2'; // next prompt assigned before the agent started on it
    tracker.proseSegment('late from t1');
    tracker.finish();
    tracker.beginTurn();
    tracker.captureTurnId();
    tracker.proseSegment('t2 answer');
    tracker.finish();
    expect(log).toEqual(['draft late from t1@t1', 'reply late from t1@t1', 'idle@t1', 'draft t2 answer@t2', 'reply t2 answer@t2', 'idle@t2']);
  });

  it('settleSilently ends without output', () => {
    const { tracker, log } = harness();
    tracker.beginTurn();
    tracker.appendProse('x');
    expect(tracker.settleSilently()).toBe(true);
    expect(log).toEqual([]);
    expect(tracker.isSettled).toBe(true);
  });
});
