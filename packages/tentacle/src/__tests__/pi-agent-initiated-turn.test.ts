/**
 * A run pi starts on its own while no Kraki turn is open (PiAdapter
 * beginAgentInitiatedTurn → AgentAdapter.onAgentInitiatedTurn → RelayClient
 * relay/turns.ts beginAgentInitiatedTurn) becomes a new Kraki turn. Typical
 * case: the background-subagent hold timed out (no_progress_timeout) and a
 * still-running background run later completes and wakes the agent.
 *
 * Covered here: the runs that must NOT open a turn (Kraki-submitted prompt,
 * follow_up, steer-as-prompt, prompt preflight, steer awaiting its ACK, retry,
 * a held turn's wake run, duplicate agent_start, Stop, process exit, Relay
 * declining), a wake turn holding for its own background runs, and the
 * RelayClient path end to end on a real SessionManager.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiAdapter } from '../adapters/pi.js';
import { handleEvent } from '../adapters/pi-events.js';
import type { PiSession } from '../adapters/pi-session.js';
import { SessionManager } from '../session-manager.js';
import { AttachmentStore } from '../attachment-store.js';
import { RelayClient } from '../relay-client.js';
import { handleConsumerMessage } from '../relay/consumer-messages.js';
import { beginAdapterTurn } from '../relay/turns.js';
import { closeTurnLostInRestart } from '../relay/session-resume.js';
import { turnFixture } from './helpers/turn-fixture.js';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

/** Adapter-level fixture: turn-1 is open and running. `hook` is RelayClient's
 *  side of onAgentInitiatedTurn (assigns the id via setTurnIdentity). */
function setup(opts: { decline?: boolean } = {}) {
  const adapter = new PiAdapter({ cliPath: '/unused', promptWatchdog: { ackGraceMs: 5, intervalMs: 5 } });
  const sid = 's';
  const proc = { alive: true, request: vi.fn().mockResolvedValue({}), kill: vi.fn(), sendRaw: vi.fn(), crashReason: () => undefined };
  const session = {
    proc, turn: turnFixture(adapter, sid, { open: true, relayTurnId: 'turn-1', eventTurnId: 'turn-1' }),
    pendingPerms: new Map(), pendingQuestions: new Map(),
    lastStopReason: undefined as string | undefined,
    pendingMaintenanceIdle: false, aborting: false,
    usage: {}, lastActivity: Date.now(), exitObserved: false, mode: 'auto',
  };
  (adapter as unknown as { sessions: Map<string, typeof session> }).sessions.set(sid, session);
  const pi = session as unknown as PiSession;
  const calls: Array<[string, unknown]> = [];
  for (const k of ['onMessage', 'onIdle', 'onNarrationTrace', 'onToolStart', 'onToolComplete', 'onNarration', 'onError'] as const) {
    (adapter as unknown as Record<string, unknown>)[k] = (_sid: string, e: unknown) => calls.push([k, e]);
  }
  (adapter as unknown as { refreshUsage: () => Promise<void> }).refreshUsage = async () => {};
  let n = 0;
  const hook = vi.fn((id: string) => {
    if (opts.decline) return undefined;
    const turnId = `agent-${++n}`;
    adapter.setTurnIdentity(id, turnId);
    return turnId;
  });
  adapter.onAgentInitiatedTurn = hook;
  const emit = (event: Record<string, unknown>) => handleEvent(adapter, sid, event);
  const assistant = async (text: string, stopReason = 'stop') => {
    await emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    await emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason } });
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
  /** turn-1 answered plainly and settled: no hold, nothing pending. */
  const settledTurn = async () => {
    await emit({ type: 'agent_start' });
    await assistant('done');
    await settle();
    expect(adapter.isTurnSettled(sid)).toBe(true);
  };
  /** turn-1 launched a background run and its hold timed out (091e0242). */
  const timedOutHold = async (runId = 'run-long') => {
    vi.useFakeTimers();
    await emit({ type: 'agent_start' });
    await launch('D', runId);
    await assistant('Started the last lane.');
    await settle();
    await snapshot([{ id: runId, state: 'running' }]);
    vi.advanceTimersByTime(PiAdapter.SUBAGENT_HOLD_IDLE_MS + 1);
    expect(of('onIdle')).toEqual([{ turnId: 'turn-1' }]);
  };
  return { adapter, sid, proc, session: pi, hook, emit, assistant, launch, settle, snapshot, notify, of, settledTurn, timedOutHold };
}

