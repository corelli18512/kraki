/**
 * pi-subagents background (async) runs: the run settles with a receipt
 * ("started"), the subagents keep working, and pi wakes the agent with their
 * results in a new run. The Kraki turn must stay open for that answer —
 * live-trace order from pi 0.87.1 + pi-subagents 0.76.1.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiAdapter } from '../adapters/pi.js';
import { handleEvent } from '../adapters/pi-events.js';
import { PiRpcProcess } from '../adapters/pi-rpc.js';
import type { PiSession } from '../adapters/pi-session.js';
import { turnFixture } from './helpers/turn-fixture.js';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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
  };
  const internal = adapter as unknown as {
    sessions: Map<string, typeof session>;
  };
  internal.sessions.set(sid, session);
  const calls: Array<[string, unknown]> = [];
  for (const k of ['onMessage', 'onIdle', 'onNarrationTrace', 'onToolStart', 'onToolComplete', 'onNarration', 'onError'] as const) {
    (adapter as unknown as Record<string, unknown>)[k] = (_sid: string, e: unknown) => calls.push([k, e]);
  }
  (adapter as unknown as { refreshUsage: () => Promise<void> }).refreshUsage = async () => {};
  const emit = (event: Record<string, unknown>) => handleEvent(adapter, sid, event);
  const assistant = async (text: string, stopReason = 'stop') => {
    await emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    await emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason } });
  };
  const launch = async (id: string, runId: string) => {
    await emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'subagent', args: { agent: 'scout', task: 'Find it', async: true } });
    await emit({ type: 'tool_execution_end', toolCallId: id, toolName: 'subagent', isError: false, result: {
      content: [{ type: 'text', text: `Async: scout [${runId}]\nThe async run is detached and running in the background.` }],
      details: { runId },
    } });
  };
  const settle = async () => { await emit({ type: 'agent_end', willRetry: false }); await emit({ type: 'agent_settled' }); };
  const snapshot = (runs: Array<{ id: string; state: string }>) => emit({
    type: 'extension_ui_request', id: `w${Math.random()}`, method: 'setWidget', widgetKey: 'subagent-async',
    widgetLines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({ kind: 'pi-subagents.async-status-snapshot', version: 1, runs })}`],
  });
  const notify = (text: string) => emit({ type: 'message_end', message: { role: 'custom', customType: 'subagent-notify', content: text } });
  const of = (k: string) => calls.filter(([c]) => c === k).map(([, e]) => e);
  return { adapter, sid, proc, session, emit, assistant, launch, settle, snapshot, notify, of };
}

describe('pi background subagents', () => {
  it('holds the turn until pi wakes the agent with the result', async () => {
    const t = setup();
    await t.emit({ type: 'agent_start' });
    await t.launch('D', 'run-1');
    await t.assistant('started');
    await t.settle();
    expect(t.of('onIdle')).toHaveLength(0);
    expect(t.adapter.isTurnSettled(t.sid)).toBe(false);
    expect(t.of('onNarrationTrace')).toEqual([expect.objectContaining({ content: 'started' })]);
    await t.snapshot([{ id: 'run-1', state: 'running' }]);
    // Pi delivers the notification, then wakes the agent.
    await t.notify('Background task completed: **scout**\n\nsrc/a.ts: purple');
    await t.emit({ type: 'agent_start' });
    await t.assistant('src/a.ts: purple');
    await t.settle();
    expect(t.of('onMessage')).toEqual([{ content: 'src/a.ts: purple', turnId: 'turn-1' }]);
    expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }]);
    // The dispatch step stayed open at launch and completes with the report.
    const done = t.of('onToolComplete') as Array<{ toolCallId: string; result: string; subagent?: { status: string } }>;
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ toolCallId: 'D', result: 'Background task completed: **scout**\n\nsrc/a.ts: purple', subagent: { status: 'completed' } });
  });

  it('settles after a grace period when runs end but no wake run comes', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.emit({ type: 'agent_start' });
    await t.launch('D', 'run-1');
    await t.assistant('started');
    await t.settle();
    await t.snapshot([{ id: 'run-1', state: 'failed' }]);
    expect(t.of('onIdle')).toHaveLength(0);
    vi.advanceTimersByTime(PiAdapter.SUBAGENT_CONTINUATION_GRACE_MS + 1);
    expect(t.of('onIdle')).toHaveLength(1);
  });

  it('stop while held stops the background runs and settles silently', async () => {
    const t = setup();
    await t.emit({ type: 'agent_start' });
    await t.launch('D', 'run-1');
    await t.assistant('started');
    await t.settle();
    await t.adapter.abortSession(t.sid);
    expect(t.proc.request).toHaveBeenCalledWith('prompt', { message: '/subagents-stop run-1' }, { timeoutMs: 10_000 });
    expect(t.adapter.isTurnSettled(t.sid)).toBe(true);
    expect(t.of('onIdle')).toHaveLength(0);
  });

  describe.each(['stop', 'replacement'] as const)('%s timer cleanup', retirement => {
    it.each(['grace', 'hold'] as const)('cancels the %s timer synchronously before process teardown or replacement', async timer => {
      vi.useFakeTimers();
      const t = setup();
      await t.emit({ type: 'agent_start' });
      await t.launch('D', 'run-1');
      await t.settle();
      if (timer === 'grace') await t.snapshot([{ id: 'run-1', state: 'failed' }]);
      const original = t.adapter.sessions.get(t.sid)!;
      expect(original.awaitingSubagents).toBe(true);
      expect(original.subagentHoldTimer).toBeDefined();
      if (timer === 'grace') expect(original.subagentGrace).toBeDefined();
      const tracker = t.adapter.subagentTracker(t.sid);
      const retirePending = vi.spyOn(tracker, 'retirePending');
      const steps = vi.spyOn(t.adapter, 'emitSubagentSteps');
      const completions = t.of('onToolComplete');
      const timerState = () => [original.awaitingSubagents, original.subagentGrace, original.subagentHoldTimer];
      let stateAtProcessBoundary: unknown[] | undefined;
      let stopping: Promise<void> | undefined;
      let replacement: PiSession | undefined;
      try {
        if (retirement === 'stop') {
          t.proc.kill.mockImplementation(() => { stateAtProcessBoundary = timerState(); });
          stopping = t.adapter.stop();
        } else {
          // Exercise the real spawn path without starting Pi or writing files.
          Object.assign(t.adapter, { persistMeta: () => {}, ensureToolsExtension: () => '/unused/tools.ts' });
          vi.spyOn(PiRpcProcess.prototype, 'start').mockImplementation(() => { stateAtProcessBoundary = timerState(); });
          const spawn = (t.adapter as unknown as {
            spawn: (id: string, cwd: string, model: string, mode: 'auto') => PiSession;
          }).spawn.bind(t.adapter);
          replacement = spawn(t.sid, '/unused', 'fake/model', 'auto');
          replacement.turn.beginTurn({ captureNow: true });
        }
        // Check before yielding: retirement must not leave either timer armed.
        expect(stateAtProcessBoundary).toEqual([false, undefined, undefined]);
        expect(timerState()).toEqual([false, undefined, undefined]);
        expect(vi.getTimerCount()).toBe(0);
        await stopping;
        await vi.advanceTimersByTimeAsync(PiAdapter.SUBAGENT_HOLD_IDLE_MS);
        expect(original.turn.isSettled).toBe(false);
        if (replacement) {
          expect(t.adapter.sessions.get(t.sid)).toBe(replacement);
          expect(replacement.turn.isSettled).toBe(false);
        }
        expect(retirePending).not.toHaveBeenCalled();
        expect(steps).not.toHaveBeenCalled();
        expect(t.of('onIdle')).toEqual([]);
        expect(t.of('onMessage')).toEqual([]);
        expect(t.of('onToolComplete')).toEqual(completions);
      } finally {
        await stopping;
        t.adapter.stopAwaitingSubagents(original);
      }
    });
  });

  it('a foreground subagent settles normally', async () => {
    const t = setup();
    await t.emit({ type: 'agent_start' });
    await t.emit({ type: 'tool_execution_start', toolCallId: 'D', toolName: 'subagent', args: { agent: 'scout', task: 'T' } });
    await t.emit({ type: 'tool_execution_end', toolCallId: 'D', toolName: 'subagent', isError: false, result: { content: [{ type: 'text', text: 'found' }], details: { results: [] } } });
    await t.assistant('answer');
    await t.settle();
    expect(t.of('onMessage')).toEqual([{ content: 'answer', turnId: 'turn-1' }]);
    expect(t.of('onIdle')).toHaveLength(1);
    expect(t.of('onToolComplete')[0]).toMatchObject({ toolCallId: 'D', subagent: { name: 'scout', status: 'completed' } });
  });

  // pi-subagents 0.76.1 batches completions landing within ~1s into one
  // notice (notify.js formatGroupedCompletion); this is its exact output.
  const grouped = [
    'Background tasks completed (2): **scout**, **reviewer**',
    '',
    '1. scout',
    'src/a.ts: purple',
    '',
    '2. reviewer',
    'looks good',
  ].join('\n');

  const launchAs = async (t: ReturnType<typeof setup>, id: string, runId: string, agent: string) => {
    await t.emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'subagent', args: { agent, task: 'T', async: true } });
    await t.emit({ type: 'tool_execution_end', toolCallId: id, toolName: 'subagent', isError: false, result: {
      content: [{ type: 'text', text: `Async: ${agent} [${runId}]` }], details: { runId },
    } });
  };

  const nextTurn = async (t: ReturnType<typeof setup>, turnId: string) => {
    t.adapter.setTurnIdentity(t.sid, turnId);
    t.session.turn.beginTurn();
    await t.emit({ type: 'agent_start' });
    await t.assistant('next answer');
    await t.settle();
  };

  it('a grouped completion finishes every run in it, and later turns are not held', async () => {
    const t = setup();
    await t.emit({ type: 'agent_start' });
    await launchAs(t, 'D1', 'run-1', 'scout');
    await launchAs(t, 'D2', 'run-2', 'reviewer');
    await t.assistant('started both');
    await t.settle();
    await t.snapshot([{ id: 'run-1', state: 'running' }, { id: 'run-2', state: 'running' }]);
    await t.notify(grouped);
    // The widget clears once no background run remains.
    await t.emit({ type: 'extension_ui_request', id: 'w-clear', method: 'setWidget', widgetKey: 'subagent-async', widgetLines: [] });
    await t.emit({ type: 'agent_start' });
    await t.assistant('both done');
    await t.settle();
    expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }]);
    const done = t.of('onToolComplete') as Array<{ toolCallId: string; result: string; subagent?: { status: string } }>;
    expect(done.map((d) => [d.toolCallId, d.result, d.subagent?.status])).toEqual([
      ['D1', '1. scout\nsrc/a.ts: purple', 'completed'],
      ['D2', '2. reviewer\nlooks good', 'completed'],
    ]);

    await nextTurn(t, 'turn-2');
    expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }, { turnId: 'turn-2' }]);
  });

  it('a run that was listed and then left the snapshot no longer holds turns', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.emit({ type: 'agent_start' });
    await launchAs(t, 'D1', 'run-1', 'scout');
    await launchAs(t, 'D2', 'run-2', 'reviewer');
    await t.settle();
    await t.snapshot([{ id: 'run-1', state: 'running' }, { id: 'run-2', state: 'running' }]);
    // Only one notice ever arrives; then the widget clears.
    await t.notify('Background task completed: **scout**\n\nfound it');
    await t.emit({ type: 'extension_ui_request', id: 'w-clear', method: 'setWidget', widgetKey: 'subagent-async', widgetLines: [] });
    vi.advanceTimersByTime(PiAdapter.SUBAGENT_CONTINUATION_GRACE_MS + 1);
    expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }]);
    await nextTurn(t, 'turn-2');
    expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }, { turnId: 'turn-2' }]);
  });

  it('the hold settles when background runs report nothing for too long', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.emit({ type: 'agent_start' });
    await t.launch('D', 'run-1');
    await t.settle();
    await t.snapshot([{ id: 'run-1', state: 'running' }]);
    vi.advanceTimersByTime(PiAdapter.SUBAGENT_HOLD_IDLE_MS - 1);
    // Activity restarts the bound.
    await t.snapshot([{ id: 'run-1', state: 'running' }]);
    vi.advanceTimersByTime(PiAdapter.SUBAGENT_HOLD_IDLE_MS - 1);
    expect(t.of('onIdle')).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }]);
    expect(t.of('onToolComplete')).toEqual([expect.objectContaining({ toolCallId: 'D', success: false, subagent: expect.objectContaining({ status: 'stopped' }) })]);
    await nextTurn(t, 'turn-2');
    expect(t.of('onIdle')).toHaveLength(2);
  });

  it('after Stop, the stopped runs do not hold the next turn', async () => {
    const t = setup();
    await t.emit({ type: 'agent_start' });
    await t.launch('D', 'run-1');
    await t.settle();
    await t.adapter.abortSession(t.sid);
    expect(t.adapter.subagentTracker(t.sid).activeAsyncRuns()).toBe(0);
    await nextTurn(t, 'turn-2');
    expect(t.of('onIdle')).toEqual([{ turnId: 'turn-2' }]);
  });

  it('a pi process exit retires its background runs: the next turn is not held', async () => {
    const t = setup();
    await t.emit({ type: 'agent_start' });
    await t.launch('D', 'run-1');
    await t.settle();
    Object.assign(t.proc, { crashReason: () => undefined });
    (t.adapter as unknown as { handleProcessExit: (id: string, s: unknown, code: number) => void }).handleProcessExit(t.sid, t.session, 1);
    expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }]);
    expect(t.session.awaitingSubagents).toBe(false);
    expect(t.adapter.subagentTracker(t.sid).activeAsyncRuns()).toBe(0);
    await nextTurn(t, 'turn-2');
    expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }, { turnId: 'turn-2' }]);
  });
});
