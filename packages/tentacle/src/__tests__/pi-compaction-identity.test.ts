import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiAdapter } from '../adapters/pi.js';
import { RelayClient } from '../relay-client.js';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

afterEach(() => vi.useRealTimers());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

/** Actual adapter + Relay callback wiring, but no sockets, children, or storage.
 * Start with a warm Pi process whose previous provider run has settled. */
function setup() {
  const adapter = new PiAdapter({ cliPath: '/unused', promptWatchdog: { ackGraceMs: 5, intervalMs: 5 } });
  const sid = 'warm-session';
  const proc = { alive: true, request: vi.fn().mockResolvedValue({}), kill: vi.fn() };
  const session = {
    proc, logicalTurn: 1, settledTurn: 1 as number | undefined,
    relayTurnId: undefined as string | undefined, eventTurnId: undefined as string | undefined,
    pendingPerms: new Map(), pendingQuestions: new Map(),
  };
  const internal = adapter as unknown as {
    sessions: Map<string, typeof session>;
    handleEvent: (id: string, event: Record<string, unknown>) => Promise<void>;
  };
  internal.sessions.set(sid, session);
  const manager = { getMeta: () => ({ state: 'active' }) };
  const client = new RelayClient(adapter, manager as ConstructorParameters<typeof RelayClient>[1], {
    relayUrl: 'ws://unused', authMethod: 'open', device: { name: 'Test', role: 'tentacle' },
  });
  const relay = client as unknown as {
    beginAdapterTurn: (id: string, turnId: string) => void;
    send: ReturnType<typeof vi.fn>;
  };
  const send = vi.fn();
  relay.send = send;
  const onCompaction = vi.fn(adapter.onCompaction!);
  adapter.onCompaction = onCompaction;
  // These tests exercise compaction routing, not turn settlement/card storage.
  adapter.onError = vi.fn();
  adapter.onIdle = vi.fn();
  adapter.onMessageDelta = vi.fn();
  const emit = (event: Record<string, unknown>) => internal.handleEvent(sid, event);
  const begin = (turnId: string) => relay.beginAdapterTurn(sid, turnId);
  begin('previous');
  // handleEvent runs synchronously up to the first await (agent_start has none).
  void emit({ type: 'agent_start' });
  return { adapter, sid, proc, session, begin, emit, send, onCompaction };
}

