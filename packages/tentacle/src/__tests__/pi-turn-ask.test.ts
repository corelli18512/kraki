/**
 * Unit tests for the pi adapter's draft-bubble turn model.
 *
 *  - ordinary assistant prose (message_end) → NARRATION: streams to the draft
 *    bubble (onMessageDelta) and is mirrored to the TRACE axis (onNarration).
 *  - the LAST narration is the kept draft; the agent's reply IS its prose.
 *  - at agent_settled the adapter applies the SKIP-FINALIZE rule: exactly ONE
 *    narration segment with no tool after it is already a clean trailing reply →
 *    crystallize it directly (onMessage). A turn that ends on a tool has no
 *    reply: it is relayed as-is (just its Steps) — Kraki never injects an
 *    extra model round into the user's pi session.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KRAKI_SYSTEM_PROMPT, PiAdapter, summarizeCrash } from '../adapters/pi.js';
import { PI_KRAKI_TOOLS_SOURCE } from '../adapters/pi-kraki-tools.js';

interface StubProc {
  alive: boolean;
  send: ReturnType<typeof vi.fn>;
  sendRaw: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

function makeAdapter(promptWatchdog?: {
  ackGraceMs?: number;
  intervalMs?: number;
  probeFailureLimit?: number;
  idleStallMs?: number;
}) {
  const adapter = new PiAdapter({ cliPath: '/bin/true', promptWatchdog });
  const sid = 's1';
  const proc: StubProc = {
    alive: true,
    send: vi.fn(),
    sendRaw: vi.fn(),
    request: vi.fn().mockResolvedValue({}),
    kill: vi.fn(),
  };
  const session = {
    proc,
    cwd: '/tmp',
    model: 'github-copilot/claude-opus-4.8',
    mode: 'auto',
    usage: {},
    lastActivity: Date.now(),
    relayTurnId: undefined as string | undefined,
    exitObserved: false,
    pendingPerms: new Map<string, string>(),
    pendingQuestions: new Map<string, string>(),
    narrationSegments: 0,
    toolSinceLastNarration: false,
    lastNarration: '',
    pendingNarration: '',
    lastStopReason: undefined,
    pendingError: undefined,
    logicalTurn: 1,
    settledTurn: undefined,
    pendingMaintenanceIdle: false,
    aborting: false,
  };
  (adapter as unknown as { sessions: Map<string, unknown> }).sessions.set(sid, session);
  const emit = (e: Record<string, unknown>) =>
    (adapter as unknown as { handleEvent: (sid: string, e: Record<string, unknown>) => void }).handleEvent(sid, e);
  const narrate = (text: string) =>
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
  return { adapter, sid, proc, session, emit, narrate };
}

type Sess = ReturnType<typeof makeAdapter>['session'];

describe('pi idle eviction lifecycle', () => {
  it('does not evict a logical turn that is still retrying after agent_end', () => {
    const { adapter, sid, proc, session, emit } = makeAdapter();
    const onSessionEvicted = vi.fn();
    adapter.onSessionEvicted = onSessionEvicted;

    emit({ type: 'agent_end', willRetry: true });
    session.lastActivity = Date.now() - 30 * 60_000 - 1;
    (adapter as unknown as { sweepIdle: () => void }).sweepIdle();

    expect(session.settledTurn).toBeUndefined();
    expect(proc.kill).not.toHaveBeenCalled();
    expect(onSessionEvicted).not.toHaveBeenCalledWith(sid);
  });

  it('does not evict settled sessions while native compaction is still active', () => {
    const { adapter, proc, session, emit } = makeAdapter();
    const onSessionEvicted = vi.fn();
    adapter.onSessionEvicted = onSessionEvicted;
    session.settledTurn = session.logicalTurn;
    emit({ type: 'compaction_start', reason: 'threshold' });
    session.lastActivity = Date.now() - 30 * 60_000 - 1;

    (adapter as unknown as { sweepIdle: () => void }).sweepIdle();

    expect(proc.kill).not.toHaveBeenCalled();
    expect(onSessionEvicted).not.toHaveBeenCalled();
  });

  it('still evicts a genuinely settled, non-compacting session after the TTL', () => {
    const { adapter, sid, proc, session } = makeAdapter();
    const onSessionEvicted = vi.fn();
    adapter.onSessionEvicted = onSessionEvicted;
    session.settledTurn = session.logicalTurn;
    session.lastActivity = Date.now() - 30 * 60_000 - 1;

    (adapter as unknown as { sweepIdle: () => void }).sweepIdle();

    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(onSessionEvicted).toHaveBeenCalledWith(sid);
  });
});

describe('pi narration → draft + TRACE', () => {
  it('message_end prose → onNarration RECONCILE now, TRACE deferred (may still graduate)', () => {
    const { adapter, session, narrate } = makeAdapter();
    const onNarration = vi.fn();
    const onNarrationTrace = vi.fn();
    const onMessage = vi.fn();
    adapter.onNarration = onNarration;
    adapter.onNarrationTrace = onNarrationTrace;
    adapter.onMessage = onMessage;

    narrate('  let me think...  ');

    // Live draft reconcile fires immediately on every segment.
    expect(onNarration).toHaveBeenCalledWith('s1', { content: 'let me think...' });
    // But the TRACE mirror is DEFERRED — this segment might graduate into the
    // concluding bubble, so it isn't traced until confirmed intermediate.
    expect(onNarrationTrace).not.toHaveBeenCalled();
    // Narration is NOT itself a spine bubble — it graduates at idle.
    expect(onMessage).not.toHaveBeenCalled();
    expect(session.narrationSegments).toBe(1);
    expect(session.lastNarration).toBe('let me think...');
    expect(session.pendingNarration).toBe('let me think...');
    expect(session.toolSinceLastNarration).toBe(false);
  });

  it('text_delta streams to the draft bubble (onMessageDelta)', () => {
    const { adapter, emit } = makeAdapter();
    const onMessageDelta = vi.fn();
    adapter.onMessageDelta = onMessageDelta;
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } });
    expect(onMessageDelta).toHaveBeenCalledWith('s1', { content: 'Hi' });
  });

  it('empty/whitespace prose does NOT count as a narration segment', () => {
    const { adapter, session, narrate } = makeAdapter();
    adapter.onNarration = vi.fn();
    narrate('   ');
    expect(session.narrationSegments).toBe(0);
  });

  it('message_end stopReason error stays provisional and does NOT narrate', () => {
    const { adapter, session, emit } = makeAdapter();
    const onNarration = vi.fn();
    const onError = vi.fn();
    adapter.onNarration = onNarration;
    adapter.onError = onError;
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'error', errorMessage: 'boom' } });
    expect(onNarration).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(session.pendingError).toBe('boom');
    expect(session.narrationSegments).toBe(0);
  });

  it('a real tool marks toolSinceLastNarration and FLUSHES the pending narration to TRACE', () => {
    const { adapter, session, emit, narrate } = makeAdapter();
    const onToolStart = vi.fn();
    const onToolComplete = vi.fn();
    const onNarrationTrace = vi.fn();
    adapter.onToolStart = onToolStart;
    adapter.onToolComplete = onToolComplete;
    adapter.onNarrationTrace = onNarrationTrace;
    narrate('working on it');
    expect(session.toolSinceLastNarration).toBe(false);
    expect(onNarrationTrace).not.toHaveBeenCalled(); // still deferred
    emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' }, toolCallId: 't9' });
    // A tool follows → the narration is confirmed intermediate → traced now,
    // BEFORE the tool step so trace order is chronological, and pending cleared.
    expect(onNarrationTrace).toHaveBeenCalledWith('s1', { content: 'working on it' });
    expect(session.pendingNarration).toBe('');
    emit({ type: 'tool_execution_end', toolName: 'bash', result: 'files', toolCallId: 't9', isError: false });
    expect(onToolStart).toHaveBeenCalledTimes(1);
    expect(onToolComplete).toHaveBeenCalledTimes(1);
    expect(session.toolSinceLastNarration).toBe(true);
  });
});

describe('pi abort', () => {
  it('waits for the pi abort acknowledgement before resolving', async () => {
    const { adapter, sid, proc, session } = makeAdapter();
    let acknowledge!: () => void;
    const ack = new Promise<void>((resolve) => { acknowledge = resolve; });
    proc.request.mockImplementation((type) => type === 'clear_queue' ? Promise.resolve({ steering: [], followUp: [] }) : ack);

    let resolved = false;
    const aborting = adapter.abortSession(sid).then(() => { resolved = true; });
    await vi.waitFor(() => expect(proc.request).toHaveBeenCalledWith('abort'));

    expect(proc.request.mock.calls.map(call => call[0])).toEqual(['clear_queue', 'abort']);
    expect(resolved).toBe(false);

    acknowledge();
    await aborting;
    expect(resolved).toBe(true);
    expect(session.settledTurn).toBe(session.logicalTurn);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('does not claim successful cancellation or discard dialogs if queue clearing fails', async () => {
    const { adapter, sid, proc, session } = makeAdapter();
    session.pendingQuestions.set('q1', 'q1');
    proc.request.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(adapter.abortSession(sid)).rejects.toThrow('queue unavailable');
    expect(proc.sendRaw).not.toHaveBeenCalled();
    expect(session.pendingQuestions.has('q1')).toBe(true);
    expect(session.settledTurn).not.toBe(session.logicalTurn);
    expect(session.aborting).toBe(false);
  });

  it('cancels pending question and permission UI requests before aborting', async () => {
    const { adapter, sid, proc, session } = makeAdapter();
    session.pendingQuestions.set('q1', 'q1');
    session.pendingPerms.set('p1', 'p1');

    await adapter.abortSession(sid);

    expect(proc.request.mock.calls.map(call => call[0])).toEqual(['clear_queue', 'abort']);
    expect(proc.request.mock.invocationCallOrder[0]).toBeLessThan(proc.sendRaw.mock.invocationCallOrder[0]);
    expect(proc.sendRaw).toHaveBeenNthCalledWith(1, { type: 'extension_ui_response', id: 'q1', cancelled: true });
    expect(proc.sendRaw).toHaveBeenNthCalledWith(2, { type: 'extension_ui_response', id: 'p1', confirmed: false });
    expect(proc.request).toHaveBeenCalledWith('abort');
    expect(session.pendingQuestions.size).toBe(0);
    expect(session.pendingPerms.size).toBe(0);
  });

  it('lets abortSession own the boundary when pi emits agent_end during abort', async () => {
    const { adapter, sid, proc, emit } = makeAdapter();
    const onIdle = vi.fn();
    adapter.onIdle = onIdle;
    let acknowledge!: () => void;
    proc.request.mockReturnValueOnce(new Promise<void>((resolve) => { acknowledge = resolve; }));

    const aborting = adapter.abortSession(sid);
    await Promise.resolve();
    emit({ type: 'agent_end' });

    expect(proc.send).not.toHaveBeenCalledWith('prompt', expect.anything());
    expect(onIdle).not.toHaveBeenCalled();

    acknowledge();
    await aborting;
  });

  it('cancels a prompt still waiting for preflight compaction when abort is acknowledged', async () => {
    const { adapter, sid, proc, session } = makeAdapter({ ackGraceMs: 1, intervalMs: 1, idleStallMs: 100 });
    const onError = vi.fn();
    const onIdle = vi.fn();
    adapter.onError = onError;
    adapter.onIdle = onIdle;

    let acknowledgePrompt!: () => void;
    const promptAck = new Promise<void>((resolve) => { acknowledgePrompt = resolve; });
    proc.request.mockImplementation((type: string) => {
      if (type === 'prompt') return promptAck;
      if (type === 'get_state') return Promise.resolve({ isCompacting: true, isStreaming: false });
      return Promise.resolve({});
    });

    proc.kill.mockImplementation(() => { proc.alive = false; });
    const sending = adapter.sendMessage(sid, 'wait behind preflight compaction');
    try {
      await vi.waitFor(() => expect(proc.request.mock.calls.some(call => call[0] === 'get_state')).toBe(true));
      await adapter.abortSession(sid);

      const outcome = await Promise.race([
        sending.then(() => 'settled' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 30)),
      ]);
      expect(outcome).toBe('settled');
      expect(proc.kill).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(onIdle).not.toHaveBeenCalled();

      const resumedProc: StubProc = {
        alive: true,
        send: vi.fn(),
        sendRaw: vi.fn(),
        request: vi.fn().mockResolvedValue({}),
        kill: vi.fn(),
      };
      const resumedSession = { ...session, proc: resumedProc, promptAcceptanceAbort: undefined };
      const resume = vi.spyOn(adapter, 'resumeSession').mockImplementation(async () => {
        (adapter as unknown as { sessions: Map<string, unknown> }).sessions.set(sid, resumedSession);
        return { sessionId: sid };
      });

      await adapter.sendMessage(sid, 'next prompt after abort');
      expect(resume).toHaveBeenCalledWith(sid);
      expect(resumedProc.request).toHaveBeenCalledWith(
        'prompt', { message: 'next prompt after abort' }, { timeoutMs: null },
      );
    } finally {
      // Let the baseline implementation's intentionally-stuck request unwind so
      // the red test does not leave a watchdog timer behind after its assertion.
      acknowledgePrompt();
      await sending.catch(() => undefined);
    }
  });

  it('does not send abort to an already-dead pi process', async () => {
    const { adapter, sid, proc } = makeAdapter();
    proc.alive = false;

    await adapter.abortSession(sid);

    expect(proc.request).not.toHaveBeenCalled();
  });
});

describe('pi model switching', () => {
  it('persists the model only after pi acknowledges set_model', async () => {
    const { adapter, sid, proc, session } = makeAdapter();
    const persistMeta = vi.spyOn(adapter as unknown as { persistMeta: () => void }, 'persistMeta');

    await adapter.setSessionModel(sid, '1yuan-gpt/gpt-5.6-sol');

    expect(proc.request).toHaveBeenCalledWith('set_model', { provider: '1yuan-gpt', modelId: 'gpt-5.6-sol' });
    expect(session.model).toBe('1yuan-gpt/gpt-5.6-sol');
    expect(persistMeta).toHaveBeenCalled();
  });

  it('does not change memory or sidecar when set_model fails', async () => {
    const { adapter, sid, proc, session } = makeAdapter();
    const persistMeta = vi.spyOn(adapter as unknown as { persistMeta: () => void }, 'persistMeta');
    proc.request.mockRejectedValueOnce(new Error('unknown provider'));

    await expect(adapter.setSessionModel(sid, 'missing/model')).rejects.toThrow('unknown provider');

    expect(session.model).toBe('github-copilot/claude-opus-4.8');
    expect(persistMeta).not.toHaveBeenCalled();
  });

  it('appends the requested model before resuming a dead session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraki-pi-model-'));
    const transcript = join(dir, 'pi.jsonl');
    writeFileSync(transcript, [
      JSON.stringify({ type: 'session', version: 3, id: 'old-session', timestamp: new Date().toISOString(), cwd: '/tmp' }),
      JSON.stringify({ type: 'model_change', id: 'oldmodel', parentId: null, timestamp: new Date().toISOString(), provider: 'retired', modelId: 'old' }),
      '',
    ].join('\n'));

    try {
      const { adapter, sid, proc, session } = makeAdapter();
      proc.alive = false;
      Object.assign(session, { sessionFile: transcript });
      const resumedProc: StubProc = {
        alive: true,
        send: vi.fn(),
        sendRaw: vi.fn(),
        request: vi.fn().mockResolvedValue({ sessionFile: transcript }),
      };
      const resumed = { ...session, proc: resumedProc, model: '1yuan-gpt/gpt-5.6-sol' };
      vi.spyOn(adapter as unknown as { spawn: () => unknown }, 'spawn').mockReturnValue(resumed);
      vi.spyOn(adapter as unknown as { persistMeta: () => void }, 'persistMeta').mockImplementation(() => undefined);

      await adapter.setSessionModel(sid, '1yuan-gpt/gpt-5.6-sol');

      const entries = readFileSync(transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(entries.at(-1)).toMatchObject({
        type: 'model_change',
        parentId: 'oldmodel',
        provider: '1yuan-gpt',
        modelId: 'gpt-5.6-sol',
      });
      expect(resumedProc.request).toHaveBeenCalledWith('get_state');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pi prompt recovery', () => {
  it('keeps one delayed prompt alive through compaction without false error or idle', async () => {
    const { adapter, proc } = makeAdapter({ ackGraceMs: 1, intervalMs: 1, idleStallMs: 100 });
    const onError = vi.fn();
    const onIdle = vi.fn();
    const onCompaction = vi.fn();
    adapter.onError = onError;
    adapter.onIdle = onIdle;
    adapter.onCompaction = onCompaction;

    let acknowledge!: () => void;
    const ack = new Promise<void>((resolve) => { acknowledge = resolve; });
    proc.request.mockImplementation((type: string) => {
      if (type === 'prompt') return ack;
      if (type === 'get_state') return Promise.resolve({ isCompacting: true, isStreaming: false });
      return Promise.resolve({});
    });

    const sending = adapter.sendMessage('s1', 'compact me');
    await vi.waitFor(() => expect(proc.request.mock.calls.some(call => call[0] === 'get_state')).toBe(true));
    expect(proc.request.mock.calls.filter(call => call[0] === 'prompt')).toHaveLength(1);
    expect(onCompaction).toHaveBeenCalledTimes(1);
    expect(onCompaction).toHaveBeenCalledWith('s1', { phase: 'start' });
    expect(onError).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();

    acknowledge();
    await sending;
    expect(proc.request.mock.calls.filter(call => call[0] === 'prompt')).toHaveLength(1);
  });

  it('uses race-safe prompt steering without resetting the active turn', async () => {
    const { adapter, proc, session } = makeAdapter();
    session.narrationSegments = 2;
    session.lastNarration = 'working';

    await adapter.sendMessage('s1', 'check the other file', undefined, { delivery: 'steer' });

    expect(proc.request).toHaveBeenCalledWith('prompt', {
      message: 'check the other file',
      streamingBehavior: 'steer',
    }, { timeoutMs: null });
    expect(session.narrationSegments).toBe(2);
    expect(session.lastNarration).toBe('working');
  });

  it('queues a fresh turn through Pi followUp during background compaction', async () => {
    const { adapter, proc, session } = makeAdapter();
    session.narrationSegments = 2;
    session.lastNarration = 'old turn';

    await adapter.sendMessage('s1', 'new turn', undefined, { delivery: 'follow_up' });

    expect(proc.request).toHaveBeenCalledWith('prompt', {
      message: 'new turn',
      streamingBehavior: 'followUp',
    }, { timeoutMs: null });
    expect(proc.request).not.toHaveBeenCalledWith('abort');
    expect(session.narrationSegments).toBe(0);
    expect(session.lastNarration).toBe('');
  });

  it('treats isStreaming as accepted while retaining the late ACK cleanup', async () => {
    const { adapter, proc } = makeAdapter({ ackGraceMs: 1, intervalMs: 1 });
    const onError = vi.fn();
    const onIdle = vi.fn();
    adapter.onError = onError;
    adapter.onIdle = onIdle;

    let rejectAck!: (error: Error) => void;
    const ack = new Promise<void>((_resolve, reject) => { rejectAck = reject; });
    proc.request.mockImplementation((type: string) => {
      if (type === 'prompt') return ack;
      if (type === 'get_state') return Promise.resolve({ isStreaming: true, isCompacting: false });
      return Promise.resolve({});
    });

    await adapter.sendMessage('s1', 'run once');
    expect(proc.request.mock.calls.filter(call => call[0] === 'prompt')).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();
    // A late transport rejection is observed by ackOutcome, not left unhandled.
    rejectAck(new Error('late response after process exit'));
    await Promise.resolve();
  });

  it('does not duplicate idle when process exit already owns the terminal transition', async () => {
    const { adapter, proc, session } = makeAdapter();
    const onError = vi.fn();
    const onIdle = vi.fn();
    adapter.onError = onError;
    adapter.onIdle = onIdle;
    proc.request.mockImplementation((type: string) => {
      if (type !== 'prompt') return Promise.resolve({});
      session.exitObserved = true;
      onIdle('s1'); // mirrors PiRpcProcess.onExit ordering
      return Promise.reject(new Error('pi process exited'));
    });

    await expect(adapter.sendMessage('s1', 'will exit')).rejects.toThrow('pi process exited');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('fails once after repeated state-probe failures without resending', async () => {
    const { adapter, proc } = makeAdapter({ ackGraceMs: 1, intervalMs: 1, probeFailureLimit: 2 });
    const onError = vi.fn();
    const onIdle = vi.fn();
    adapter.onError = onError;
    adapter.onIdle = onIdle;
    proc.request.mockImplementation((type: string) => {
      if (type === 'prompt') return new Promise(() => undefined);
      if (type === 'get_state') return Promise.reject(new Error('state channel wedged'));
      return Promise.resolve({});
    });

    await expect(adapter.sendMessage('s1', 'one delivery')).rejects.toThrow('could not be reconciled');
    expect(proc.request.mock.calls.filter(call => call[0] === 'prompt')).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1].message).toContain('could not be reconciled');
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('maps native compaction events once and never forwards summary content', async () => {
    const { adapter, emit } = makeAdapter();
    const onCompaction = vi.fn();
    adapter.onCompaction = onCompaction;

    emit({ type: 'compaction_start', reason: 'threshold' });
    emit({ type: 'compaction_start', reason: 'threshold' });
    emit({
      type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: true,
      result: { summary: 'private conversation summary' },
    });
    await Promise.resolve();

    expect(onCompaction).toHaveBeenCalledTimes(2);
    expect(onCompaction).toHaveBeenNthCalledWith(1, 's1', { phase: 'start', reason: 'threshold' });
    expect(onCompaction).toHaveBeenNthCalledWith(2, 's1', {
      phase: 'end', reason: 'threshold', aborted: false, willRetry: true, errorMessage: undefined,
    });
    expect(JSON.stringify(onCompaction.mock.calls)).not.toContain('private conversation summary');
  });

  it('awaits abort and idle reconciliation before retrying the prompt', async () => {
    const { adapter, proc } = makeAdapter();
    let releaseAbort!: () => void;
    const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
    proc.request
      .mockRejectedValueOnce(new Error('Agent is already processing'))
      .mockImplementationOnce(async (type: string) => {
        expect(type).toBe('abort');
        await abortGate;
        return {};
      })
      .mockResolvedValueOnce({ isStreaming: false, isCompacting: false })
      .mockResolvedValueOnce({});

    const sending = adapter.sendMessage('s1', 'retry me');
    await vi.waitFor(() => {
      expect(proc.request.mock.calls.map(call => call[0])).toEqual(['prompt', 'abort']);
    });
    expect(proc.request.mock.calls[0]?.[2]).toEqual({ timeoutMs: null });
    releaseAbort();
    await sending;
    expect(proc.request.mock.calls.map(call => call[0])).toEqual(['prompt', 'abort', 'get_state', 'prompt']);
  });

  it('does not abort a live pending human prompt', async () => {
    const { adapter, proc, session } = makeAdapter();
    session.pendingQuestions.set('q1', 'q1');
    proc.request.mockRejectedValueOnce(new Error('Agent is already processing'));
    await expect(adapter.sendMessage('s1', 'wrong route')).rejects.toThrow('waiting for a human response');
    expect(proc.request.mock.calls.map(call => call[0])).toEqual(['prompt']);
  });
});

describe('pi inbound images (sendMessage → RPC prompt.images)', () => {
  it('converts ImageAttachment → pi ImageContent and passes it in the prompt', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.sendMessage('s1', 'what is this?', [
      { type: 'image', data: 'QUJD', mimeType: 'image/png', caption: 'a shot' },
    ]);
    expect(proc.request).toHaveBeenCalledWith('prompt', {
      message: 'what is this?',
      images: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }],
    }, { timeoutMs: null });
  });

  it('omits the images field entirely when there are no image attachments', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.sendMessage('s1', 'plain text');
    expect(proc.request).toHaveBeenCalledWith('prompt', { message: 'plain text' }, { timeoutMs: null });
  });

  it('drops non-image (ContentRef) attachments — they cannot be inlined', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.sendMessage('s1', 'hi', [
      { type: 'content_ref', id: 'abc', mimeType: 'image/png', size: 10 },
    ]);
    expect(proc.request).toHaveBeenCalledWith('prompt', { message: 'hi' }, { timeoutMs: null });
  });
});

describe('pi outbound images (tool result → attachment store)', () => {
  function makeAdapterWithStore() {
    const put = vi.fn((_sid: string, _bytes: Buffer, mimeType: string) => ({
      type: 'content_ref' as const,
      id: 'ref1',
      mimeType,
      size: 3,
    }));
    const store = { put } as unknown;
    const adapter = new PiAdapter({
      cliPath: '/bin/true',
      attachmentStore: store as import('../attachment-store.js').AttachmentStore,
    });
    const sid = 's1';
    const proc: StubProc = { alive: true, send: vi.fn(), sendRaw: vi.fn(), request: vi.fn().mockResolvedValue({}) };
    (adapter as unknown as { sessions: Map<string, unknown> }).sessions.set(sid, {
      proc, cwd: '/tmp', model: 'm', mode: 'auto', usage: {}, lastActivity: Date.now(),
      pendingPerms: new Map(), pendingQuestions: new Map(), narrationSegments: 0,
      toolSinceLastNarration: false, lastNarration: '', lastStopReason: undefined, pendingError: undefined, logicalTurn: 1, settledTurn: undefined, pendingNarration: '', aborting: false, finalizing: false, finalizeAttempt: 0,
    });
    const emit = async (e: Record<string, unknown>) =>
      await (adapter as unknown as { handleEvent: (sid: string, e: Record<string, unknown>) => Promise<void> }).handleEvent(sid, e);
    return { adapter, emit, put };
  }

  it('extracts image blocks from a tool result into the attachment store + broadcasts bytes', async () => {
    const { adapter, emit, put } = makeAdapterWithStore();
    const onToolComplete = vi.fn();
    const onAttachmentBytes = vi.fn();
    adapter.onToolComplete = onToolComplete;
    adapter.onAttachmentBytes = onAttachmentBytes;

    await emit({
      type: 'tool_execution_end',
      toolName: 'show_image',
      toolCallId: 't1',
      isError: false,
      result: {
        content: [
          { type: 'text', text: 'here is the chart' },
          { type: 'image', data: 'QUJD', mimeType: 'image/png' },
        ],
        details: {},
      },
    });

    expect(put).toHaveBeenCalledWith('s1', Buffer.from('QUJD', 'base64'), 'image/png', {});
    expect(onToolComplete).toHaveBeenCalledWith('s1', {
      toolName: 'show_image',
      result: 'here is the chart',
      toolCallId: 't1',
      success: true,
      attachments: [{ type: 'content_ref', id: 'ref1', mimeType: 'image/png', size: 3 }],
    });
    expect(onAttachmentBytes).toHaveBeenCalledWith('s1', {
      refs: [{ type: 'content_ref', id: 'ref1', mimeType: 'image/png', size: 3 }],
    });
  });

  it.each(['show_report', 'show_html'])('stores %s output as a text/html attachment and broadcasts its bytes', async (tool) => {
    const dir = mkdtempSync(join(tmpdir(), 'kraki-show-html-'));
    const htmlPath = join(dir, 'report.html');
    writeFileSync(htmlPath, '<!doctype html><title>Report</title>');
    try {
      const { adapter, emit, put } = makeAdapterWithStore();
      const onToolComplete = vi.fn();
      const onAttachmentBytes = vi.fn();
      adapter.onToolComplete = onToolComplete;
      adapter.onAttachmentBytes = onAttachmentBytes;

      await emit({
        type: 'tool_execution_end',
        toolName: tool,
        toolCallId: 'html-1',
        isError: false,
        result: {
          content: [{ type: 'text', text: 'HTML report ready for preview.' }],
          details: { htmlPath, title: 'Architecture Report', name: 'report.html' },
        },
      });

      expect(put).toHaveBeenCalledWith(
        's1',
        Buffer.from('<!doctype html><title>Report</title>'),
        'text/html',
        { name: 'report.html', caption: 'Architecture Report' },
      );
      expect(onToolComplete).toHaveBeenCalledWith('s1', {
        toolName: tool,
        result: 'HTML report ready for preview.',
        toolCallId: 'html-1',
        success: true,
        attachments: [{ type: 'content_ref', id: 'ref1', mimeType: 'text/html', size: 3 }],
      });
      expect(onAttachmentBytes).toHaveBeenCalledWith('s1', {
        refs: [{ type: 'content_ref', id: 'ref1', mimeType: 'text/html', size: 3 }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([['show_report', false], ['show_html', true]] as const)('applies the %s size cap (legacy stays 10 MB)', async (tool, stored) => {
    const dir = mkdtempSync(join(tmpdir(), 'kraki-report-cap-'));
    const htmlPath = join(dir, 'big.html');
    writeFileSync(htmlPath, Buffer.alloc(2 * 1024 * 1024, 0x61));
    try {
      const { adapter, emit, put } = makeAdapterWithStore();
      adapter.onToolComplete = vi.fn();
      await emit({
        type: 'tool_execution_end', toolName: tool, toolCallId: 'cap-1', isError: false,
        result: { content: [{ type: 'text', text: 'ok' }], details: { htmlPath, name: 'big.html' } },
      });
      expect(put).toHaveBeenCalledTimes(stored ? 1 : 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores an htmlPath handle from tools other than show_report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraki-show-html-spoof-'));
    const htmlPath = join(dir, 'secret.html');
    writeFileSync(htmlPath, '<p>secret</p>');
    try {
      const { adapter, emit, put } = makeAdapterWithStore();
      const onToolComplete = vi.fn();
      adapter.onToolComplete = onToolComplete;

      await emit({
        type: 'tool_execution_end',
        toolName: 'bash',
        toolCallId: 'bash-1',
        isError: false,
        result: { content: [{ type: 'text', text: 'done' }], details: { htmlPath } },
      });

      expect(put).not.toHaveBeenCalled();
      expect(onToolComplete).toHaveBeenCalledWith('s1', {
        toolName: 'bash', result: 'done', toolCallId: 'bash-1', success: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('joins text content blocks (no images) into a clean result string', () => {
    const { adapter, emit, put } = makeAdapterWithStore();
    const onToolComplete = vi.fn();
    const onAttachmentBytes = vi.fn();
    adapter.onToolComplete = onToolComplete;
    adapter.onAttachmentBytes = onAttachmentBytes;

    emit({
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 't2',
      isError: false,
      result: { content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }], details: {} },
    });

    expect(put).not.toHaveBeenCalled();
    expect(onAttachmentBytes).not.toHaveBeenCalled();
    expect(onToolComplete).toHaveBeenCalledWith('s1', {
      toolName: 'bash', result: 'line1\nline2', toolCallId: 't2', success: true,
    });
  });

  it('falls back to stringifying a non-content-array result (back-compat)', () => {
    const { adapter, emit } = makeAdapterWithStore();
    const onToolComplete = vi.fn();
    adapter.onToolComplete = onToolComplete;
    emit({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 't3', isError: false, result: 'raw string' });
    expect(onToolComplete).toHaveBeenCalledWith('s1', {
      toolName: 'bash', result: 'raw string', toolCallId: 't3', success: true,
    });
  });
});

describe('pi trailing narration → direct reply', () => {
  it('settles a clean answer at agent_end before maintenance and queues the next turn', async () => {
    const { adapter, proc, session, emit, narrate } = makeAdapter();
    const timeline: string[] = [];
    const onMessage = vi.fn(() => { timeline.push('agent_message'); });
    const onIdle = vi.fn(() => { timeline.push('idle'); });
    const onCompaction = vi.fn((_sid: string, event: { phase: string }) => {
      timeline.push(`compaction:${event.phase}`);
    });
    adapter.onMessage = onMessage;
    adapter.onIdle = onIdle;
    adapter.onCompaction = onCompaction;

    narrate('The first answer is complete.');
    await emit({ type: 'agent_end', willRetry: false });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();
    expect(session.pendingMaintenanceIdle).toBe(true);

    await emit({ type: 'compaction_start', reason: 'threshold' });
    expect(onCompaction).toHaveBeenCalledWith('s1', { phase: 'start', reason: 'threshold' });
    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'The first answer is complete.' });
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(session.settledTurn).toBe(session.logicalTurn);

    await adapter.sendMessage('s1', 'continue after compaction', undefined, { delivery: 'follow_up' });
    expect(proc.request).toHaveBeenCalledWith(
      'prompt',
      { message: 'continue after compaction', streamingBehavior: 'followUp' },
      { timeoutMs: null },
    );
    expect(session.settledTurn).not.toBe(session.logicalTurn);

    await emit({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false });
    narrate('The queued follow-up is now active.');
    await emit({ type: 'agent_end', willRetry: false });
    await emit({ type: 'agent_settled' });

    expect(onMessage).toHaveBeenLastCalledWith('s1', { content: 'The queued follow-up is now active.' });
    expect(onIdle).toHaveBeenCalledTimes(2);
    expect(timeline).toEqual([
      'compaction:start', 'agent_message', 'idle',
      'compaction:end', 'agent_message', 'idle',
    ]);
  });

  it('exactly one narration, no tool after → crystallize directly', () => {
    const { adapter, proc, emit, narrate } = makeAdapter();
    const onMessage = vi.fn();
    const onIdle = vi.fn();
    const onNarrationTrace = vi.fn();
    adapter.onMessage = onMessage;
    adapter.onIdle = onIdle;
    adapter.onNarrationTrace = onNarrationTrace;

    narrate('Here is your answer.');
    emit({ type: 'agent_settled' });

    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'Here is your answer.' });
    // The trailing narration graduated INTO the bubble — it must NOT also be
    // traced as a Step (the duplication bug this fix targets).
    expect(onNarrationTrace).not.toHaveBeenCalled();
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(proc.send).not.toHaveBeenCalled(); // nothing injected into pi
  });

  it('tool THEN one explanation (git → explain) → skip, direct reply, no dup Step', () => {
    const { adapter, proc, emit, narrate } = makeAdapter();
    const onMessage = vi.fn();
    const onNarrationTrace = vi.fn();
    adapter.onMessage = onMessage;
    adapter.onNarrationTrace = onNarrationTrace;

    emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'git status' }, toolCallId: 't1' });
    emit({ type: 'tool_execution_end', toolName: 'bash', result: 'clean', toolCallId: 't1', isError: false });
    narrate('Your tree is clean.'); // one narration AFTER the tool → trailing reply
    emit({ type: 'agent_settled' });

    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'Your tree is clean.' });
    // The explanation is the reply (bubble), not a Step.
    expect(onNarrationTrace).not.toHaveBeenCalled();
    expect(proc.send).not.toHaveBeenCalled();
  });
});

describe('pi Steps dedup — trailing narration never traced as its own bubble', () => {
  it('two narrations, last is trailing → first is a Step, the graduating last is NOT', () => {
    const { adapter, proc, emit, narrate } = makeAdapter();
    const onMessage = vi.fn();
    const onNarrationTrace = vi.fn();
    adapter.onMessage = onMessage;
    adapter.onNarrationTrace = onNarrationTrace;

    narrate('First I will look around.');
    narrate('Now here is the conclusion.');
    // The SECOND narration supersedes the first → first is traced immediately.
    expect(onNarrationTrace).toHaveBeenCalledTimes(1);
    expect(onNarrationTrace).toHaveBeenCalledWith('s1', { content: 'First I will look around.' });

    emit({ type: 'agent_settled' }); // 2 segments, last is trailing → graduate directly

    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'Now here is the conclusion.' });
    // The concluding narration graduated into the bubble → still exactly ONE trace step.
    expect(onNarrationTrace).toHaveBeenCalledTimes(1);
    expect(proc.send).not.toHaveBeenCalledWith('prompt', expect.anything());
  });

  it('ends on a tool: no reply and no extra model call; the narration is a Step', () => {
    const { adapter, proc, emit, narrate } = makeAdapter();
    const onMessage = vi.fn();
    const onNarrationTrace = vi.fn();
    const onIdle = vi.fn();
    adapter.onMessage = onMessage;
    adapter.onNarrationTrace = onNarrationTrace;
    adapter.onIdle = onIdle;

    narrate('First pass thoughts.');
    emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' }, toolCallId: 't1' });
    emit({ type: 'tool_execution_end', toolName: 'bash', result: 'x', toolCallId: 't1', isError: false });
    emit({ type: 'agent_settled' });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onNarrationTrace).toHaveBeenCalledTimes(1);
    expect(onNarrationTrace).toHaveBeenCalledWith('s1', { content: 'First pass thoughts.' });
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(proc.request).not.toHaveBeenCalledWith('prompt', expect.anything(), expect.anything());
  });
});

describe('pi turn conclusion (relayed as-is, no injected rounds)', () => {
  it('multi-segment with a clean trailing reply graduates directly', () => {
    const { adapter, proc, session, emit, narrate } = makeAdapter();
    const onIdle = vi.fn();
    const onMessage = vi.fn();
    adapter.onIdle = onIdle;
    adapter.onMessage = onMessage;

    narrate('First I will look around.');
    narrate('Now here is the conclusion.');
    emit({ type: 'agent_settled' });

    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'Now here is the conclusion.' });
    expect(proc.send).not.toHaveBeenCalledWith('prompt', expect.anything());
  });

  it('zero narration (tool only) → just idle, nothing injected into pi', () => {
    const { adapter, proc, emit } = makeAdapter();
    const onIdle = vi.fn(); const onMessage = vi.fn(); const onSystemMessage = vi.fn();
    adapter.onIdle = onIdle; adapter.onMessage = onMessage; adapter.onSystemMessage = onSystemMessage;
    emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' }, toolCallId: 't1' });
    emit({ type: 'tool_execution_end', toolName: 'bash', result: 'x', toolCallId: 't1', isError: false });
    emit({ type: 'agent_settled' });
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
    expect(onSystemMessage).not.toHaveBeenCalled(); // RelayClient anchors steps-only turns
    expect(proc.request).not.toHaveBeenCalledWith('prompt', expect.anything(), expect.anything());
  });

  it('backend error stopReason → emits one error and one idle at terminal agent_settled', () => {
    const { adapter, proc, session, emit } = makeAdapter();
    const onIdle = vi.fn();
    const onMessage = vi.fn();
    const onError = vi.fn();
    adapter.onIdle = onIdle;
    adapter.onMessage = onMessage;
    adapter.onError = onError;
    emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'quota exceeded' } });
    expect(onError).not.toHaveBeenCalled();
    emit({ type: 'agent_settled' });
    emit({ type: 'agent_settled' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('s1', { message: 'quota exceeded' });
    expect(onMessage).not.toHaveBeenCalled();
    expect(proc.request).not.toHaveBeenCalledWith('prompt', expect.anything(), expect.anything());
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('echoes the relay turn identity on final message and idle callbacks', () => {
    const { adapter, sid, emit, narrate } = makeAdapter();
    const onMessage = vi.fn();
    const onIdle = vi.fn();
    adapter.onMessage = onMessage;
    adapter.onIdle = onIdle;
    adapter.setTurnIdentity(sid, 's1:turn-9');
    emit({ type: 'agent_start' });
    // A later Relay identity must not relabel callbacks already owned by this
    // provider run.
    adapter.setTurnIdentity(sid, 's1:turn-next');

    narrate('done');
    emit({ type: 'agent_settled' });

    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'done', turnId: 's1:turn-9' });
    expect(onIdle).toHaveBeenCalledWith('s1', { turnId: 's1:turn-9' });
  });

  it('flushes a pending provider error before process-exit idle', () => {
    const { adapter, sid, session } = makeAdapter();
    const events: string[] = [];
    const onError = vi.fn((_sessionId: string, event: { message: string; turnId?: string }) => {
      events.push(`error:${event.message}:${event.turnId}`);
    });
    const onIdle = vi.fn((_sessionId: string, event?: { turnId?: string }) => {
      events.push(`idle:${event?.turnId}`);
    });
    adapter.onError = onError;
    adapter.onIdle = onIdle;
    adapter.setTurnIdentity(sid, 's1:turn-exit');
    session.pendingError = 'provider failed before settlement';

    (adapter as unknown as { handleProcessExit: (sessionId: string, value: typeof session) => void })
      .handleProcessExit(sid, session);

    expect(events).toEqual([
      'error:provider failed before settlement:s1:turn-exit',
      'idle:s1:turn-exit',
    ]);
    expect(session.pendingError).toBeUndefined();
    expect(session.exitObserved).toBe(true);
  });

  it('reports a mid-turn crash with the reason instead of ending the turn silently', () => {
    const { adapter, sid, session } = makeAdapter();
    const onError = vi.fn();
    const onIdle = vi.fn();
    adapter.onError = onError;
    adapter.onIdle = onIdle;
    adapter.setTurnIdentity(sid, 's1:turn-crash');
    (session as unknown as { settledTurn: number | undefined; logicalTurn: number }).settledTurn = undefined;
    (session.proc as unknown as { crashReason: () => string }).crashReason = () => 'TypeError: zlib.createZstdDecompress is not a function';

    (adapter as unknown as { handleProcessExit: (sessionId: string, value: typeof session, code: number) => void })
      .handleProcessExit(sid, session, 1);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1].message).toBe('Pi stopped unexpectedly (exit code 1): TypeError: zlib.createZstdDecompress is not a function');
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('picks the error line from a Node crash dump', () => {
    const dump = "node:events:502\r\n      throw er; // Unhandled 'error' event\r\n      ^\r\n\r\nTypeError: zlib.createZstdDecompress is not a function\r\n    at Object.onResponseStart (file:///C:/x.js:1:1)\r\n\nNode.js v22.13.1";
    expect(summarizeCrash(dump)).toBe('TypeError: zlib.createZstdDecompress is not a function');
    expect(summarizeCrash('fatal: something broke\nNode.js v22.13.1')).toBe('fatal: something broke');
    expect(summarizeCrash('')).toBeUndefined();
  });

  it('aborted stopReason → just idle', () => {
    const { adapter, proc, session, emit } = makeAdapter();
    const onIdle = vi.fn();
    const onMessage = vi.fn();
    adapter.onIdle = onIdle;
    adapter.onMessage = onMessage;
    emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' } });
    emit({ type: 'agent_settled' });
    expect(onMessage).not.toHaveBeenCalled();
    expect(proc.send).not.toHaveBeenCalledWith('prompt', expect.anything());
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

});

describe('pi early maintenance settlement', () => {
  it.each(['length', 'error', 'aborted', 'deferred'])('does not promote a %s response before recovery settles', async stopReason => {
    const { adapter, emit } = makeAdapter();
    adapter.onMessage = vi.fn(); adapter.onIdle = vi.fn();
    await emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'not final' }], stopReason } });
    await emit({ type: 'agent_end', willRetry: false });
    await emit({ type: 'compaction_start', reason: 'overflow' });
    expect(adapter.onMessage).not.toHaveBeenCalled(); expect(adapter.onIdle).not.toHaveBeenCalled();
    await emit({ type: 'compaction_end', reason: 'overflow', willRetry: true });
    await emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'recovered' }], stopReason: 'stop' } });
    await emit({ type: 'agent_settled' });
    expect(adapter.onMessage).toHaveBeenCalledWith('s1', { content: 'recovered' });
    expect(adapter.onIdle).toHaveBeenCalledTimes(1);
  });
});

describe('pi ask_user → question card', () => {
  it('maps extension_ui_request select → onQuestionRequest with choices', () => {
    const { adapter, session, emit } = makeAdapter();
    const onQuestionRequest = vi.fn();
    adapter.onQuestionRequest = onQuestionRequest;
    emit({ type: 'extension_ui_request', method: 'select', id: 'q1', title: 'Pick a color', options: ['red', 'blue'] });
    expect(onQuestionRequest).toHaveBeenCalledWith('s1', {
      id: 'q1',
      question: 'Pick a color',
      choices: ['red', 'blue'],
    });
    expect(session.pendingQuestions.get('q1')).toBe('q1');
  });

  it('maps extension_ui_request input → free-form question (no choices)', () => {
    const { adapter, emit } = makeAdapter();
    const onQuestionRequest = vi.fn();
    adapter.onQuestionRequest = onQuestionRequest;
    emit({ type: 'extension_ui_request', method: 'input', id: 'q2', title: 'Your name?' });
    expect(onQuestionRequest).toHaveBeenCalledWith('s1', {
      id: 'q2',
      question: 'Your name?',
      choices: undefined,
    });
  });

  it('confirm in safe mode → raises a permission card (gate every tool)', () => {
    const { adapter, session, emit } = makeAdapter();
    session.mode = 'safe';
    const onPermissionRequest = vi.fn();
    adapter.onPermissionRequest = onPermissionRequest;
    emit({ type: 'extension_ui_request', method: 'confirm', id: 'p1', title: 'bash', message: JSON.stringify({ command: 'ls' }) });
    expect(onPermissionRequest).toHaveBeenCalledTimes(1);
    expect(session.pendingPerms.get('p1')).toBe('p1');
  });

  it('confirm for a read-only tool in safe → auto-approved silently (no card)', () => {
    const { adapter, proc, session, emit } = makeAdapter();
    session.mode = 'safe';
    const onPermissionRequest = vi.fn();
    adapter.onPermissionRequest = onPermissionRequest;
    emit({ type: 'extension_ui_request', method: 'confirm', id: 'p1', title: 'read', message: JSON.stringify({ path: '/repo/a.ts' }) });
    expect(onPermissionRequest).not.toHaveBeenCalled();
    expect(proc.sendRaw).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'p1', confirmed: true });
    expect(session.pendingPerms.has('p1')).toBe(false);
  });

  it('confirm for a file write in safe → raises a permission card', () => {
    const { adapter, session, emit } = makeAdapter();
    session.mode = 'safe';
    const onPermissionRequest = vi.fn();
    adapter.onPermissionRequest = onPermissionRequest;
    emit({ type: 'extension_ui_request', method: 'confirm', id: 'p1', title: 'write', message: JSON.stringify({ path: '/tmp/a.txt', content: 'x' }) });
    expect(onPermissionRequest).toHaveBeenCalledTimes(1);
    expect(session.pendingPerms.get('p1')).toBe('p1');
  });

  it('confirm for any tool in auto → auto-approved silently (no card)', () => {
    const { adapter, proc, session, emit } = makeAdapter();
    session.mode = 'auto';
    const onPermissionRequest = vi.fn();
    adapter.onPermissionRequest = onPermissionRequest;
    emit({ type: 'extension_ui_request', method: 'confirm', id: 'p1', title: 'write', message: JSON.stringify({ path: '/repo/a.ts', content: 'x' }) });
    expect(onPermissionRequest).not.toHaveBeenCalled();
    expect(proc.sendRaw).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'p1', confirmed: true });
  });

  it('switching to auto approves an existing permission without steering Pi', async () => {
    const { adapter, proc, session, emit } = makeAdapter();
    session.mode = 'safe';
    const onPermissionRequest = vi.fn();
    const onPermissionAutoResolved = vi.fn();
    adapter.onPermissionRequest = onPermissionRequest;
    adapter.onPermissionAutoResolved = onPermissionAutoResolved;

    emit({ type: 'extension_ui_request', method: 'confirm', id: 'p1', title: 'bash', message: JSON.stringify({ command: 'rm -f build.tmp' }) });
    expect(onPermissionRequest).toHaveBeenCalledTimes(1);
    expect(session.pendingPerms.has('p1')).toBe(true);

    adapter.setSessionMode('s1', 'auto');

    expect(proc.sendRaw).toHaveBeenLastCalledWith({ type: 'extension_ui_response', id: 'p1', confirmed: true });
    expect(session.pendingPerms.has('p1')).toBe(false);
    expect(onPermissionAutoResolved).toHaveBeenCalledWith('s1', 'p1', 'approved');
    expect(proc.send).not.toHaveBeenCalledWith('steer', expect.anything());

    const responseCount = proc.sendRaw.mock.calls.length;
    await adapter.respondToPermission('s1', 'p1', 'approve');
    expect(proc.sendRaw).toHaveBeenCalledTimes(responseCount);
  });

  it('ask_user tool_execution_start is swallowed (not TRACE)', () => {
    const { adapter, emit } = makeAdapter();
    const onToolStart = vi.fn();
    const onMessage = vi.fn();
    adapter.onToolStart = onToolStart;
    adapter.onMessage = onMessage;
    emit({ type: 'tool_execution_start', toolName: 'ask_user', args: { question: 'x' }, toolCallId: 't1' });
    expect(onToolStart).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('ask_user does NOT set toolSinceLastNarration (not a real tool)', () => {
    const { adapter, session, narrate, emit } = makeAdapter();
    adapter.onNarration = vi.fn();
    narrate('one line');
    emit({ type: 'tool_execution_start', toolName: 'ask_user', args: { question: 'x' }, toolCallId: 't1' });
    expect(session.toolSinceLastNarration).toBe(false);
  });

  it('respondToQuestion sends a structured extension_ui_response and clears pending', async () => {
    const { adapter, proc, session } = makeAdapter();
    session.pendingQuestions.set('q1', 'q1');
    const result = await adapter.respondToQuestion('s1', 'q1', 'red', false);
    expect(proc.sendRaw).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'q1',
      value: JSON.stringify({ __krakiAnswer: 1, text: 'red' }),
    });
    expect(result).toBe('accepted');
    expect(session.pendingQuestions.has('q1')).toBe(false);
  });

  it('respondToQuestion carries inline images through the structured response', async () => {
    const { adapter, proc, session } = makeAdapter();
    session.pendingQuestions.set('q1', 'q1');
    await adapter.respondToQuestion('s1', 'q1', {
      text: '',
      attachments: [{ type: 'image', mimeType: 'image/png', data: 'abc' }],
    }, true);
    expect(proc.sendRaw).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'q1',
      value: JSON.stringify({ __krakiAnswer: 1, text: '', images: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] }),
    });
  });

  it('respondToQuestion for an unknown question is a no-op', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.respondToQuestion('s1', 'nope', 'x', false);
    expect(proc.sendRaw).not.toHaveBeenCalled();
  });
});

describe('pi agent lifecycle boundaries', () => {
  it('converts a post-settlement steer into a fresh prompt and settles its reply', async () => {
    const { adapter, proc, session, emit } = makeAdapter();
    const onMessage = vi.fn();
    const onIdle = vi.fn();
    adapter.onMessage = onMessage;
    adapter.onIdle = onIdle;
    session.settledTurn = session.logicalTurn;

    await adapter.sendMessage('s1', 'steer text', undefined, { delivery: 'steer' });
    expect(proc.request).toHaveBeenCalledWith(
      'prompt',
      { message: 'steer text' },
      { timeoutMs: null },
    );
    expect(session.logicalTurn).toBe(2);
    expect(session.settledTurn).toBeUndefined();

    await emit({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'steered reply' }], stopReason: 'stop' },
    });
    await emit({ type: 'agent_end' });
    expect(onMessage).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();

    await emit({ type: 'agent_settled' });

    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'steered reply' });
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(session.settledTurn).toBe(session.logicalTurn);
  });

  it('does not terminalize a provisional error when agent_end will retry', () => {
    const { adapter, session, emit } = makeAdapter();
    const onError = vi.fn();
    const onIdle = vi.fn();
    adapter.onError = onError;
    adapter.onIdle = onIdle;
    emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'temporary failure' } });
    emit({ type: 'agent_end', willRetry: true });
    expect(session.pendingError).toBe('temporary failure');
    expect(onError).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('successful retry clears the stale provisional error', () => {
    const { adapter, session, emit } = makeAdapter();
    const onError = vi.fn();
    const onIdle = vi.fn();
    const onMessage = vi.fn();
    adapter.onError = onError;
    adapter.onIdle = onIdle;
    adapter.onMessage = onMessage;
    emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'temporary failure' } });
    emit({ type: 'agent_end', willRetry: true });
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'recovered' }], stopReason: 'stop' } });
    expect(session.pendingError).toBeUndefined();
    emit({ type: 'agent_settled' });
    expect(onError).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'recovered' });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});

describe('Pi Kraki system prompt', () => {
  it('directs written reports through show_report and browser requests to the shell', () => {
    expect(KRAKI_SYSTEM_PROMPT).toContain('call show_report');
    expect(KRAKI_SYSTEM_PROMPT).toContain('remains accessible in the producing message');
    expect(KRAKI_SYSTEM_PROMPT).toContain('not a browser');
    expect(KRAKI_SYSTEM_PROMPT).not.toContain('show_html');
  });
});

describe('PI_KRAKI_TOOLS_SOURCE extension shape', () => {
  it('registers the human-facing tools and no finalize tool', () => {
    expect(PI_KRAKI_TOOLS_SOURCE).not.toContain('finalize_reply');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('name: "ask_user"');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('name: "show_image"');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('name: "show_report"');
    expect(PI_KRAKI_TOOLS_SOURCE).not.toContain('name: "show_html"');
    expect(PI_KRAKI_TOOLS_SOURCE).not.toContain('present_to_user');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('pi.registerTool');
  });

  it('show_image reads a file and returns an ImageContent block, whitelisted from the gate', () => {
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('from "node:fs"');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('readFileSync');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('type: "image"');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('"show_image"');
  });

  it('show_report returns a local attachment handle without returning HTML bytes to pi', () => {
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('details: { htmlPath: abs');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('krakiValidateReport(bytes)');
    expect(PI_KRAKI_TOOLS_SOURCE).not.toContain('htmlBase64');
  });

  it('whitelists the capability tools from the always-on permission gate', () => {
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('"ask_user"');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('"show_report"');
    // The gate is loaded in every mode (no KRAKI_PI_GATE env guard); the adapter
    // decides silent-approve vs card per its mode policy.
    expect(PI_KRAKI_TOOLS_SOURCE).not.toContain('process.env.KRAKI_PI_GATE');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('KRAKI_TOOLS');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('ctx.ui.confirm');
  });

  it('blocks tentacle self-management commands before mode approval with a reason', () => {
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('(?:stop|restart|update)');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('would terminate the tentacle hosting this session');
  });

  it('registers kraki_get_mode with a strict, non-empty input schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraki-pi-tools-'));
    const extensionPath = join(dir, 'kraki-tools.mjs');
    writeFileSync(extensionPath, PI_KRAKI_TOOLS_SOURCE);
    const tools = new Map<string, Record<string, unknown>>();
    const pi = {
      registerTool(tool: Record<string, unknown>) {
        tools.set(String(tool.name), tool);
      },
      on: vi.fn(),
    };

    try {
      const extension = await import(`${pathToFileURL(extensionPath).href}?test=${randomUUID()}`);
      extension.default(pi);
      const modeTool = tools.get('kraki_get_mode');

      expect(modeTool?.parameters).toEqual({
        type: 'object',
        properties: {
          query: {
            type: 'string',
            enum: ['current'],
            description: 'Request the current Kraki permission mode.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the live mode from the sidecar on every kraki_get_mode call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraki-pi-mode-'));
    const extensionPath = join(dir, 'kraki-tools.mjs');
    const metaPath = join(dir, 'meta.json');
    writeFileSync(extensionPath, PI_KRAKI_TOOLS_SOURCE);
    writeFileSync(metaPath, JSON.stringify({ mode: 'safe' }));
    const previousMetaFile = process.env.KRAKI_META_FILE;
    process.env.KRAKI_META_FILE = metaPath;
    const tools = new Map<string, Record<string, unknown>>();
    const pi = {
      registerTool(tool: Record<string, unknown>) {
        tools.set(String(tool.name), tool);
      },
      on: vi.fn(),
    };

    try {
      const extension = await import(`${pathToFileURL(extensionPath).href}?test=${randomUUID()}`);
      extension.default(pi);
      const execute = tools.get('kraki_get_mode')?.execute as () => Promise<unknown>;

      await expect(execute()).resolves.toMatchObject({
        content: [{ type: 'text', text: 'safe' }],
        details: { mode: 'safe' },
      });
      writeFileSync(metaPath, JSON.stringify({ mode: 'auto' }));
      await expect(execute()).resolves.toMatchObject({
        content: [{ type: 'text', text: 'auto' }],
        details: { mode: 'auto' },
      });
      // A sidecar written before the three-mode rename reads as the new name.
      writeFileSync(metaPath, JSON.stringify({ mode: 'execute' }));
      await expect(execute()).resolves.toMatchObject({ details: { mode: 'auto' } });
    } finally {
      if (previousMetaFile === undefined) delete process.env.KRAKI_META_FILE;
      else process.env.KRAKI_META_FILE = previousMetaFile;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses ctx.ui.select for choices and ctx.ui.input for free-form asks', () => {
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('ctx.ui.select');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('ctx.ui.input');
  });
});

// suppress unused-type lint for the Sess alias in some configs
export type { Sess };