describe('pi agent-initiated run → new Kraki turn', () => {
  it('a wake turn can hold for its own background runs; that hold still times out', async () => {
    const t = setup();
    await t.timedOutHold();
    await t.notify('Background task completed: **worker**\n\nlane 25 done');
    await t.emit({ type: 'agent_start' });
    await t.launch('E', 'run-next');
    await t.assistant('Started lane 26.');
    await t.settle();
    // Held: no reply and no idle for agent-1 yet.
    expect(t.session.awaitingSubagents).toBe(true);
    expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }]);
    // A wake run while held continues agent-1 (no new turn).
    await t.snapshot([{ id: 'run-next', state: 'running' }]);
    await t.notify('Background task completed: **worker**\n\nlane 26 done');
    await t.emit({ type: 'agent_start' });
    await t.launch('F', 'run-hung');
    await t.settle();
    expect(t.hook).toHaveBeenCalledTimes(1);
    // That run hangs: the 30-min bound settles agent-1 (no hold forever).
    await t.snapshot([{ id: 'run-hung', state: 'running' }]);
    vi.advanceTimersByTime(PiAdapter.SUBAGENT_HOLD_IDLE_MS + 1);
    expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }, { turnId: 'agent-1' }]);
    expect(t.session.awaitingSubagents).toBe(false);
    // ...and its late completion is again a turn of its own.
    await t.notify('Background task completed: **worker**\n\nfinally');
    await t.emit({ type: 'agent_start' });
    await t.assistant('Lane 27 finished late.');
    await t.settle();
    expect(t.of('onMessage')).toEqual([{ content: 'Lane 27 finished late.', turnId: 'agent-2' }]);
    expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }, { turnId: 'agent-1' }, { turnId: 'agent-2' }]);
  });

  it('a wake after the finished-without-wake grace settled the hold also gets a turn', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.emit({ type: 'agent_start' });
    await t.launch('D', 'run-1');
    await t.settle();
    await t.snapshot([{ id: 'run-1', state: 'complete' }]);
    vi.advanceTimersByTime(PiAdapter.SUBAGENT_CONTINUATION_GRACE_MS + 1);
    expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }]);
    await t.emit({ type: 'agent_start' });
    await t.assistant('Late result.');
    await t.settle();
    expect(t.of('onMessage')).toEqual([{ content: 'Late result.', turnId: 'agent-1' }]);
    expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }, { turnId: 'agent-1' }]);
  });

  describe('runs that are not agent-initiated open no turn', () => {
    it('a held turn\'s wake run continues that turn', async () => {
      const t = setup();
      await t.emit({ type: 'agent_start' });
      await t.launch('D', 'run-1');
      await t.settle();
      await t.notify('Background task completed: **worker**\n\nok');
      await t.emit({ type: 'agent_start' });
      await t.assistant('ok');
      await t.settle();
      expect(t.hook).not.toHaveBeenCalled();
      expect(t.of('onMessage')).toEqual([{ content: 'ok', turnId: 'turn-1' }]);
    });

    it.each([
      ['prompt', undefined],
      ['follow_up', { delivery: 'follow_up' as const }],
      ['steer after the turn settled (steer-as-prompt)', { delivery: 'steer' as const }],
    ])('a Kraki %s', async (_name, options) => {
      const t = setup();
      await t.settledTurn();
      t.adapter.setTurnIdentity(t.sid, 'turn-2');
      await t.adapter.sendMessage(t.sid, 'next', undefined, options);
      await t.emit({ type: 'agent_start' });
      await t.assistant('next answer');
      await t.settle();
      expect(t.hook).not.toHaveBeenCalled();
      expect(t.of('onMessage')).toEqual([{ content: 'done', turnId: 'turn-1' }, { content: 'next answer', turnId: 'turn-2' }]);
    });

    it('a Kraki prompt still in preflight (agent_start before its ACK)', async () => {
      const t = setup();
      await t.settledTurn();
      const ack = deferred();
      t.proc.request.mockImplementation((type: string) => type === 'prompt' ? ack.promise : Promise.resolve({}));
      t.adapter.setTurnIdentity(t.sid, 'turn-2');
      const sending = t.adapter.sendMessage(t.sid, 'next');
      await t.emit({ type: 'compaction_start', reason: 'threshold' });
      await t.emit({ type: 'compaction_end', reason: 'threshold', willRetry: false });
      await t.emit({ type: 'agent_start' });
      ack.resolve({});
      await sending;
      await t.assistant('next answer');
      await t.settle();
      expect(t.hook).not.toHaveBeenCalled();
      expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }, { turnId: 'turn-2' }]);
    });

    it('a steer whose ACK is pending when the turn settles (pi may run the steer itself)', async () => {
      const t = setup();
      await t.emit({ type: 'agent_start' });
      const ack = deferred();
      t.proc.request.mockImplementation((type: string) => type === 'prompt' ? ack.promise : Promise.resolve({}));
      const steering = t.adapter.sendMessage(t.sid, 'also this', undefined, { delivery: 'steer' });
      await t.assistant('done');
      await t.settle();
      await t.emit({ type: 'agent_start' });
      expect(t.hook).not.toHaveBeenCalled();
      ack.resolve({});
      await steering;
      expect(t.session.steersInFlight).toBe(0);
    });

    it('a provider retry (agent_end willRetry) of the open turn', async () => {
      const t = setup();
      await t.emit({ type: 'agent_start' });
      await t.assistant('', 'error');
      await t.emit({ type: 'agent_end', willRetry: true });
      await t.emit({ type: 'agent_start' });
      await t.assistant('recovered');
      await t.settle();
      expect(t.hook).not.toHaveBeenCalled();
      expect(t.of('onMessage')).toEqual([{ content: 'recovered', turnId: 'turn-1' }]);
    });

    it('a duplicate agent_start of a run that settled its turn early (threshold compaction)', async () => {
      const t = setup();
      await t.emit({ type: 'agent_start' });
      await t.assistant('answer');
      await t.emit({ type: 'agent_end', willRetry: false });
      await t.emit({ type: 'compaction_start', reason: 'threshold' });
      expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }]);
      await t.emit({ type: 'agent_start' });
      await t.emit({ type: 'compaction_end', reason: 'threshold', willRetry: false });
      await t.emit({ type: 'agent_settled' });
      expect(t.hook).not.toHaveBeenCalled();
      expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }]);
      // Once that run settled, a genuine new run is agent-initiated.
      await t.emit({ type: 'agent_start' });
      expect(t.hook).toHaveBeenCalledTimes(1);
    });

    it('after Stop: the stopped background runs waking the agent stay dropped until the next input', async () => {
      const t = setup();
      await t.emit({ type: 'agent_start' });
      await t.launch('D', 'run-1');
      await t.settle();
      await t.adapter.abortSession(t.sid);
      expect(t.proc.request).toHaveBeenCalledWith('prompt', { message: '/subagents-stop run-1' }, { timeoutMs: 10_000 });
      await t.emit({ type: 'agent_start' });
      await t.assistant('The worker was stopped.');
      await t.settle();
      expect(t.hook).not.toHaveBeenCalled();
      // Stamped with the stopped turn: RelayClient drops it as late.
      expect(t.of('onNarration')).toEqual([{ content: 'The worker was stopped.', turnId: 'turn-1' }]);
      expect(t.of('onMessage')).toEqual([]);
      expect(t.of('onIdle')).toEqual([]);
      // The user's next prompt lifts it: a later agent-initiated run gets a turn.
      t.adapter.setTurnIdentity(t.sid, 'turn-2');
      await t.adapter.sendMessage(t.sid, 'next');
      await t.emit({ type: 'agent_start' });
      await t.assistant('next answer');
      await t.settle();
      await t.emit({ type: 'agent_start' });
      expect(t.hook).toHaveBeenCalledTimes(1);
    });

    it('during Stop (agent_start while the abort is in flight)', async () => {
      const t = setup();
      await t.settledTurn();
      const abortAck = deferred();
      t.proc.request.mockImplementation((type: string) => type === 'abort' ? abortAck.promise : Promise.resolve({}));
      const stopping = t.adapter.abortSession(t.sid);
      await t.emit({ type: 'agent_start' });
      abortAck.resolve({});
      await stopping;
      expect(t.hook).not.toHaveBeenCalled();
    });

    it('a process that exited', async () => {
      const t = setup();
      await t.emit({ type: 'agent_start' });
      await t.launch('D', 'run-1');
      await t.settle();
      (t.adapter as unknown as { handleProcessExit: (id: string, s: unknown, code: number) => void }).handleProcessExit(t.sid, t.session, 1);
      await t.emit({ type: 'agent_start' });
      expect(t.hook).not.toHaveBeenCalled();
    });

    it('compaction maintenance after a settled turn (no agent_start)', async () => {
      const t = setup();
      await t.settledTurn();
      await t.emit({ type: 'compaction_start', reason: 'manual' });
      await t.emit({ type: 'compaction_end', reason: 'manual', willRetry: false });
      expect(t.hook).not.toHaveBeenCalled();
      expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }]);
    });

    it('RelayClient declines: the run keeps the settled turn id (dropped as before)', async () => {
      const t = setup({ decline: true });
      await t.settledTurn();
      await t.emit({ type: 'agent_start' });
      await t.assistant('unrelayed');
      await t.settle();
      expect(t.hook).toHaveBeenCalledTimes(1);
      expect(t.adapter.isTurnSettled(t.sid)).toBe(true);
      expect(t.of('onNarration')).toEqual([{ content: 'done', turnId: 'turn-1' }, { content: 'unrelayed', turnId: 'turn-1' }]);
      expect(t.of('onIdle')).toEqual([{ turnId: 'turn-1' }]);
    });
  });
});