describe('Pi compaction ownership across prompt preflight', () => {
  it.each([undefined, 'steer', 'follow_up'] as const)(
    'publishes native preflight compaction for a fresh %s prompt without relabeling the previous run',
    async delivery => {
      const { adapter, sid, proc, session, begin, emit, send, onCompaction } = setup();
      const ack = deferred();
      proc.request.mockImplementation(type => type === 'prompt' ? ack.promise : Promise.resolve({}));
      begin('next');
      const sending = adapter.sendMessage(sid, 'new work', undefined, delivery ? { delivery } : undefined);
      try {
        await emit({ type: 'compaction_start', reason: 'threshold' });
        await emit({ type: 'compaction_start', reason: 'threshold' });
        expect(session.eventTurnId).toBe('previous');
        expect(onCompaction).toHaveBeenCalledExactlyOnceWith(sid, { phase: 'start', reason: 'threshold', turnId: 'next' });
        expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'compacting', sessionId: sid, payload: { phase: 'start', reason: 'threshold' } });
        await emit({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false });
        expect(onCompaction.mock.calls[1][1].turnId).toBe('next');
        expect(send.mock.calls[1][0]).toMatchObject({ type: 'compacting', payload: { phase: 'end', nextState: 'active' } });
        await emit({ type: 'agent_start' });
        expect(session.eventTurnId).toBe('next');
        expect(proc.request.mock.calls.filter(c => c[0] === 'prompt')).toHaveLength(1);
      } finally {
        ack.resolve();
        await sending;
      }
    },
  );

  it('publishes watchdog-discovered preflight compaction once with the new owner', async () => {
    vi.useFakeTimers();
    const { adapter, sid, proc, begin, emit, send, onCompaction } = setup();
    const ack = deferred();
    proc.request.mockImplementation(type => type === 'prompt' ? ack.promise : Promise.resolve({ isCompacting: true }));
    begin('next');
    const sending = adapter.sendMessage(sid, 'new work');
    try {
      await vi.advanceTimersByTimeAsync(25);
      expect(proc.request.mock.calls.filter(c => c[0] === 'get_state').length).toBeGreaterThan(1);
      expect(onCompaction).toHaveBeenCalledExactlyOnceWith(sid, { phase: 'start', turnId: 'next' });
      expect(send).toHaveBeenCalledTimes(1);
      // A missing compaction_end is reconciled by agent_start. Its end must
      // retain the start owner even after prompt acceptance changes.
      await emit({ type: 'agent_start' });
      expect(onCompaction.mock.calls[1][1]).toEqual({ phase: 'end', turnId: 'next' });
      expect(send.mock.calls[1][0]).toMatchObject({ type: 'compacting', payload: { phase: 'end' } });
    } finally {
      ack.resolve();
      await sending;
    }
  });

  it.each(['compaction_end', 'agent_start'] as const)(
    'retains the maintenance owner when a queued follow-up advances the turn before %s',
    async endEvent => {
      const { adapter, sid, begin, emit, send, onCompaction } = setup();
      await emit({ type: 'compaction_start', reason: 'threshold' });
      begin('queued-follow-up');
      await adapter.sendMessage(sid, 'after maintenance', undefined, { delivery: 'follow_up' });
      await emit({ type: endEvent, reason: 'threshold' });
      expect(onCompaction.mock.calls.map(c => c[1].turnId)).toEqual(['previous', 'previous']);
      expect(send.mock.calls.map(c => c[0].payload.phase)).toEqual(['start', 'end']);
    },
  );

  it('does not relabel late provider callbacks just because Relay has selected a new turn', async () => {
    const { adapter, sid, session, begin, emit, send, onCompaction } = setup();
    begin('next');
    session.settledTurn = undefined; // Still steering the existing provider run.
    await adapter.sendMessage(sid, 'interjection', undefined, { delivery: 'steer' });
    await emit({ type: 'compaction_start', reason: 'overflow' });
    expect(onCompaction.mock.calls[0][1].turnId).toBe('previous');
    expect(send).not.toHaveBeenCalled(); // The real Relay turn fence still rejects it.
    await emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late text' } });
    expect(adapter.onMessageDelta).toHaveBeenCalledWith(sid, { content: 'late text', turnId: 'previous' });
  });

  it('does not let an older late ACK clear the next prompt preflight owner', async () => {
    const { adapter, sid, proc, session, begin, emit, onCompaction } = setup();
    const firstAck = deferred(), nextAck = deferred();
    proc.request.mockReturnValueOnce(firstAck.promise).mockReturnValueOnce(nextAck.promise);
    begin('first');
    const firstSend = adapter.sendMessage(sid, 'first work');
    await emit({ type: 'agent_start' });
    session.settledTurn = session.logicalTurn;
    begin('next');
    const nextSend = adapter.sendMessage(sid, 'next work');
    try {
      firstAck.resolve();
      await firstSend;
      await emit({ type: 'compaction_start', reason: 'threshold' });
      expect(onCompaction.mock.calls[0][1].turnId).toBe('next');
    } finally {
      firstAck.resolve(); nextAck.resolve();
      await Promise.all([firstSend, nextSend]);
    }
  });

  it('retires preflight ownership and compaction state on explicit abort', async () => {
    const { adapter, sid, proc, session, begin, emit } = setup();
    const ack = deferred();
    proc.request.mockImplementation(type => type === 'prompt' ? ack.promise : Promise.resolve({}));
    begin('next');
    const sending = adapter.sendMessage(sid, 'work to abort');
    try {
      await emit({ type: 'compaction_start', reason: 'threshold' });
      await adapter.abortSession(sid);
      await sending;
      expect(proc.kill).toHaveBeenCalledOnce();
      expect((session as typeof session & { promptPreflight?: unknown }).promptPreflight).toBeUndefined();
      expect((adapter as unknown as { compactingSessions: Map<string, unknown> }).compactingSessions.has(sid)).toBe(false);
    } finally {
      ack.resolve();
      await sending;
    }
  });

  it.each(['accepted', 'rejected'] as const)('retires preflight ownership after the prompt is %s', async outcome => {
    const { adapter, sid, proc, begin, emit, send, onCompaction } = setup();
    begin('next');
    if (outcome === 'rejected') proc.request.mockRejectedValueOnce(new Error('prompt rejected'));
    const sending = adapter.sendMessage(sid, '/command-without-an-agent-run');
    if (outcome === 'rejected') await expect(sending).rejects.toThrow('prompt rejected');
    else await sending;
    await emit({ type: 'compaction_start', reason: 'manual' });
    expect(onCompaction.mock.calls[0][1].turnId).toBe('previous');
    expect(send).not.toHaveBeenCalled();
  });
});
