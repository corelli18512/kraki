import { describe, it, expect } from 'vitest';
import { attentionCount, getSessionStatus, countPendingQuestions } from './session-status';
import type { SessionSummary } from '@kraki/protocol';
import type { SessionCard } from '../types/store';

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'pi',
    state: 'active', messageCount: 1, ...over,
  } as SessionSummary;
}

function cardMap(entries: Array<{ sessionId: string; decided?: boolean }>): Map<string, SessionCard> {
  const m = new Map<string, SessionCard>();
  for (const e of entries) {
    m.set(e.sessionId, {
      text: '',
      action: { type: 'permission', payload: { id: `p-${e.sessionId}`, toolName: 'shell', args: {}, description: 'Run shell', ...(e.decided && { decision: 'approve' }) } } as SessionCard['action'],
    });
  }
  return m;
}

describe('countPendingQuestions', () => {
  it('counts an unresolved permission of the given session (questions are on the spine)', () => {
    const m = cardMap([{ sessionId: 's1' }, { sessionId: 's2', decided: true }]);
    expect(countPendingQuestions('s1', m)).toBe(1);
    expect(countPendingQuestions('s2', m)).toBe(0);
    expect(countPendingQuestions('s3', m)).toBe(0);
  });
});

describe('attentionCount (tab title, K-220)', () => {
  it('adds Sessions waiting on an approval or answer to the unread count, each once', () => {
    const ids = ['s1', 's2', 's3', 's4'];
    const previews = new Map([['s2', { type: 'permission' }], ['s3', { type: 'question' }], ['s4', { type: 'agent' }]]);
    expect(attentionCount(new Map(), ids, new Map(), new Map())).toBe(0);
    // A live permission card (s1) and the previews (s2, s3).
    expect(attentionCount(new Map(), ids, cardMap([{ sessionId: 's1' }]), previews)).toBe(3);
    // Unread and waiting counts once; a decided permission does not wait.
    expect(attentionCount(new Map([['s2', 1], ['s4', 2]]), ids, cardMap([{ sessionId: 's1', decided: true }]), previews)).toBe(4);
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

describe('one name per session and model (same as iOS/Mac)', () => {
  it('untitled sessions are "New Session"', async () => {
    const { sessionDisplayTitle } = await import('./session-status');
    expect(sessionDisplayTitle({})).toBe('New Session');
    expect(sessionDisplayTitle({ autoTitle: 'Fix tests' })).toBe('Fix tests');
    expect(sessionDisplayTitle({ title: 'Mine', autoTitle: 'Fix tests' })).toBe('Mine');
  });
  it("models show their agent's name", async () => {
    const { modelDisplayName } = await import('./session-status');
    const agents = [{ id: 'pi', modelDetails: [{ id: 'deepseek/deepseek-flash', name: 'Deepseek deepseek-flash' }] }];
    expect(modelDisplayName('deepseek/deepseek-flash', agents, 'pi')).toBe('Deepseek deepseek-flash');
    expect(modelDisplayName('other/model', agents, 'pi')).toBe('other/model');
  });
});
