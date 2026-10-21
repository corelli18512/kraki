/**
 * Log audit 2026-10-22: pi retries and multi-hour stalls were logged without
 * their cause or attempt, compaction left no trace, and nothing said when a
 * turn started or was stopped. These lines are the evidence a later audit
 * needs; the tests pin their fields (never message content).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiAdapter } from '../adapters/pi.js';
import { handleEvent } from '../adapters/pi-events.js';
import { TURN_STALL_WARN_MS } from '../adapters/pi-session.js';
import { PiRpcProcess } from '../adapters/pi-rpc.js';
import { turnFixture } from './helpers/turn-fixture.js';

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../logger.js', () => ({ createLogger: () => log }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const fn of Object.values(log)) fn.mockReset();
});

function setup() {
  const adapter = new PiAdapter({ cliPath: '/unused' });
  const sid = 's';
  const proc = { alive: true, request: vi.fn().mockResolvedValue({}), kill: vi.fn(), sendRaw: vi.fn() };
  const session = {
    proc, turn: turnFixture(adapter, sid, { open: true, relayTurnId: 'turn-1', eventTurnId: 'turn-1' }),
    pendingPerms: new Map(), pendingQuestions: new Map(),
    lastStopReason: undefined as string | undefined,
    pendingMaintenanceIdle: false, aborting: false,
    usage: {}, lastActivity: Date.now(), exitObserved: false, mode: 'auto',
    turnStartedAt: Date.now(),
  };
  (adapter as unknown as { sessions: Map<string, typeof session> }).sessions.set(sid, session);
  (adapter as unknown as { refreshUsage: () => Promise<void> }).refreshUsage = async () => {};
  const emit = (event: Record<string, unknown>) => handleEvent(adapter, sid, event);
  return { adapter, sid, proc, session, emit };
}

/** The structured fields of every call with this message at this level. */
function logged(level: keyof typeof log, msg: string): Array<Record<string, unknown>> {
  return log[level].mock.calls.filter((c) => c[1] === msg).map((c) => c[0] as Record<string, unknown>);
}

describe('pi retry and stall diagnostics', () => {
  it('logs the cause and attempt of each pi auto-retry and the error on agent_end', async () => {
    const t = setup();
    await t.emit({ type: 'agent_start' });
    await t.emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '429 Too Many Requests' } });
    await t.emit({ type: 'agent_end', willRetry: true });
    await t.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '429 Too Many Requests' });

    expect(logged('info', 'pi agent lifecycle')[0]).toMatchObject({
      sessionId: 's', turnId: 'turn-1', phase: 'agent_end', willRetry: true, stopReason: 'error', err: '429 Too Many Requests',
    });
    expect(logged('info', 'pi retrying a failed model request')).toEqual([expect.objectContaining({
      sessionId: 's', turnId: 'turn-1', attempt: 1, maxAttempts: 3, delayMs: 2000, err: '429 Too Many Requests',
    })]);

    // The next agent_end carries the attempt the adapter learned from pi.
    await t.emit({ type: 'agent_end', willRetry: true });
    expect(logged('info', 'pi agent lifecycle')[1]).toMatchObject({ retryAttempt: 1 });

    await t.emit({ type: 'auto_retry_end', attempt: 1, success: false, finalError: 'overloaded' });
    expect(logged('warn', 'pi model request retries ended')).toEqual([expect.objectContaining({ attempt: 1, success: false, err: 'overloaded' })]);
  });

  it('a long retry series becomes a warning, and error text is bounded', async () => {
    const t = setup();
    await t.emit({ type: 'auto_retry_start', attempt: 4, maxAttempts: 50, delayMs: 60_000, errorMessage: 'x'.repeat(1000) });
    await t.emit({ type: 'auto_retry_start', attempt: 5, maxAttempts: 50, delayMs: 60_000, errorMessage: 'x' });
    expect(logged('info', 'pi retrying a failed model request')).toHaveLength(1);
    expect((logged('info', 'pi retrying a failed model request')[0].err as string).length).toBe(300);
    expect(logged('warn', 'pi retrying a failed model request')).toEqual([expect.objectContaining({ attempt: 5 })]);
  });

  it('warns once when an open turn hears nothing from pi for a long time', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.session.retryAttempt = 2;
    const sweep = () => (t.adapter as unknown as { sweepIdle(): void }).sweepIdle();
    vi.advanceTimersByTime(TURN_STALL_WARN_MS - 1);
    sweep();
    expect(logged('warn', 'pi turn has had no events for a long time')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    sweep();
    sweep();
    expect(logged('warn', 'pi turn has had no events for a long time')).toEqual([expect.objectContaining({
      sessionId: 's', turnId: 'turn-1', silentMs: TURN_STALL_WARN_MS, retryAttempt: 2,
    })]);
    // Any pi event ends that silence; a new one is reported again.
    await t.emit({ type: 'turn_end' });
    vi.advanceTimersByTime(TURN_STALL_WARN_MS);
    sweep();
    expect(logged('warn', 'pi turn has had no events for a long time')).toHaveLength(2);
  });

  it('does not report a turn waiting on the user as stalled', () => {
    vi.useFakeTimers();
    const t = setup();
    t.session.pendingQuestions.set('q', 'q');
    vi.advanceTimersByTime(TURN_STALL_WARN_MS * 4);
    (t.adapter as unknown as { sweepIdle(): void }).sweepIdle();
    expect(logged('warn', 'pi turn has had no events for a long time')).toHaveLength(0);
  });

  it('logs compaction start and end with its duration and failure', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.emit({ type: 'compaction_start', reason: 'threshold' });
    vi.advanceTimersByTime(11_000);
    await t.emit({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false, errorMessage: 'summary failed' });
    expect(logged('info', 'pi compaction started')).toEqual([expect.objectContaining({ sessionId: 's', turnId: 'turn-1', reason: 'threshold' })]);
    expect(logged('warn', 'pi compaction ended')).toEqual([expect.objectContaining({
      sessionId: 's', reason: 'threshold', aborted: false, durationMs: 11_000, err: 'summary failed',
    })]);
  });
});

