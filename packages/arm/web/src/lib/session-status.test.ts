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

  it('compacting when compacting and no human action is pending', () => {
    expect(getSessionStatus(session({ state: 'compacting' }), 0)).toBe('compacting');
  });

  it('pending human action takes priority over compacting', () => {
    expect(getSessionStatus(session({ state: 'compacting' }), 1)).toBe('pending');
    expect(getSessionStatus(session({ state: 'compacting' }), 0, 'question')).toBe('pending');
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

  it('an open question reads pending even when the transport state is idle', () => {
    // The digest preview is authoritative: `type:'question'` is only carried
    // while a question is genuinely open (enrichSessionList overrides it from
    // the in-memory openQuestions map, and a resolved question reverts the
    // preview to the spine). So a 'question' preview is never stale. After a
    // relay restart the transport state collapses to 'idle' even though the
    // turn is still blocked on a human answer — pending must still surface so
    // the sidebar shows "waiting" and the user notices the unanswered ask.
    expect(getSessionStatus(session({ state: 'idle' }), 0, 'question')).toBe('pending');
    expect(getSessionStatus(session({ state: 'idle' }), 1)).toBe('pending');
  });
});
