import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../hooks/useStore';
import { captureEntryBoundary, firstUnreadKey, markNotificationEntry, unreadLanding } from './unread-entry';

const session = (lastSeq: number, readSeq: number) => ({
  id: 's1', deviceId: 'd1', deviceName: 'PC', agent: 'pi', state: 'idle', messageCount: lastSeq, lastSeq, readSeq,
}) as never;

describe('unread entry (same rule as iPhone/Mac ChatScrollPolicy.UnreadEntry)', () => {
  beforeEach(() => useStore.getState().reset());

  it('first new row is the lowest seq after the read position', () => {
    const rows = [{ key: 'a', seq: 10 }, { key: 'b', seq: 11 }, { key: 'live' }, { key: 'c', seq: 12 }];
    expect(firstUnreadKey(rows, 10)).toBe('b');
    expect(firstUnreadKey(rows, 12)).toBeNull();
  });

  it('lands on the first new row only when its start is not readable at the newest edge', () => {
    expect(unreadLanding(900, 900)).toBeNull();
    expect(unreadLanding(400, 900)).toBe(400);
  });

  it('captures the read position for a red dot or a notification, never for a read Session', () => {
    useStore.getState().setSessions([session(10, 10)]);
    expect(captureEntryBoundary('s1')).toBeNull();
    markNotificationEntry('s1');
    expect(captureEntryBoundary('s1')).toBe(10);
    expect(captureEntryBoundary('s1')).toBeNull();
    useStore.getState().setSessions([session(14, 10)]);
    expect(captureEntryBoundary('s1')).toBe(10);
    useStore.getState().setSessions([session(14, 0)]);
    expect(captureEntryBoundary('s1')).toBeNull();
  });
});