describe('pi turn and process lifecycle logs', () => {
  it('logs prompt acceptance with the relay turn id (correlates with relay-client logs)', async () => {
    const t = setup();
    t.session.turn = turnFixture(t.adapter, t.sid, { relayTurnId: 'turn-2', eventTurnId: 'turn-1' });
    await t.adapter.sendMessage(t.sid, 'secret user text');
    expect(logged('info', 'pi prompt accepted')).toEqual([expect.objectContaining({
      sessionId: 's', turnId: 'turn-2', delivery: 'prompt', resumed: false,
    })]);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('secret user text');
  });

  it('records the stuck-processing abort, what it interrupted, and the retry outcome', async () => {
    const t = setup();
    t.session.turn = turnFixture(t.adapter, t.sid, { relayTurnId: 'turn-2', eventTurnId: 'turn-1' });
    let prompts = 0;
    t.proc.request.mockImplementation(async (type: string) => {
      if (type === 'prompt' && ++prompts === 1) throw new Error('Agent is already processing');
      return {};
    });
    await t.adapter.sendMessage(t.sid, 'hello');
    expect(logged('warn', 'pi stuck in processing state — awaiting abort before retry')).toEqual([expect.objectContaining({
      sessionId: 's', turnId: 'turn-2', previousTurnId: 'turn-1', awaitingSubagents: false, backgroundRuns: 0,
    })]);
    expect(logged('info', 'pi prompt accepted')).toEqual([expect.objectContaining({ turnId: 'turn-2', delivery: 'prompt_after_stuck_abort' })]);
  });

  it('a failed retry after the stuck abort says so', async () => {
    const t = setup();
    t.proc.request.mockImplementation(async (type: string) => {
      if (type === 'prompt') throw new Error('Agent is already processing');
      return {};
    });
    await expect(t.adapter.sendMessage(t.sid, 'hello')).rejects.toThrow('already processing');
    expect(logged('warn', 'pi prompt request failed')).toEqual([expect.objectContaining({ afterStuckAbort: true })]);
  });

  it('logs a user Stop at info with how long the turn ran', async () => {
    vi.useFakeTimers();
    const t = setup();
    vi.advanceTimersByTime(42_000);
    await t.adapter.abortSession(t.sid);
    expect(logged('info', 'pi turn aborted')).toEqual([expect.objectContaining({
      sessionId: 's', turnId: 'turn-1', elapsedMs: 42_000, turnWasOpen: true, backgroundRunsStopped: 0,
    })]);
  });

  it('logs each pi process start', () => {
    const t = setup();
    Object.assign(t.adapter, { persistMeta: () => {}, ensureToolsExtension: () => '/unused/tools.ts' });
    vi.spyOn(PiRpcProcess.prototype, 'start').mockImplementation(() => {});
    (t.adapter as unknown as { spawn(id: string, cwd: string, model: string, mode: 'auto'): unknown }).spawn('s2', '/unused', 'fake/model', 'auto');
    expect(logged('info', 'pi process started')).toEqual([expect.objectContaining({ sessionId: 's2', model: 'fake/model', resume: false, livePiProcesses: 1 })]);
  });

  it('logs an unexpected pi process exit', () => {
    const t = setup();
    Object.assign(t.proc, { crashReason: () => undefined });
    (t.adapter as unknown as { handleProcessExit(id: string, s: unknown, code: number): void }).handleProcessExit(t.sid, t.session, 137);
    expect(logged('info', 'pi process exited unexpectedly')).toEqual([expect.objectContaining({
      sessionId: 's', turnId: 'turn-1', code: 137, turnOpen: true, replaced: false,
    })]);
  });
});
