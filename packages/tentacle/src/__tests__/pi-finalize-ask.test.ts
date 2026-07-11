/**
 * Unit tests for the pi adapter's draft-bubble + finalize_reply turn model.
 *
 *  - ordinary assistant prose (message_end) → NARRATION: streams to the draft
 *    bubble (onMessageDelta) and is mirrored to the TRACE axis (onNarration).
 *  - the LAST narration is the kept draft; the agent's reply IS its prose.
 *  - at agent_end the adapter applies the SKIP-FINALIZE rule: exactly ONE
 *    narration segment with no tool after it is already a clean trailing reply →
 *    crystallize it directly (onMessage) with NO finalize round. Any other shape
 *    (multi-segment, ends-on-tool, zero narration) injects a finalize round: a
 *    prompt asking the model to call finalize_reply({resummarize, text?}).
 *  - finalize_reply is honored ONLY during the finalize round; resummarize:false
 *    keeps the drafted line, resummarize:true swaps in the streamed text.
 *  - ask_user → question card (extension_ui_request), NOT a TRACE step.
 *
 * We drive the adapter's private handleEvent directly with a fake session so no
 * real pi child is spawned.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAdapter } from '../adapters/pi.js';
import { PI_KRAKI_TOOLS_SOURCE } from '../adapters/pi-kraki-tools.js';

interface StubProc {
  alive: boolean;
  send: ReturnType<typeof vi.fn>;
  sendRaw: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
}

function makeAdapter() {
  const adapter = new PiAdapter({ cliPath: '/bin/true' });
  const sid = 's1';
  const proc: StubProc = {
    alive: true,
    send: vi.fn(),
    sendRaw: vi.fn(),
    request: vi.fn().mockResolvedValue({}),
  };
  const session = {
    proc,
    cwd: '/tmp',
    model: 'github-copilot/claude-opus-4.8',
    mode: 'execute',
    usage: {},
    lastActivity: Date.now(),
    pendingPerms: new Map<string, string>(),
    pendingQuestions: new Map<string, string>(),
    narrationSegments: 0,
    toolSinceLastNarration: false,
    lastNarration: '',
    pendingNarration: '',
    lastStopReason: undefined,
    aborting: false,
    finalizing: false,
    finalizeResolved: false,
    finalizeNarration: '',
    finalizeStreamLen: 0,
  };
  (adapter as unknown as { sessions: Map<string, unknown> }).sessions.set(sid, session);
  const emit = (e: Record<string, unknown>) =>
    (adapter as unknown as { handleEvent: (sid: string, e: Record<string, unknown>) => void }).handleEvent(sid, e);
  const narrate = (text: string) =>
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
  return { adapter, sid, proc, session, emit, narrate };
}

type Sess = ReturnType<typeof makeAdapter>['session'];

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

  it('text_delta streams to the draft bubble (onMessageDelta) when not finalizing', () => {
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

  it('message_end stopReason error surfaces onError and does NOT narrate', () => {
    const { adapter, session, emit } = makeAdapter();
    const onNarration = vi.fn();
    const onError = vi.fn();
    adapter.onNarration = onNarration;
    adapter.onError = onError;
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'error', errorMessage: 'boom' } });
    expect(onNarration).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('s1', { message: 'boom' });
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
    const { adapter, sid, proc } = makeAdapter();
    let acknowledge!: () => void;
    proc.request.mockReturnValueOnce(new Promise<void>((resolve) => { acknowledge = resolve; }));

    let resolved = false;
    const aborting = adapter.abortSession(sid).then(() => { resolved = true; });
    await Promise.resolve();

    expect(proc.request).toHaveBeenCalledWith('abort');
    expect(resolved).toBe(false);

    acknowledge();
    await aborting;
    expect(resolved).toBe(true);
  });

  it('suppresses finalize when pi emits agent_end during abort', async () => {
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

describe('pi inbound images (sendMessage → RPC prompt.images)', () => {
  it('converts ImageAttachment → pi ImageContent and passes it in the prompt', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.sendMessage('s1', 'what is this?', [
      { type: 'image', data: 'QUJD', mimeType: 'image/png', caption: 'a shot' },
    ]);
    expect(proc.request).toHaveBeenCalledWith('prompt', {
      message: 'what is this?',
      images: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }],
    });
  });

  it('omits the images field entirely when there are no image attachments', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.sendMessage('s1', 'plain text');
    expect(proc.request).toHaveBeenCalledWith('prompt', { message: 'plain text' });
  });

  it('drops non-image (ContentRef) attachments — they cannot be inlined', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.sendMessage('s1', 'hi', [
      { type: 'content_ref', id: 'abc', mimeType: 'image/png', size: 10 },
    ]);
    expect(proc.request).toHaveBeenCalledWith('prompt', { message: 'hi' });
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
      proc, cwd: '/tmp', model: 'm', mode: 'execute', usage: {}, lastActivity: Date.now(),
      pendingPerms: new Map(), pendingQuestions: new Map(), narrationSegments: 0,
      toolSinceLastNarration: false, lastNarration: '', lastStopReason: undefined, pendingNarration: '', aborting: false, finalizing: false,
      finalizeResolved: false, finalizeNarration: '', finalizeStreamLen: 0,
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

describe('pi skip-finalize rule (one trailing narration → direct reply)', () => {
  it('exactly one narration, no tool after → crystallize directly, NO finalize round', () => {
    const { adapter, proc, emit, narrate } = makeAdapter();
    const onMessage = vi.fn();
    const onIdle = vi.fn();
    const onNarrationTrace = vi.fn();
    adapter.onMessage = onMessage;
    adapter.onIdle = onIdle;
    adapter.onNarrationTrace = onNarrationTrace;

    narrate('Here is your answer.');
    emit({ type: 'agent_end' });

    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'Here is your answer.' });
    // The trailing narration graduated INTO the bubble — it must NOT also be
    // traced as a Step (the duplication bug this fix targets).
    expect(onNarrationTrace).not.toHaveBeenCalled();
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(proc.send).not.toHaveBeenCalled(); // no finalize prompt injected
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
    emit({ type: 'agent_end' });

    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'Your tree is clean.' });
    // The explanation is the reply (bubble), not a Step.
    expect(onNarrationTrace).not.toHaveBeenCalled();
    expect(proc.send).not.toHaveBeenCalled();
  });
});

describe('pi Steps dedup — trailing narration never traced as its own bubble', () => {
  it('two narrations, last is trailing → first is a Step, the graduating last is NOT (no finalize round)', () => {
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

    emit({ type: 'agent_end' }); // 2 segments, last is trailing → graduate directly, no finalize round

    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'Now here is the conclusion.' });
    // The concluding narration graduated into the bubble → still exactly ONE trace step.
    expect(onNarrationTrace).toHaveBeenCalledTimes(1);
    // No finalize round is injected for a multi-segment turn with a clean trailing reply.
    expect(proc.send).not.toHaveBeenCalledWith('prompt', expect.anything());
  });

  it('genuine finalize fallback (ends on a tool) keeps the keep-last trace discipline', () => {
    const { adapter, emit, narrate } = makeAdapter();
    const onMessage = vi.fn();
    const onNarrationTrace = vi.fn();
    adapter.onMessage = onMessage;
    adapter.onNarrationTrace = onNarrationTrace;

    narrate('First pass thoughts.'); // trailing so far
    // A real tool follows → the narration is now an intermediate step, traced now.
    emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' }, toolCallId: 't1' });
    emit({ type: 'tool_execution_end', toolName: 'bash', result: 'x', toolCallId: 't1', isError: false });
    emit({ type: 'agent_end' }); // ended on a tool, no trailing reply → finalize round
    emit({ type: 'tool_execution_start', toolName: 'finalize_reply', args: { resummarize: true, text: 'A tidy summary.' }, toolCallId: 'f1' });

    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'A tidy summary.' });
    expect(onNarrationTrace).toHaveBeenCalledTimes(1);
    expect(onNarrationTrace).toHaveBeenCalledWith('s1', { content: 'First pass thoughts.' });
  });
});

describe('pi finalize round (only when no trailing reply)', () => {
  it('multi-segment with a clean trailing reply graduates directly, NO finalize round', () => {
    const { adapter, proc, session, emit, narrate } = makeAdapter();
    const onIdle = vi.fn();
    const onMessage = vi.fn();
    adapter.onIdle = onIdle;
    adapter.onMessage = onMessage;

    narrate('First I will look around.');
    narrate('Now here is the conclusion.');
    emit({ type: 'agent_end' });

    expect(session.finalizing).toBe(false);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'Now here is the conclusion.' });
    expect(proc.send).not.toHaveBeenCalledWith('prompt', expect.anything());
  });

  it('ends on a tool (narration then tool, no trailing reply) → finalize round', () => {
    const { adapter, proc, session, emit, narrate } = makeAdapter();
    adapter.onIdle = vi.fn();
    narrate('Let me run this.');
    emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' }, toolCallId: 't1' });
    emit({ type: 'tool_execution_end', toolName: 'bash', result: 'x', toolCallId: 't1', isError: false });
    emit({ type: 'agent_end' });
    expect(session.finalizing).toBe(true);
    expect(proc.send).toHaveBeenCalledWith('prompt', expect.objectContaining({ message: expect.stringContaining('finalize_reply') }));
  });

  it('zero narration (tool only) → finalize round', () => {
    const { adapter, proc, session, emit } = makeAdapter();
    adapter.onIdle = vi.fn();
    emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' }, toolCallId: 't1' });
    emit({ type: 'tool_execution_end', toolName: 'bash', result: 'x', toolCallId: 't1', isError: false });
    emit({ type: 'agent_end' });
    expect(session.finalizing).toBe(true);
    expect(proc.send).toHaveBeenCalledWith('prompt', expect.objectContaining({ message: expect.stringContaining('finalize_reply') }));
  });

  it('backend error stopReason → no finalize round, no reply, just idle (error already surfaced)', () => {
    const { adapter, proc, session, emit } = makeAdapter();
    const onIdle = vi.fn();
    const onMessage = vi.fn();
    const onError = vi.fn();
    adapter.onIdle = onIdle;
    adapter.onMessage = onMessage;
    adapter.onError = onError;
    emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'quota exceeded' } });
    emit({ type: 'agent_end' });
    expect(session.finalizing).toBe(false);
    expect(onError).toHaveBeenCalledWith('s1', { message: 'quota exceeded' });
    expect(onMessage).not.toHaveBeenCalled();
    expect(proc.send).not.toHaveBeenCalledWith('prompt', expect.anything());
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('aborted stopReason → no finalize round, just idle', () => {
    const { adapter, proc, session, emit } = makeAdapter();
    const onIdle = vi.fn();
    const onMessage = vi.fn();
    adapter.onIdle = onIdle;
    adapter.onMessage = onMessage;
    emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' } });
    emit({ type: 'agent_end' });
    expect(session.finalizing).toBe(false);
    expect(onMessage).not.toHaveBeenCalled();
    expect(proc.send).not.toHaveBeenCalledWith('prompt', expect.anything());
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('suppresses draft narration deltas during the finalize round (draft frozen)', () => {
    const { adapter, session, emit } = makeAdapter();
    const onMessageDelta = vi.fn();
    adapter.onMessageDelta = onMessageDelta;
    session.finalizing = true;
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'pre-thinking' } });
    expect(onMessageDelta).not.toHaveBeenCalled();
  });

  it('finalize-round prose is captured as a fallback (not traced, not a segment)', () => {
    const { adapter, session, emit } = makeAdapter();
    const onNarration = vi.fn();
    adapter.onNarration = onNarration;
    session.finalizing = true;
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'concluding thoughts' }], stopReason: 'stop' } });
    expect(onNarration).not.toHaveBeenCalled();
    expect(session.finalizeNarration).toBe('concluding thoughts');
    expect(session.narrationSegments).toBe(0);
  });
});

describe('pi finalize_reply crystallization', () => {
  function inFinalize() {
    const h = makeAdapter();
    h.session.finalizing = true;
    h.session.lastNarration = 'drafted closing line';
    return h;
  }

  it('resummarize:false → keeps the drafted line as the reply', () => {
    const { adapter, session, emit } = inFinalize();
    const onMessage = vi.fn();
    adapter.onMessage = onMessage;
    emit({ type: 'tool_execution_start', toolName: 'finalize_reply', args: { resummarize: false }, toolCallId: 't1' });
    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'drafted closing line' });
    expect(session.finalizeResolved).toBe(true);
  });

  it('resummarize:true with text → swaps in the rewritten summary', () => {
    const { adapter, session, emit } = inFinalize();
    const onMessage = vi.fn();
    adapter.onMessage = onMessage;
    emit({ type: 'tool_execution_start', toolName: 'finalize_reply', args: { resummarize: true, text: 'A short clean summary.' }, toolCallId: 't1' });
    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'A short clean summary.' });
    expect(session.finalizeResolved).toBe(true);
  });

  it('resummarize:true with empty text falls back to the drafted line', () => {
    const { adapter, emit } = inFinalize();
    const onMessage = vi.fn();
    adapter.onMessage = onMessage;
    emit({ type: 'tool_execution_start', toolName: 'finalize_reply', args: { resummarize: true, text: '   ' }, toolCallId: 't1' });
    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'drafted closing line' });
  });

  it('both empty (no draft, resummarize:false) → no_reply notice', () => {
    const { adapter, session, emit } = inFinalize();
    session.lastNarration = '';
    const onMessage = vi.fn();
    const onSystemMessage = vi.fn();
    adapter.onMessage = onMessage;
    adapter.onSystemMessage = onSystemMessage;
    emit({ type: 'tool_execution_start', toolName: 'finalize_reply', args: { resummarize: false }, toolCallId: 't1' });
    expect(onMessage).not.toHaveBeenCalled();
    expect(onSystemMessage).toHaveBeenCalledWith('s1', { kind: 'no_reply' });
  });

  it('finalize_reply OUTSIDE a finalize round is ignored (spontaneous call)', () => {
    const { adapter, emit } = makeAdapter(); // finalizing = false
    const onMessage = vi.fn();
    adapter.onMessage = onMessage;
    emit({ type: 'tool_execution_start', toolName: 'finalize_reply', args: { resummarize: true, text: 'sneaky' }, toolCallId: 't1' });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('finalize_reply is not a TRACE step (no onToolStart / onToolComplete)', () => {
    const { adapter, emit } = inFinalize();
    const onToolStart = vi.fn();
    const onToolComplete = vi.fn();
    adapter.onToolStart = onToolStart;
    adapter.onToolComplete = onToolComplete;
    adapter.onMessage = vi.fn();
    emit({ type: 'tool_execution_start', toolName: 'finalize_reply', args: { resummarize: false }, toolCallId: 't1' });
    emit({ type: 'tool_execution_end', toolName: 'finalize_reply', result: 'ok', toolCallId: 't1' });
    expect(onToolStart).not.toHaveBeenCalled();
    expect(onToolComplete).not.toHaveBeenCalled();
  });

  it('agent_end after the finalize round clears finalizing and idles', () => {
    const { adapter, session, emit } = inFinalize();
    const onIdle = vi.fn();
    adapter.onMessage = vi.fn();
    adapter.onIdle = onIdle;
    emit({ type: 'tool_execution_start', toolName: 'finalize_reply', args: { resummarize: false }, toolCallId: 't1' });
    emit({ type: 'agent_end' });
    expect(session.finalizing).toBe(false);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('finalize round that ends WITHOUT finalize_reply falls back to its prose', () => {
    const { adapter, session, emit } = inFinalize();
    const onMessage = vi.fn();
    const onIdle = vi.fn();
    adapter.onMessage = onMessage;
    adapter.onIdle = onIdle;
    session.finalizeNarration = 'model wrote this instead';
    emit({ type: 'agent_end' });
    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'model wrote this instead' });
    expect(session.finalizing).toBe(false);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('finalize round with neither call nor prose falls back to the kept draft', () => {
    const { adapter, session, emit } = inFinalize();
    const onMessage = vi.fn();
    adapter.onMessage = onMessage;
    adapter.onIdle = vi.fn();
    emit({ type: 'agent_end' });
    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'drafted closing line' });
  });
});

describe('pi finalize_reply.text streams as onFinalizeDelta', () => {
  const finalizeDelta = (text: string, id = 'f1', contentIndex = 0) => ({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_delta',
      contentIndex,
      partial: { content: [{ type: 'toolCall', id, name: 'finalize_reply', arguments: { text } }] },
    },
  });

  it('forwards only the newly-revealed suffix of the streamed text', () => {
    const { adapter, emit } = makeAdapter();
    const onFinalizeDelta = vi.fn();
    adapter.onFinalizeDelta = onFinalizeDelta;
    emit(finalizeDelta('✅ 命'));
    emit(finalizeDelta('✅ 命令执行'));
    emit(finalizeDelta('✅ 命令执行成功。'));
    expect(onFinalizeDelta.mock.calls.map((c) => c[1].content)).toEqual(['✅ 命', '令执行', '成功。']);
  });

  it('ignores toolcall_delta for non-finalize tools (e.g. bash)', () => {
    const { adapter, emit } = makeAdapter();
    const onFinalizeDelta = vi.fn();
    adapter.onFinalizeDelta = onFinalizeDelta;
    emit({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_delta',
        contentIndex: 0,
        partial: { content: [{ type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: 'echo hi' } }] },
      },
    });
    expect(onFinalizeDelta).not.toHaveBeenCalled();
  });

  it('resets the emitted-length when a new finalize call (new id) begins', () => {
    const { adapter, emit } = makeAdapter();
    const onFinalizeDelta = vi.fn();
    adapter.onFinalizeDelta = onFinalizeDelta;
    emit(finalizeDelta('Hello', 'f1'));
    emit(finalizeDelta('Hi', 'f2'));
    expect(onFinalizeDelta.mock.calls.map((c) => c[1].content)).toEqual(['Hello', 'Hi']);
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
      allowFreeform: false,
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
      allowFreeform: true,
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

  it('confirm for a non-write tool in discuss → auto-approved silently (no card)', () => {
    const { adapter, proc, session, emit } = makeAdapter();
    session.mode = 'discuss';
    const onPermissionRequest = vi.fn();
    adapter.onPermissionRequest = onPermissionRequest;
    emit({ type: 'extension_ui_request', method: 'confirm', id: 'p1', title: 'bash', message: JSON.stringify({ command: 'ls' }) });
    expect(onPermissionRequest).not.toHaveBeenCalled();
    expect(proc.sendRaw).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'p1', confirmed: true });
    expect(session.pendingPerms.has('p1')).toBe(false);
  });

  it('confirm for a file write in discuss → raises a permission card', () => {
    const { adapter, session, emit } = makeAdapter();
    session.mode = 'discuss';
    const onPermissionRequest = vi.fn();
    adapter.onPermissionRequest = onPermissionRequest;
    emit({ type: 'extension_ui_request', method: 'confirm', id: 'p1', title: 'write', message: JSON.stringify({ path: '/tmp/a.txt', content: 'x' }) });
    expect(onPermissionRequest).toHaveBeenCalledTimes(1);
    expect(session.pendingPerms.get('p1')).toBe('p1');
  });

  it('confirm for a plan.md write in discuss → auto-approved silently (allowlisted)', () => {
    const { adapter, proc, session, emit } = makeAdapter();
    session.mode = 'discuss';
    const onPermissionRequest = vi.fn();
    adapter.onPermissionRequest = onPermissionRequest;
    emit({ type: 'extension_ui_request', method: 'confirm', id: 'p1', title: 'write', message: JSON.stringify({ path: '/repo/plan.md', content: 'x' }) });
    expect(onPermissionRequest).not.toHaveBeenCalled();
    expect(proc.sendRaw).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'p1', confirmed: true });
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

  it('respondToQuestion sends extension_ui_response value and clears pending', async () => {
    const { adapter, proc, session } = makeAdapter();
    session.pendingQuestions.set('q1', 'q1');
    await adapter.respondToQuestion('s1', 'q1', 'red', false);
    expect(proc.sendRaw).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'q1', value: 'red' });
    expect(session.pendingQuestions.has('q1')).toBe(false);
  });

  it('respondToQuestion for an unknown question is a no-op', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.respondToQuestion('s1', 'nope', 'x', false);
    expect(proc.sendRaw).not.toHaveBeenCalled();
  });
});

describe('pi agent_end guards', () => {
  it('does not idle prematurely on a willRetry agent_end', () => {
    const { adapter, emit } = makeAdapter();
    const onIdle = vi.fn();
    adapter.onIdle = onIdle;
    emit({ type: 'agent_end', willRetry: true });
    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe('PI_KRAKI_TOOLS_SOURCE extension shape', () => {
  it('registers the human-facing + finalize tools', () => {
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('name: "finalize_reply"');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('name: "ask_user"');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('name: "show_image"');
    expect(PI_KRAKI_TOOLS_SOURCE).not.toContain('present_to_user');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('pi.registerTool');
  });

  it('show_image reads a file and returns an ImageContent block, whitelisted from the gate', () => {
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('from "node:fs"');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('readFileSync');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('type: "image"');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('"show_image"');
  });

  it('whitelists the capability tools from the always-on permission gate', () => {
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('"finalize_reply"');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('"ask_user"');
    // The gate is loaded in every mode (no KRAKI_PI_GATE env guard); the adapter
    // decides silent-approve vs card per its mode policy.
    expect(PI_KRAKI_TOOLS_SOURCE).not.toContain('process.env.KRAKI_PI_GATE');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('KRAKI_TOOLS');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('ctx.ui.confirm');
  });

  it('registers kraki_get_mode reading the KRAKI_META_FILE sidecar', () => {
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('name: "kraki_get_mode"');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('KRAKI_META_FILE');
  });

  it('uses ctx.ui.select for choices and ctx.ui.input for free-form asks', () => {
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('ctx.ui.select');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('ctx.ui.input');
  });
});

// suppress unused-type lint for the Sess alias in some configs
export type { Sess };
