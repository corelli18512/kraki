import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiAdapter } from '../adapters/pi.js';
import type { PiSession } from '../adapters/pi-session.js';
import type { PiRpcProcess } from '../adapters/pi-rpc.js';
import { turnFixture } from './helpers/turn-fixture.js';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

interface State { isCompacting?: boolean; isStreaming?: boolean }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Actual prompt/preflight/watchdog and compaction mutator; only RPC is fake. */
function setup() {
  vi.useFakeTimers();
  const adapter = new PiAdapter({ cliPath: '/unused',
    promptWatchdog: { ackGraceMs: 5, intervalMs: 5, idleStallMs: 1_000 } });
  const ack = deferred<void>();
  const probes: Array<ReturnType<typeof deferred<State>>> = [];
  const request = vi.fn((command: string) => {
    if (command === 'prompt') return ack.promise;
    if (command === 'get_state') {
      const probe = deferred<State>(); probes.push(probe); return probe.promise;
    }
    return Promise.resolve({});
  });
  const proc = { alive: true, request, kill: vi.fn(), sendRaw: vi.fn() };
  const makeSession = (id: string, turnId: string): PiSession => ({
    proc: proc as unknown as PiRpcProcess, cwd: '/unused', model: 'fake/model', mode: 'safe',
    lastActivity: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, totalCost: 0, totalDurationMs: 0 },
    turn: turnFixture(adapter, id, { relayTurnId: turnId, eventTurnId: turnId }),
    exitObserved: false, pendingPerms: new Map(), pendingQuestions: new Map(),
    lastStopReason: undefined, pendingMaintenanceIdle: false, aborting: false,
  });
  const original = makeSession('s', 'A'); adapter.sessions.set('s', original);
  const compaction = vi.fn(); adapter.onCompaction = compaction;
  const records = (adapter as unknown as { compactingSessions: Map<string, { turnId?: string }> }).compactingSessions;
  let settled = false;
  const sending = adapter.sendMessage('s', 'original prompt');
  const outcome = sending.then(() => { settled = true; return { state: 'accepted' as const }; },
    (error: unknown) => { settled = true; return { state: 'rejected' as const, error }; });
  const probe = async () => {
    const count = probes.length;
    await vi.advanceTimersByTimeAsync(5);
    expect(probes).toHaveLength(count + 1);
    return probes[count];
  };
  const release = async (pending: ReturnType<typeof deferred<State>>, state: State) => {
    pending.resolve(state); await vi.advanceTimersByTimeAsync(0);
  };
  const cleanup = async () => {
    // Resolve ALL original probes and ACK even when a safety assertion fails.
    for (const pending of probes) pending.resolve({ isStreaming: true });
    ack.resolve(); await outcome;
  };
  return { adapter, original, makeSession, proc, request, ack, probes, compaction,
    records, probe, release, outcome, cleanup, isSettled: () => settled };
}
afterEach(() => vi.useRealTimers());

