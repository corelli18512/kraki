/**
 * pi-subagents background (async) runs: the run settles with a receipt
 * ("started"), the subagents keep working, and pi wakes the agent with their
 * results in a new run. The Kraki turn must stay open for that answer —
 * live-trace order from pi 0.87.1 + pi-subagents 0.76.1.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiAdapter } from '../adapters/pi.js';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

afterEach(() => vi.useRealTimers());

function setup() {
  const adapter = new PiAdapter({ cliPath: '/unused' });
  const sid = 's';
  const proc = { alive: true, request: vi.fn().mockResolvedValue({}), kill: vi.fn(), sendRaw: vi.fn() };
  const session = {
    proc, logicalTurn: 1, settledTurn: undefined as number | undefined,
    relayTurnId: 'turn-1', eventTurnId: 'turn-1',
    pendingPerms: new Map(), pendingQuestions: new Map(),
    narrationSegments: 0, toolSinceLastNarration: false, lastNarration: '', lastStopReason: undefined as string | undefined,
    pendingError: undefined, pendingMaintenanceIdle: false, pendingNarration: '', aborting: false,
    usage: {}, lastActivity: Date.now(), exitObserved: false, mode: 'auto',
  };
  const internal = adapter as unknown as {
    sessions: Map<string, typeof session>;
    handleEvent: (id: string, event: Record<string, unknown>) => Promise<void>;
  };
  internal.sessions.set(sid, session);
  const calls: Array<[string, unknown]> = [];
  for (const k of ['onMessage', 'onIdle', 'onNarrationTrace', 'onToolStart', 'onToolComplete', 'onNarration', 'onError'] as const) {
    (adapter as unknown as Record<string, unknown>)[k] = (_sid: string, e: unknown) => calls.push([k, e]);
  }
  (adapter as unknown as { refreshUsage: () => Promise<void> }).refreshUsage = async () => {};
  const emit = (event: Record<string, unknown>) => internal.handleEvent(sid, event);
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
});