describe('RelayClient: a pi wake run after the hold timed out', () => {
  let dir: string;
  let holdIdleMs: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kraki-pi-wake-'));
    holdIdleMs = PiAdapter.SUBAGENT_HOLD_IDLE_MS;
    PiAdapter.SUBAGENT_HOLD_IDLE_MS = 20;
  });
  afterEach(() => {
    PiAdapter.SUBAGENT_HOLD_IDLE_MS = holdIdleMs;
    rmSync(dir, { recursive: true, force: true });
  });

  function build() {
    const sm = new SessionManager(dir);
    const adapter = new PiAdapter({ cliPath: '/unused', promptWatchdog: { ackGraceMs: 5, intervalMs: 5 }, attachmentStore: new AttachmentStore(dir) });
    adapter.generateTitle = async () => null;
    (adapter as unknown as { refreshUsage: () => Promise<void> }).refreshUsage = async () => {};
    const client = new RelayClient(adapter, sm, {
      relayUrl: 'ws://unused', authMethod: 'open', device: { name: 'Test', role: 'tentacle' },
    });
    const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    vi.spyOn(client, 'sendEncrypted').mockImplementation((msg) => { sent.push(msg as (typeof sent)[number]); });
    const { sessionId } = sm.createSession('pi');
    const proc = { alive: true, request: vi.fn().mockResolvedValue({}), kill: vi.fn(), sendRaw: vi.fn() };
    const session = {
      proc, turn: turnFixture(adapter, sessionId),
      pendingPerms: new Map(), pendingQuestions: new Map(),
      lastStopReason: undefined as string | undefined,
      pendingMaintenanceIdle: false, aborting: false,
      usage: {}, lastActivity: Date.now(), exitObserved: false, mode: 'auto',
    };
    (adapter as unknown as { sessions: Map<string, typeof session> }).sessions.set(sessionId, session);
    const emit = (event: Record<string, unknown>) => handleEvent(adapter, sessionId, event);
    const rows = () => sm.getMessagesAfterSeq(sessionId, 0).map(m => ({
      seq: m.seq, type: m.type, payload: (JSON.parse(m.payload) as { payload: Record<string, unknown> }).payload,
    }));
    return { sm, adapter, client, sessionId, session, emit, sent, rows };
  }

  it('relays the wake reply as agent_message in a new turn: active → reply → idle, unread', async () => {
    const t = build();
    handleConsumerMessage(t.client, { type: 'send_input', sessionId: t.sessionId, deviceId: 'app-1', payload: { text: 'Fix every lane', clientId: 'cid-1' } });
    await vi.waitFor(() => expect(t.session.turn.isSettled).toBe(false));
    const promptTurnId = t.client.activeInputTurnIds.get(t.sessionId)!;
    await t.emit({ type: 'agent_start' });
    await t.emit({ type: 'tool_execution_start', toolCallId: 'D', toolName: 'subagent', args: { agent: 'worker', task: 'T', async: true } });
    await t.emit({ type: 'tool_execution_end', toolCallId: 'D', toolName: 'subagent', isError: false, result: {
      content: [{ type: 'text', text: 'Async: worker [run-long]' }], details: { runId: 'run-long' },
    } });
    await t.emit({ type: 'agent_end', willRetry: false });
    await t.emit({ type: 'agent_settled' });
    expect(t.session.awaitingSubagents).toBe(true);
    // No progress for the (shortened) hold bound: turn 1 settles without a reply.
    await vi.waitFor(() => expect(t.sm.getMeta(t.sessionId)?.state).toBe('idle'));
    expect(t.client.settledAdapterTurnIds.get(t.sessionId)).toBe(promptTurnId);
    t.sm.markRead(t.sessionId, t.sm.getMeta(t.sessionId)!.lastSeq);
    const sentBefore = t.sent.length;

    // Hours later the run finishes and pi wakes the agent on its own.
    await t.emit({ type: 'message_end', message: { role: 'custom', customType: 'subagent-notify', content: 'Background task completed: **worker**\n\nPR #636 opened' } });
    await t.emit({ type: 'agent_start' });
    const wakeTurnId = t.client.activeInputTurnIds.get(t.sessionId)!;
    expect(wakeTurnId).not.toBe(promptTurnId);
    expect(wakeTurnId).toMatch(new RegExp(`^${t.sessionId}:\\d+$`));
    expect(t.sm.getMeta(t.sessionId)?.state).toBe('active');
    await t.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    await t.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'All 26 lanes are done: PR #636.' }], stopReason: 'stop' } });
    await t.emit({ type: 'agent_end', willRetry: false });
    await t.emit({ type: 'agent_settled' });

    const live = t.sent.slice(sentBefore).map(m => m.type).filter(type => type === 'active' || type === 'agent_message' || type === 'idle');
    expect(live).toEqual(['active', 'agent_message', 'idle']);
    const spine = t.rows();
    expect(spine.map(r => r.type)).toEqual(['user_message', 'system_message', 'idle', 'agent_message', 'idle']);
    expect(spine[1].payload).toMatchObject({ kind: 'no_reply' });
    expect(spine[3].payload).toMatchObject({ content: 'All 26 lanes are done: PR #636.' });
    const meta = t.sm.getMeta(t.sessionId)!;
    expect(meta.state).toBe('idle');
    expect(t.client.settledAdapterTurnIds.get(t.sessionId)).toBe(wakeTurnId);
    // The closing idle is an unread boundary, like a prompted reply's.
    expect(meta.readSeq).toBeLessThan(meta.lastSeq);
    expect(t.adapter.isTurnSettled(t.sessionId)).toBe(true);

    // The next user prompt gets a turn id after the wake turn's.
    handleConsumerMessage(t.client, { type: 'send_input', sessionId: t.sessionId, deviceId: 'app-1', payload: { text: 'thanks', clientId: 'cid-2' } });
    await vi.waitFor(() => expect(t.client.activeInputTurnIds.get(t.sessionId)).not.toBe(wakeTurnId));
    const anchor = (id: string) => Number(id.split(':').pop());
    expect(anchor(t.client.activeInputTurnIds.get(t.sessionId)!)).toBeGreaterThan(anchor(wakeTurnId));
  });

  /** A prompt whose turn ended without a reply and went idle. */
  async function idleAfterPrompt(t: ReturnType<typeof build>) {
    handleConsumerMessage(t.client, { type: 'send_input', sessionId: t.sessionId, deviceId: 'app-1', payload: { text: 'go', clientId: 'cid-1' } });
    await vi.waitFor(() => expect(t.session.turn.isSettled).toBe(false));
    await t.emit({ type: 'agent_start' });
    await t.emit({ type: 'tool_execution_start', toolCallId: 'A', toolName: 'bash', args: { command: 'ls' } });
    await t.emit({ type: 'tool_execution_end', toolCallId: 'A', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'x' }] } });
    await t.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' } });
    await t.emit({ type: 'agent_end', willRetry: false });
    await t.emit({ type: 'agent_settled' });
    await vi.waitFor(() => expect(t.client.inputChains.has(t.sessionId)).toBe(false));
  }

  it('a steps-only wake turn gets its own no_reply anchor with its own step count', async () => {
    const t = build();
    await idleAfterPrompt(t);
    await t.emit({ type: 'agent_start' });
    await t.emit({ type: 'tool_execution_start', toolCallId: 'B', toolName: 'bash', args: { command: 'gh pr list' } });
    await t.emit({ type: 'tool_execution_end', toolCallId: 'B', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: '#636' }] } });
    await t.emit({ type: 'agent_end', willRetry: false });
    await t.emit({ type: 'agent_settled' });
    const spine = t.rows();
    expect(spine.map(r => r.type)).toEqual(['user_message', 'agent_message', 'idle', 'system_message', 'idle']);
    expect(spine[3].payload).toMatchObject({ kind: 'no_reply', steps: 1 });
  });

  it('declines while a prompt is queued or dispatching: the run keeps the prompt\'s turn', async () => {
    const t = build();
    handleConsumerMessage(t.client, { type: 'send_input', sessionId: t.sessionId, deviceId: 'app-1', payload: { text: 'go', clientId: 'cid-1' } });
    await vi.waitFor(() => expect(t.session.turn.isSettled).toBe(false));
    const promptTurnId = t.client.activeInputTurnIds.get(t.sessionId)!;
    // An adapter that settled without Relay seeing the idle.
    t.session.turn.settleSilently();
    await t.emit({ type: 'agent_start' });
    expect(t.client.activeInputTurnIds.get(t.sessionId)).toBe(promptTurnId);
    expect(t.session.turn.isSettled).toBe(true);
    expect(t.sent.filter(m => m.type === 'active')).toHaveLength(1);
  });

  it('declines while the next prompt is being dispatched (lazy resume in progress)', async () => {
    const t = build();
    await idleAfterPrompt(t);
    const settledTurnId = t.client.activeInputTurnIds.get(t.sessionId)!;
    t.sm.markDisconnected(t.sessionId);
    const resumed = deferred();
    const resume = vi.spyOn(t.adapter, 'resumeSession').mockImplementation(async (id) => { await resumed.promise; return { sessionId: id }; });
    handleConsumerMessage(t.client, { type: 'send_input', sessionId: t.sessionId, deviceId: 'app-1', payload: { text: 'next', clientId: 'cid-2' } });
    await vi.waitFor(() => expect(resume).toHaveBeenCalled());
    await t.emit({ type: 'agent_start' });
    expect(t.client.activeInputTurnIds.get(t.sessionId)).toBe(settledTurnId);
    expect(t.session.turn.isSettled).toBe(true);
    resumed.resolve(undefined);
    await vi.waitFor(() => expect(t.client.activeInputTurnIds.get(t.sessionId)).not.toBe(settledTurnId));
  });

  it('declines while Relay\'s current turn has not settled', async () => {
    const t = build();
    await idleAfterPrompt(t);
    // A turn Relay opened (e.g. a steer-as-prompt whose dispatch already
    // finished) and has not seen settle.
    beginAdapterTurn(t.client, t.sessionId, `${t.sessionId}:99`);
    await t.emit({ type: 'agent_start' });
    expect(t.client.activeInputTurnIds.get(t.sessionId)).toBe(`${t.sessionId}:99`);
    expect(t.session.turn.isSettled).toBe(true);
    expect(t.sm.getMeta(t.sessionId)?.state).toBe('idle');
  });

  // ── Wake turn W after a prompted turn T1 ──

  const bash = async (t: ReturnType<typeof build>, id: string, command: string) => {
    await t.emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command } });
    await t.emit({ type: 'tool_execution_end', toolCallId: id, toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
  };
  const reply = async (t: ReturnType<typeof build>, text: string) => {
    await t.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
    await t.emit({ type: 'agent_end', willRetry: false });
    await t.emit({ type: 'agent_settled' });
  };
  const commands = (entries: unknown[]) => entries
    .filter(e => (e as { type: string }).type === 'tool_start')
    .map(e => ((e as { payload: { args?: { command?: string } } }).payload.args?.command));
  /** W starts: pi woke the agent on its own after T1 went idle. */
  const startWake = async (t: ReturnType<typeof build>) => {
    const before = t.client.activeInputTurnIds.get(t.sessionId);
    await t.emit({ type: 'agent_start' });
    const wakeTurnId = t.client.activeInputTurnIds.get(t.sessionId)!;
    expect(wakeTurnId).not.toBe(before);
    return wakeTurnId;
  };

  it('W has its own trace key: T1\'s Steps are unchanged, W\'s Steps are only W\'s, W\'s report is a turn artifact', async () => {
    const t = build();
    await idleAfterPrompt(t); // T1: bash `ls`, reply `ok`
    const t1Reply = t.rows().find(r => r.type === 'agent_message')!;
    const t1Before = t.sm.readTurnTrace(t.sessionId, t1Reply.seq);
    expect(commands(t1Before.entries)).toEqual(['ls']);

    await startWake(t);
    await bash(t, 'B', 'gh pr list');
    const html = join(dir, 'report.html');
    writeFileSync(html, '<html><body>355 issues</body></html>');
    await t.emit({ type: 'tool_execution_start', toolCallId: 'R', toolName: 'show_report', args: { path: html } });
    await t.emit({ type: 'tool_execution_end', toolCallId: 'R', toolName: 'show_report', isError: false, result: {
      content: [{ type: 'text', text: 'Report shown.' }], details: { htmlPath: html, title: 'Summary', name: 'summary.html' },
    } });
    await reply(t, '355 issues handled.');

    const spine = t.rows();
    expect(spine.map(r => r.type)).toEqual(['user_message', 'agent_message', 'idle', 'agent_message', 'idle']);
    const wReply = spine[3];
    const wTrace = t.sm.readTurnTrace(t.sessionId, wReply.seq);
    expect(commands(wTrace.entries)).toEqual(['gh pr list', undefined]);
    expect(wTrace.entries.map(e => (e as { payload: { toolName: string } }).payload.toolName)).toEqual(['bash', 'bash', 'show_report', 'show_report']);
    expect(wTrace.complete).toBe(true);
    expect(wReply.payload.steps).toBe(2);
    // T1's trace (pulled again after W) is exactly what it was.
    expect(t.sm.readTurnTrace(t.sessionId, t1Reply.seq)).toEqual(t1Before);
    // W's closing idle carries W's report.
    expect(spine[4].payload.turnArtifacts).toEqual([expect.objectContaining({ type: 'content_ref', mimeType: 'text/html', name: 'summary.html' })]);
    expect(spine[2].payload.turnArtifacts).toBeUndefined();

    // The next prompt starts a new trace turn again.
    handleConsumerMessage(t.client, { type: 'send_input', sessionId: t.sessionId, deviceId: 'app-1', payload: { text: 'thanks', clientId: 'cid-2' } });
    await vi.waitFor(() => expect(t.rows().at(-1)?.type).toBe('user_message'));
    await t.emit({ type: 'agent_start' });
    await bash(t, 'C', 'echo bye');
    await reply(t, 'bye');
    const t3Reply = t.rows().at(-2)!;
    expect(commands(t.sm.readTurnTrace(t.sessionId, t3Reply.seq).entries)).toEqual(['echo bye']);
    expect(commands(t.sm.readTurnTrace(t.sessionId, wReply.seq).entries)).toEqual(['gh pr list', undefined]);

    // The turn starts survive a restart (meta on disk).
    const reloaded = new SessionManager(dir);
    expect(reloaded.getMeta(t.sessionId)?.agentTurnStartSeqs).toEqual([wTrace.turnStartSeq]);
    expect(reloaded.readTurnTrace(t.sessionId, wReply.seq).entries).toEqual(wTrace.entries);
    expect(reloaded.readTurnTrace(t.sessionId, t1Reply.seq)).toEqual(t1Before);
  });

  it('a W turn lost in a restart before writing any row is closed as failed, with its Steps', async () => {
    const t = build();
    await idleAfterPrompt(t);
    await startWake(t);
    await bash(t, 'B', 'gh pr list');
    // The daemon dies here; the next process normalises the session.
    const sm = new SessionManager(dir);
    const client = new RelayClient(t.adapter, sm, { relayUrl: 'ws://unused', authMethod: 'open', device: { name: 'Test', role: 'tentacle' } });
    vi.spyOn(client, 'sendEncrypted').mockImplementation(() => {});
    expect(sm.getMeta(t.sessionId)?.state).toBe('active');
    closeTurnLostInRestart(client, t.sessionId);
    const spine = sm.getMessagesAfterSeq(t.sessionId, 0).map(m => m.type);
    expect(spine).toEqual(['user_message', 'agent_message', 'idle', 'turn_status', 'idle']);
    const failed = sm.getMessagesAfterSeq(t.sessionId, 0)[3];
    expect(commands(sm.readTurnTrace(t.sessionId, failed.seq).entries)).toEqual(['gh pr list']);
  });

  it('a prompt that arrives during W waits for W\'s idle instead of aborting the wake run', async () => {
    const t = build();
    await idleAfterPrompt(t);
    const wakeTurnId = await startWake(t);
    expect(t.client.inputChains.has(t.sessionId)).toBe(true);
    const send = vi.spyOn(t.adapter, 'sendMessage');
    handleConsumerMessage(t.client, { type: 'send_input', sessionId: t.sessionId, deviceId: 'app-1', payload: { text: 'next', clientId: 'cid-2' } });
    await new Promise(r => setTimeout(r, 10));
    // Not persisted, not sent: W still owns the agent.
    expect(send).not.toHaveBeenCalled();
    expect(t.rows().filter(r => r.type === 'user_message')).toHaveLength(1);
    expect(t.client.activeInputTurnIds.get(t.sessionId)).toBe(wakeTurnId);
    await reply(t, 'W done');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(t.rows().map(r => r.type)).toEqual(['user_message', 'agent_message', 'idle', 'agent_message', 'idle', 'user_message']);
    expect(t.rows()[3].payload).toMatchObject({ content: 'W done' });
    expect(t.session.proc.request.mock.calls.filter(c => c[0] === 'abort')).toEqual([]);
    expect(t.client.activeInputTurnIds.get(t.sessionId)).not.toBe(wakeTurnId);
  });

  it('a steer during W joins W: one reply, one idle', async () => {
    const t = build();
    await idleAfterPrompt(t);
    const wakeTurnId = await startWake(t);
    handleConsumerMessage(t.client, { type: 'send_input', sessionId: t.sessionId, deviceId: 'app-1', payload: { text: 'also check CI', clientId: 'cid-s', delivery: 'steer' } });
    await vi.waitFor(() => expect(t.session.proc.request).toHaveBeenCalledWith('prompt', expect.objectContaining({ streamingBehavior: 'steer' }), expect.anything()));
    await vi.waitFor(() => expect(t.client.inputDispatches.has(t.sessionId)).toBe(false));
    expect(t.client.activeInputTurnIds.get(t.sessionId)).toBe(wakeTurnId);
    await reply(t, 'CI green too.');
    expect(t.rows().map(r => r.type)).toEqual(['user_message', 'agent_message', 'idle', 'user_message', 'agent_message', 'idle']);
    expect(t.rows()[3].payload).toMatchObject({ delivery: 'steer' });
    expect(t.client.settledAdapterTurnIds.get(t.sessionId)).toBe(wakeTurnId);
    expect(t.sm.getMeta(t.sessionId)?.state).toBe('idle');
  });

  it('Stop of a W turn (abort_session) ends it as aborted; the stopped runs reporting back stay dropped', async () => {
    const t = build();
    await idleAfterPrompt(t);
    const wakeTurnId = await startWake(t);
    await bash(t, 'B', 'make');
    handleConsumerMessage(t.client, { type: 'abort_session', sessionId: t.sessionId, deviceId: 'app-1', payload: {} });
    await vi.waitFor(() => expect(t.sm.getMeta(t.sessionId)?.state).toBe('idle'));
    expect(t.rows().at(-1)).toMatchObject({ type: 'idle', payload: { reason: 'aborted' } });
    expect(t.client.settledAdapterTurnIds.get(t.sessionId)).toBe(wakeTurnId);
    await vi.waitFor(() => expect(t.client.inputChains.has(t.sessionId)).toBe(false));
    const rowsAfterStop = t.rows().length;
    // A stopped run's notice wakes the agent again: no new turn, nothing relayed.
    await t.emit({ type: 'agent_start' });
    await reply(t, 'The worker was stopped.');
    expect(t.client.activeInputTurnIds.get(t.sessionId)).toBe(wakeTurnId);
    expect(t.rows()).toHaveLength(rowsAfterStop);
  });

  describe('declines when exactly one RelayClient guard is set', () => {
    const guards: Array<[string, (t: ReturnType<typeof build>) => void]> = [
      ['inputChains', t => { t.client.inputChains.set(t.sessionId, new Promise(() => {})); }],
      ['inputDispatches', t => { t.client.inputDispatches.set(t.sessionId, new Promise(() => {})); }],
      ['resumeInFlight', t => { t.client.resumeInFlight.set(t.sessionId, new Promise(() => {})); }],
      ['steerAcceptanceInFlight', t => { t.client.steerAcceptanceInFlight.add(t.sessionId); }],
      ['session ended', t => { t.sm.endSession(t.sessionId, 'test'); }],
    ];
    it.each(guards)('%s', async (_name, arm) => {
      const t = build();
      await idleAfterPrompt(t);
      const settledTurnId = t.client.activeInputTurnIds.get(t.sessionId)!;
      expect(t.client.settledAdapterTurnIds.get(t.sessionId)).toBe(settledTurnId);
      arm(t);
      const sentBefore = t.sent.length;
      await t.emit({ type: 'agent_start' });
      expect(t.client.activeInputTurnIds.get(t.sessionId)).toBe(settledTurnId);
      expect(t.session.turn.isSettled).toBe(true);
      expect(t.sent.slice(sentBefore).filter(m => m.type === 'active')).toEqual([]);
      expect(t.sm.getMeta(t.sessionId)?.agentTurnStartSeqs).toBeUndefined();
    });
  });
});
