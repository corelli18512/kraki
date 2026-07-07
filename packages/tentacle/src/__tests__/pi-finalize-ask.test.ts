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
  it('message_end prose → onNarration (TRACE) and tracks it as the kept draft', () => {
    const { adapter, session, narrate } = makeAdapter();
    const onNarration = vi.fn();
    const onMessage = vi.fn();
    adapter.onNarration = onNarration;
    adapter.onMessage = onMessage;

    narrate('  let me think...  ');

    expect(onNarration).toHaveBeenCalledWith('s1', { content: 'let me think...' });
    // Narration is NOT itself a spine bubble — it graduates at idle.
    expect(onMessage).not.toHaveBeenCalled();
    expect(session.narrationSegments).toBe(1);
    expect(session.lastNarration).toBe('let me think...');
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

  it('a real tool marks toolSinceLastNarration and flows through TRACE', () => {
    const { adapter, session, emit, narrate } = makeAdapter();
    const onToolStart = vi.fn();
    const onToolComplete = vi.fn();
    adapter.onToolStart = onToolStart;
    adapter.onToolComplete = onToolComplete;
    narrate('working on it');
    expect(session.toolSinceLastNarration).toBe(false);
    emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' }, toolCallId: 't9' });
    emit({ type: 'tool_execution_end', toolName: 'bash', result: 'files', toolCallId: 't9', isError: false });
    expect(onToolStart).toHaveBeenCalledTimes(1);
    expect(onToolComplete).toHaveBeenCalledTimes(1);
    expect(session.toolSinceLastNarration).toBe(true);
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
      toolSinceLastNarration: false, lastNarration: '', finalizing: false,
      finalizeResolved: false, finalizeNarration: '', finalizeStreamLen: 0,
    });
    const emit = (e: Record<string, unknown>) =>
      (adapter as unknown as { handleEvent: (sid: string, e: Record<string, unknown>) => void }).handleEvent(sid, e);
    return { adapter, emit, put };
  }

  it('extracts image blocks from a tool result into the attachment store + broadcasts bytes', () => {
    const { adapter, emit, put } = makeAdapterWithStore();
    const onToolComplete = vi.fn();
    const onAttachmentBytes = vi.fn();
    adapter.onToolComplete = onToolComplete;
    adapter.onAttachmentBytes = onAttachmentBytes;

    emit({
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
    adapter.onMessage = onMessage;
    adapter.onIdle = onIdle;

    narrate('Here is your answer.');
    emit({ type: 'agent_end' });

    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'Here is your answer.' });
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(proc.send).not.toHaveBeenCalled(); // no finalize prompt injected
  });

  it('tool THEN one explanation (git → explain) → skip, direct reply', () => {
    const { adapter, proc, emit, narrate } = makeAdapter();
    const onMessage = vi.fn();
    adapter.onMessage = onMessage;

    emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'git status' }, toolCallId: 't1' });
    emit({ type: 'tool_execution_end', toolName: 'bash', result: 'clean', toolCallId: 't1', isError: false });
    narrate('Your tree is clean.'); // one narration AFTER the tool → trailing reply
    emit({ type: 'agent_end' });

    expect(onMessage).toHaveBeenCalledWith('s1', { content: 'Your tree is clean.' });
    expect(proc.send).not.toHaveBeenCalled();
  });
});

describe('pi finalize round (dropped narration → conclude)', () => {
  it('TWO narration segments → inject a finalize prompt seeded with the last draft', () => {
    const { adapter, proc, session, emit, narrate } = makeAdapter();
    const onIdle = vi.fn();
    const onMessage = vi.fn();
    adapter.onIdle = onIdle;
    adapter.onMessage = onMessage;

    narrate('First I will look around.');
    narrate('Now here is the conclusion.');
    emit({ type: 'agent_end' });

    expect(session.finalizing).toBe(true);
    expect(onIdle).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    const sent = proc.send.mock.calls.find((c) => c[0] === 'prompt');
    expect(sent).toBeTruthy();
    expect(sent?.[1].message).toContain('finalize_reply');
    expect(sent?.[1].message).toContain('Now here is the conclusion.'); // seeded draft
  });

  it('ends on a tool (narration then tool) → finalize round', () => {
    const { adapter, proc, session, emit, narrate } = makeAdapter();
    adapter.onIdle = vi.fn();
    narrate('Let me run this.');
    emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' }, toolCallId: 't1' });
    emit({ type: 'tool_execution_end', toolName: 'bash', result: 'x', toolCallId: 't1', isError: false });
    emit({ type: 'agent_end' });
    expect(session.finalizing).toBe(true);
    expect(proc.send).toHaveBeenCalledWith('prompt', expect.objectContaining({ message: expect.stringContaining('finalize_reply') }));
  });

  it('zero narration → finalize round', () => {
    const { adapter, proc, session, emit } = makeAdapter();
    adapter.onIdle = vi.fn();
    emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' }, toolCallId: 't1' });
    emit({ type: 'tool_execution_end', toolName: 'bash', result: 'x', toolCallId: 't1', isError: false });
    emit({ type: 'agent_end' });
    expect(session.finalizing).toBe(true);
    expect(proc.send).toHaveBeenCalledWith('prompt', expect.objectContaining({ message: expect.stringContaining('finalize_reply') }));
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
