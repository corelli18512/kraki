import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './useStore';

const map = (entries: [string, unknown][]) => ({ __type: 'Map', entries });

// K-232: a kraki-store written by the first persistence build (messages and
// lastSeq kept in localStorage) must not come back as chat history.
describe('kraki-store rehydration from older builds', () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.getState().reset();
  });

  it('drops obsolete keys and keeps the ones this build persists', async () => {
    localStorage.setItem('kraki-store', JSON.stringify({
      version: 0,
      state: {
        messages: map([['s1', [{ type: 'agent_message', sessionId: 's1', payload: { content: 'OLD-LS duplicate answer' } }]]]),
        lastSeq: map([['s1', 41]]),
        sessions: map([['s1', { id: 's1', deviceId: 'd1', deviceName: 'Mac', agent: 'pi', messageCount: 1 }]]),
        pinnedSessions: { __type: 'Set', values: ['s1'] },
        drafts: map([['s1', 'draft text']]),
      },
    }));
    await useStore.persist.rehydrate();
    const state = useStore.getState() as unknown as Record<string, unknown>;
    expect(useStore.getState().messages.size).toBe(0);
    expect(state.lastSeq).toBeUndefined();
    expect(useStore.getState().sessions.get('s1')?.deviceName).toBe('Mac');
    expect(useStore.getState().pinnedSessions.has('s1')).toBe(true);
    expect(useStore.getState().drafts.get('s1')).toBe('draft text');
  });

  it('keeps defaults for values of the wrong shape (pinnedSessions as a plain array)', async () => {
    localStorage.setItem('kraki-store', JSON.stringify({
      version: 0,
      state: { pinnedSessions: ['s1'], sessions: 'garbage' },
    }));
    await useStore.persist.rehydrate();
    expect(useStore.getState().pinnedSessions.has('s1')).toBe(true);
    expect(useStore.getState().sessions).toBeInstanceOf(Map);
  });
});
