/**
 * 'Local link stats' cadence (log audit 2026-10-22): one line every 5 s,
 * because heartbeats move a counter on every tick, was 97 % of
 * relay-client.log and cut its retention to ~10 days.
 */
import { describe, expect, it } from 'vitest';
import { LOCAL_LINK_STATS_SUMMARY_MS, localLinkStatsLogReason } from '../relay-client.js';

const stats = (peers: string[], framesOut: number, framesToLinkedApps = 0) => ({
  peers, framesOut, framesIn: framesOut, bytesOut: framesOut * 43, bytesIn: framesOut * 43, payloadsOut: 0, payloadsIn: 0,
  head: { frames: framesOut * 2, bytes: framesOut * 100, framesToLinkedApps },
});

describe('localLinkStatsLogReason', () => {
  it('stays quiet while only heartbeat counters move, and summarises every 5 minutes', () => {
    const first = stats(['mac'], 1);
    expect(localLinkStatsLogReason(null, first, Infinity)).toBe('first');
    // 59 five-second ticks with heartbeat frames only: nothing logged.
    for (let tick = 1; tick < LOCAL_LINK_STATS_SUMMARY_MS / 5000; tick++) {
      expect(localLinkStatsLogReason(first, stats(['mac'], 1 + tick), tick * 5000)).toBeNull();
    }
    expect(localLinkStatsLogReason(first, stats(['mac'], 61), LOCAL_LINK_STATS_SUMMARY_MS)).toBe('summary');
    expect(localLinkStatsLogReason(first, first, LOCAL_LINK_STATS_SUMMARY_MS)).toBeNull();
  });

  it('logs at once when the linked Apps change or a linked App got a frame through the Head', () => {
    const prev = stats(['mac'], 5);
    expect(localLinkStatsLogReason(prev, stats([], 6), 5000)).toBe('peers');
    expect(localLinkStatsLogReason(prev, stats(['mac', 'win'], 6), 5000)).toBe('peers');
    expect(localLinkStatsLogReason(prev, stats(['mac'], 6, 1), 5000)).toBe('head-to-linked');
  });
});
