/**
 * Reproduction (session mvgrwp01-61e1mlh9, 2026-11-05): a held turn settles by
 * no_progress_timeout while a background run is still alive (a 7 h worker that
 * reported nothing new for 30 min). Pi later wakes the agent with subagent
 * results — several times — with no new user prompt. Every one of those wake
 * runs' prose must reach Kraki; on main they are dropped silently.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiAdapter } from '../adapters/pi.js';
import { handleEvent } from '../adapters/pi-events.js';
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
  (adapter as unknown as { sessions: Map<string, typeof session> }).sessions.set(sid, session);
  const calls: Array<[string, unknown]> = [];
  for (const k of ['onMessage', 'onIdle', 'onNarrationTrace', 'onToolStart', 'onToolComplete', 'onNarration', 'onError'] as const) {
    (adapter as unknown as Record<string, unknown>)[k] = (_sid: string, e: unknown) => calls.push([k, e]);
  }
  (adapter as unknown as { refreshUsage: () => Promise<void> }).refreshUsage = async () => {};
  // RelayClient's side of the hook (relay/turns.ts beginAgentInitiatedTurn):
  // allocate a fresh id and assign it before returning it.
  let wakeTurns = 0;
  adapter.onAgentInitiatedTurn = (id) => {
    const turnId = `wake-${++wakeTurns}`;
    calls.push(['onAgentInitiatedTurn', turnId]);
    adapter.setTurnIdentity(id, turnId);
    return turnId;
  };
  const emit = (event: Record<string, unknown>) => handleEvent(adapter, sid, event);
  const assistant = async (text: string) => {
    await emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    await emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
  };
  const launch = async (id: string, runId: string) => {
    await emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'subagent', args: { agent: 'worker', task: 'Fix it', async: true } });
    await emit({ type: 'tool_execution_end', toolCallId: id, toolName: 'subagent', isError: false, result: {
      content: [{ type: 'text', text: `Async: worker [${runId}]\nThe async run is detached and running in the background.` }],
      details: { runId },
    } });
  };
  const settle = async () => { await emit({ type: 'agent_end', willRetry: false }); await emit({ type: 'agent_settled' }); };
  const snapshot = (runs: Array<{ id: string; state: string }>) => emit({
    type: 'extension_ui_request', id: `w${Math.random()}`, method: 'setWidget', widgetKey: 'subagent-async',
    widgetLines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({ kind: 'pi-subagents.async-status-snapshot', version: 1, generatedAt: Date.now(), runs })}`],
  });
  const notify = (text: string) => emit({ type: 'message_end', message: { role: 'custom', customType: 'subagent-notify', content: text } });
  const of = (k: string) => calls.filter(([c]) => c === k).map(([, e]) => e);
  return { adapter, sid, emit, assistant, launch, settle, snapshot, notify, of };
}

describe('pi wake runs after the background hold timed out', () => {
  it('relays every later wake run (no new prompt) instead of dropping it', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.emit({ type: 'agent_start' });
    await t.launch('D', 'run-long');
    await t.assistant('Started the last lane.');
    await t.settle();
    await t.snapshot([{ id: 'run-long', state: 'running' }]);
    // The long run reports nothing new for 30 min: the hold gives up.
    vi.advanceTimersByTime(PiAdapter.SUBAGENT_HOLD_IDLE_MS + 1);
    expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }]);
    expect(t.of('onMessage')).toEqual([]); // the timed-out turn had no reply (shown as no_reply)

    // Hours later the run finishes; pi wakes the agent on its own.
    await t.notify('Background task completed: **worker**\n\nPR #636 opened');
    await t.emit({ type: 'agent_start' });
    await t.assistant('All 26 lanes are done: PR #636 is the last one.');
    await t.settle();
    // A second wake (another notification), still no user prompt.
    await t.notify('Subagent needs a supervisor decision.');
    await t.emit({ type: 'agent_start' });
    await t.assistant('355 issues handled; everything is in PR #637.');
    await t.settle();

    // Evidence: what the adapter emitted for the two wake runs.
    if (process.env.REPRO_DUMP) console.log(JSON.stringify({ narration: t.of('onNarration'), message: t.of('onMessage'), idle: t.of('onIdle'), settled: t.adapter.isTurnSettled(t.sid) }, null, 1));
    const replies = (t.of('onMessage') as Array<{ content: string }>).map(m => m.content);
    expect(replies).toEqual([
      'All 26 lanes are done: PR #636 is the last one.',
      '355 issues handled; everything is in PR #637.',
    ]);
    // Each wake run is its own settled turn: an idle after each reply.
    expect(t.of('onIdle')).toHaveLength(3);
    // ... each with its own turn id, on everything it emitted.
    expect(t.of('onAgentInitiatedTurn')).toEqual(['wake-1', 'wake-2']);
    expect(t.of('onMessage')).toEqual([
      { content: 'All 26 lanes are done: PR #636 is the last one.', turnId: 'wake-1' },
      { content: '355 issues handled; everything is in PR #637.', turnId: 'wake-2' },
    ]);
    expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }, { turnId: 'wake-1' }, { turnId: 'wake-2' }]);
    expect((t.of('onNarration') as Array<{ turnId?: string }>).map(n => n.turnId)).toEqual(['turn-1', 'wake-1', 'wake-2']);
    expect(t.adapter.isTurnSettled(t.sid)).toBe(true);
  });
});
