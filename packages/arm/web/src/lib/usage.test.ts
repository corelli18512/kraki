import { describe, expect, it } from 'vitest';
import type { AccountUsage, DeviceSummary } from '@kraki/protocol';
import { accountKeyForSession, canRefreshUsage, isStale, mergedUsage, orderedAccounts, readStatus, ringState, ringWindows, shortReset, type DeviceUsageSnapshot } from './usage';

const now = Date.parse('2026-10-05T00:00:00Z');
const iso = (ms: number) => new Date(now + ms).toISOString();
const acct = (o: Partial<AccountUsage>): AccountUsage => ({ accountKey: 'k', provider: 'claude', windows: [], fetchedAt: iso(-60_000), ...o });
const dev = (id: string, online = true): DeviceSummary => ({ id, name: id, role: 'tentacle', online });

describe('account usage (Mac/iOS AccountUsage + DeviceStore)', () => {
  it('rings are 5h then weekly; colours follow the remaining percent', () => {
    const a = acct({ windows: [{ id: 'w', kind: 'weekly', remainingPercent: 40 }, { id: 'o', kind: 'other', remainingPercent: 5 }, { id: 'f', kind: 'five_hour', remainingPercent: 80 }] });
    expect(ringWindows(a).map((w) => w.id)).toEqual(['f', 'w']);
    expect([ringState(80, false), ringState(40, false), ringState(10, false), ringState(0.2, false), ringState(80, true)]).toEqual(['ok', 'mid', 'low', 'out', 'stale']);
    expect(shortReset(iso(2 * 3600e3 + 5 * 60e3), now)).toBe('2h 5m');
    expect(shortReset(iso(3 * 86400e3 + 4 * 3600e3), now)).toBe('3d 4h');
  });

  it('staleness and read status', () => {
    expect(isStale(acct({}), now)).toBe(false);
    expect(isStale(acct({ fetchedAt: iso(-3600e3) }), now)).toBe(true);
    expect(readStatus(acct({ error: 'auth' }), now)).toBe('Sign-in needed');
    expect(readStatus(acct({ error: 'rate_limited', retryAt: iso(150_000) }), now)).toBe('Rate limited · retry in 3m');
  });

  it('merges one account across devices, keeping the freshest successful reading', () => {
    const usage = new Map<string, DeviceUsageSnapshot>([
      ['a', { accounts: [acct({ accountKey: 'x', fetchedAt: iso(-120_000), windows: [{ id: 'f', kind: 'five_hour', remainingPercent: 50 }] })], receivedAt: now }],
      ['b', { accounts: [acct({ accountKey: 'x', fetchedAt: iso(-10_000), error: 'auth' }), acct({ accountKey: 'y', provider: 'codex' })], receivedAt: now }],
    ]);
    const merged = mergedUsage(usage, new Map([['a', dev('a')], ['b', dev('b', false)]]));
    const x = merged.find((m) => m.id === 'x')!;
    expect(x.devices.map((d) => d.id)).toEqual(['a', 'b']);
    expect(x.account.error).toBeUndefined();
    // y is only on an offline device and has no readings: dropped.
    expect(merged.map((m) => m.id)).toEqual(['x']);
  });

  it("puts the current Session's account first", () => {
    const usage = new Map<string, DeviceUsageSnapshot>([['a', { accounts: [
      acct({ accountKey: 'c1', provider: 'claude', agents: ['claude', 'pi'] }),
      acct({ accountKey: 'g1', provider: 'codex', agents: ['codex', 'pi'] }),
    ], receivedAt: now }]]);
    expect(accountKeyForSession(usage, 'a', 'pi', 'openai-codex/gpt-6')).toBe('g1');
    expect(accountKeyForSession(usage, 'a', 'pi', undefined)).toBeNull();
    const list = mergedUsage(usage, new Map([['a', dev('a')]]));
    expect(orderedAccounts(list, 'g1')[0].id).toBe('g1');
  });

  it('refreshes at most once a minute per device', () => {
    expect(canRefreshUsage(undefined, undefined, false, now)).toBe(true);
    expect(canRefreshUsage({ requestId: 'r', startedAt: now - 30_000, finished: true }, undefined, false, now)).toBe(false);
    expect(canRefreshUsage({ requestId: 'r', startedAt: now - 90_000, finished: true }, undefined, false, now)).toBe(true);
  });
});
