import { describe, it, expect } from 'vitest';
import { getSessionStatus, countPendingQuestions } from './session-status';
import type { SessionSummary } from '@kraki/protocol';
import type { SessionCard } from '../types/store';

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'pi',
    state: 'active', messageCount: 1, ...over,
  } as SessionSummary;
}

function cardMap(entries: Array<{ sessionId: string; kind: 'question' | 'permission' }>): Map<string, SessionCard> {
  const m = new Map<string, SessionCard>();
  for (const e of entries) {
    m.set(e.sessionId, {
      text: '',
      action: e.kind === 'question'
        ? { type: 'question', payload: { id: `q-${e.sessionId}`, question: 'q' } }
        : { type: 'permission', payload: { id: `p-${e.sessionId}`, toolName: 'shell', args: {}, description: 'Run shell' } },
    });
  }
  return m;
}

describe('countPendingQuestions', () => {
  it('counts only questions for the given session', () => {
    const m = cardMap([
      { sessionId: 's1', kind: 'question' },
      { sessionId: 's2', kind: 'permission' },
    ]);
    expect(countPendingQuestions('s1', m)).toBe(1);
    expect(countPendingQuestions('s2', m)).toBe(0);
    expect(countPendingQuestions('s3', m)).toBe(0);
  });
});

describe('getSessionStatus', () => {
  it('idle when state idle and no pending', () => {
    expect(getSessionStatus(session({ state: 'idle' }), 0)).toBe('idle');
  });

  it('working when active and no pending', () => {
    expect(getSessionStatus(session({ state: 'active' }), 0)).toBe('working');
  });

  it('pending when there is a live open question (even while active)', () => {
    expect(getSessionStatus(session({ state: 'active' }), 1)).toBe('pending');
  });

  it('pending via preview hint when no live questions yet (reload seed)', () => {
    expect(getSessionStatus(session({ state: 'active' }), 0, 'question')).toBe('pending');
  });

  it('live count takes priority — still pending', () => {
    expect(getSessionStatus(session({ state: 'active' }), 3, 'agent')).toBe('pending');
  });

  it('ended overrides everything', () => {
    expect(getSessionStatus(session({ state: 'ended' as SessionSummary['state'] }), 5)).toBe('ended');
  });

  it('idle wins over a stale/absent hint', () => {
    expect(getSessionStatus(session({ state: 'idle' }), 0, 'agent')).toBe('idle');
  });

  it('an idle session is never pending even with a stale question preview', () => {
    // A pending turn is by definition running; once idle the turn concluded, so
    // a not-yet-refreshed 'question' preview must not resurrect the pending badge.
    expect(getSessionStatus(session({ state: 'idle' }), 0, 'question')).toBe('idle');
  });
});