describe('Pi watchdog compaction effects retain their original session source', () => {
  it('does not start replacement B maintenance from A deferred compacting probe', async () => {
    const t = setup();
    try {
      const pending = await t.probe();
      const replacement = t.makeSession('s', 'B'); t.adapter.sessions.set('s', replacement);
      await t.release(pending, { isCompacting: true });
      expect(t.compaction).not.toHaveBeenCalled(); expect(t.records.has('s')).toBe(false);
      expect(t.isSettled()).toBe(false); // Source mismatch is not prompt acceptance.
      expect(t.request.mock.calls.filter(([type]) => type === 'prompt')).toHaveLength(1);
      expect(replacement.promptPreflight).toBeUndefined();
    } finally { await t.cleanup(); }
  });

  it.each([false, true])('does not end B maintenance from A noncompacting probe (streaming=%s)', async isStreaming => {
    const t = setup();
    try {
      const pending = await t.probe();
      t.adapter.sessions.set('s', t.makeSession('s', 'B'));
      t.adapter.setCompacting('s', true, { reason: 'manual' });
      const owner = t.records.get('s'); const start = t.compaction.mock.calls[0];
      await t.release(pending, { isCompacting: false, isStreaming });
      expect(t.records.get('s')).toBe(owner);
      expect(t.compaction.mock.calls).toEqual([start]);
      expect(t.isSettled()).toBe(isStreaming); // Original watchdog outcome is unchanged.
      if (isStreaming) expect(await t.outcome).toEqual({ state: 'accepted' });
    } finally { await t.cleanup(); }
  });

  it.each([true, false])('a dead process without replacement suppresses the compacting=%s effect', async isCompacting => {
    const t = setup();
    try {
      const pending = await t.probe();
      if (!isCompacting) t.adapter.setCompacting('s', true);
      const owner = t.records.get('s'); const calls = [...t.compaction.mock.calls];
      t.proc.alive = false;
      await t.release(pending, { isCompacting, isStreaming: !isCompacting });
      expect(t.records.get('s')).toBe(owner); expect(t.compaction.mock.calls).toEqual(calls);
      expect(t.isSettled()).toBe(!isCompacting);
    } finally { await t.cleanup(); }
  });

  it.each([true, false])('existing abort cancellation suppresses a source probe (compacting=%s)', async isCompacting => {
    const t = setup();
    try {
      const pending = await t.probe();
      await t.adapter.abortSession('s'); // Existing watchdog AbortController, not new source fencing.
      const calls = [...t.compaction.mock.calls];
      await t.release(pending, { isCompacting, isStreaming: !isCompacting });
      expect(t.compaction.mock.calls).toEqual(calls); expect(t.records.has('s')).toBe(false);
      expect(await t.outcome).toEqual({ state: 'accepted' });
      expect(t.proc.kill).toHaveBeenCalledOnce();
    } finally { await t.cleanup(); }
  });

  it('current repeated compacting probes emit once, keep unrelated ownership, and never resend', async () => {
    const t = setup();
    try {
      t.adapter.sessions.set('other', t.makeSession('other', 'other-turn'));
      t.adapter.setCompacting('other', true, { reason: 'manual' });
      const otherOwner = t.records.get('other'); const otherStart = t.compaction.mock.calls[0];
      await t.release(await t.probe(), { isCompacting: true });
      const owner = t.records.get('s');
      await t.release(await t.probe(), { isCompacting: true });
      expect(t.compaction.mock.calls).toEqual([otherStart, ['s', { phase: 'start', turnId: 'A' }]]);
      expect(t.records.get('s')).toBe(owner); expect(t.records.get('other')).toBe(otherOwner);
      expect(t.request.mock.calls.filter(([type]) => type === 'prompt')).toHaveLength(1);
      expect(t.isSettled()).toBe(false);
    } finally { await t.cleanup(); }
  });

  it('matching noncompacting reconciliation ends the exact start owner after logical identity changes', async () => {
    const t = setup();
    try {
      await t.release(await t.probe(), { isCompacting: true });
      const owner = t.records.get('s'); expect(owner).toBe(t.original.promptPreflight);
      t.adapter.setTurnIdentity('s', 'later-logical-turn');
      await t.release(await t.probe(), { isCompacting: false, isStreaming: true });
      expect(t.compaction.mock.calls).toEqual([
        ['s', { phase: 'start', turnId: 'A' }], ['s', { phase: 'end', turnId: 'A' }],
      ]);
      expect(owner).toEqual({ turnId: 'A' }); expect(t.records.has('s')).toBe(false);
      expect(await t.outcome).toEqual({ state: 'accepted' });
    } finally { await t.cleanup(); }
  });

  it('reentrant replacement during a valid start is fenced on the next original probe', async () => {
    const t = setup();
    try {
      t.compaction.mockImplementationOnce(() => {
        t.adapter.sessions.set('s', t.makeSession('s', 'B'));
        t.adapter.setCompacting('s', false); t.adapter.setCompacting('s', true);
      });
      await t.release(await t.probe(), { isCompacting: true });
      const bOwner = t.records.get('s'); const calls = [...t.compaction.mock.calls];
      expect(bOwner).toEqual({ turnId: 'B' });
      await t.release(await t.probe(), { isCompacting: false, isStreaming: true });
      expect(t.records.get('s')).toBe(bOwner); expect(t.compaction.mock.calls).toEqual(calls);
      expect(await t.outcome).toEqual({ state: 'accepted' });
    } finally { await t.cleanup(); }
  });

  it('suppressed stale compaction does not replace the original prompt rejection', async () => {
    const t = setup();
    try {
      const pending = await t.probe(); t.adapter.sessions.set('s', t.makeSession('s', 'B'));
      await t.release(pending, { isCompacting: true });
      const error = new Error('original prompt rejection'); t.ack.reject(error);
      expect(await t.outcome).toEqual({ state: 'rejected', error });
      expect(t.compaction).not.toHaveBeenCalled();
      expect(t.request.mock.calls.filter(([type]) => type === 'prompt')).toHaveLength(1);
    } finally { await t.cleanup(); }
  });
});
