/**
 * A subagent's prose, errors and turn boundaries belong to the subagent — the
 * parent only sees its tool steps and the dispatching tool's result. Event
 * shapes follow live traces (Copilot SDK 1.0.1: top-level `agentId` on subagent
 * events) and the Claude Agent SDK 0.3.156 types (`parent_tool_use_id`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotAdapter } from '../adapters/copilot.js';
import { ClaudeAdapter } from '../adapters/claude.js';

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }));

type Rec = { cb: string; data: Record<string, unknown> };
function record(adapter: object): Rec[] {
  const out: Rec[] = [];
  for (const k of Object.keys(adapter)) {
    if (/^on[A-Z]/.test(k) && (adapter as Record<string, unknown>)[k] === null) {
      (adapter as Record<string, unknown>)[k] = (_sid: string, data: Record<string, unknown> = {}) => out.push({ cb: k, data });
    }
  }
  return out;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Copilot subagent events', () => {
  function wired() {
    const adapter = new CopilotAdapter();
    const handlers = new Map<string, Array<(e: unknown) => unknown>>();
    const session = {
      on: (type: unknown, fn?: (e: unknown) => unknown) => {
        if (typeof type === 'string' && fn) handlers.set(type, [...(handlers.get(type) ?? []), fn]);
        return () => {};
      },
    };
    const internals = adapter as unknown as {
      sessions: Map<string, unknown>; wireEvents: (id: string, s: unknown) => void; probeRuntime: () => Promise<string>;
    };
    internals.sessions.set('s1', { session, pendingPermissions: new Map(), pendingQuestions: new Map(), relayTurnId: undefined, turnSettled: false });
    internals.probeRuntime = async () => 'alive';
    internals.wireEvents('s1', session);
    const rec = record(adapter);
    const fire = (type: string, data: Record<string, unknown> = {}, agentId?: string) => {
      for (const fn of handlers.get(type) ?? []) void fn({ type, data, ...(agentId && { agentId }) });
    };
    return { fire, rec };
  }

  it('keeps the subagent reply out of the parent reply (live trace order)', async () => {
    const { fire, rec } = wired();
    const A = 'toolu_TASK';
    fire('assistant.turn_start', { turnId: '0' });
    fire('assistant.usage', { inputTokens: 23182, outputTokens: 10 });
    fire('assistant.message', { content: '' });
    fire('subagent.started', { toolCallId: A, agentName: 'explore' });
    fire('tool.execution_start', { toolCallId: A, toolName: 'task', arguments: { agent_type: 'explore' } });
    fire('assistant.turn_start', { turnId: '0' }, A);
    fire('assistant.usage', { inputTokens: 4796, outputTokens: 5 }, A);
    fire('tool.execution_start', { toolCallId: 'g1', toolName: 'grep', parentToolCallId: A, arguments: { pattern: 'CODEWORD' } }, A);
    fire('tool.execution_complete', { toolCallId: 'g1', parentToolCallId: A, success: true, result: { content: 'config.ts: purple-otter-42' } }, A);
    fire('assistant.turn_end', { turnId: '0' }, A);
    fire('assistant.message_delta', { deltaContent: '**Found:**' }, A);
    fire('assistant.message', { content: '**Found:** config.ts: purple-otter-42' }, A);
    fire('assistant.turn_end', { turnId: '1', reason: 'error', error: 'subagent blew up' }, A);
    fire('subagent.completed', { toolCallId: A });
    fire('tool.execution_complete', { toolCallId: A, success: true, result: { content: 'Found: config.ts' } });
    fire('assistant.turn_end', { turnId: '0' });
    fire('assistant.message_delta', { deltaContent: 'config.ts: purple-otter-42' });
    fire('assistant.message', { content: 'config.ts: purple-otter-42' });
    fire('session.idle');
    await tick(); await tick();

    expect(rec.filter((r) => r.cb === 'onMessage').map((r) => r.data.content)).toEqual(['config.ts: purple-otter-42']);
    expect(rec.filter((r) => r.cb === 'onMessageDelta').map((r) => r.data.content)).toEqual(['config.ts: purple-otter-42']);
    expect(rec.filter((r) => r.cb === 'onError')).toHaveLength(0);
    // Subagent steps still show.
    expect(rec.filter((r) => r.cb === 'onToolStart').map((r) => r.data.toolName)).toEqual(['task', 'grep']);
    // Usage counts the subagent's tokens, but context is the parent's window.
    const usage = rec.filter((r) => r.cb === 'onUsageUpdate').at(-1)!.data;
    expect(usage).toMatchObject({ inputTokens: 23182 + 4796, contextTokens: 23182 });
  });

  it('a subagent session.error does not fail the parent turn', async () => {
    const { fire, rec } = wired();
    fire('session.error', { message: 'subagent 400', statusCode: 400 }, 'toolu_TASK');
    fire('assistant.message', { content: 'done' });
    fire('session.idle');
    await tick();
    expect(rec.filter((r) => r.cb === 'onError')).toHaveLength(0);
    expect(rec.filter((r) => r.cb === 'onMessage').map((r) => r.data.content)).toEqual(['done']);
  });
});

describe('Claude subagent messages', () => {
  let root: string, claude: ClaudeAdapter;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kraki-subagent-'));
    for (const [k, v] of Object.entries({ HOME: root, KRAKI_HOME: join(root, 'kraki') })) { saved[k] = process.env[k]; process.env[k] = v; mkdirSync(v, { recursive: true }); }
    claude = new ClaudeAdapter();
    sdk.query.mockReset().mockImplementation(() => ({ supportedModels: async () => [], [Symbol.asyncIterator]: async function* () {} }));
  });
  afterEach(async () => {
    await claude.stop();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps forwarded subagent text, stream and errors out of the parent reply', async () => {
    await claude.createSession({ sessionId: 's', cwd: root, model: 'sonnet' });
    const rec = record(claude);
    const h = (m: Record<string, unknown>) => (claude as unknown as { handleSDKMessage: (id: string, m: unknown) => void }).handleSDKMessage('s', m);
    const P = 'toolu_TASK';
    const asst = (content: unknown[], parent: string | null = null, usage?: Record<string, number>) =>
      h({ type: 'assistant', parent_tool_use_id: parent, message: { content, ...(usage && { usage }) } });
    const delta = (text: string, parent: string | null = null) =>
      h({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });

    delta('Delegating.'); asst([{ type: 'text', text: 'Delegating.' }], null, { input_tokens: 9000 });
    asst([{ type: 'tool_use', id: P, name: 'Task', input: { subagent_type: 'Explore' } }]);
    delta('I will grep.', P); asst([{ type: 'text', text: 'I will grep.' }], P, { input_tokens: 500 });
    asst([{ type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'CODEWORD' } }], P);
    h({ type: 'user', parent_tool_use_id: P, message: { content: [{ type: 'tool_result', tool_use_id: 'g1', content: 'config.ts' }] } });
    delta('**Found:** config.ts', P); asst([{ type: 'text', text: '**Found:** config.ts' }], P);
    h({ type: 'assistant', parent_tool_use_id: P, error: 'rate_limit', message: { content: [] } });
    h({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: P, content: 'Found: config.ts' }] } });
    delta('config.ts: purple-otter-42'); asst([{ type: 'text', text: 'config.ts: purple-otter-42' }]);
    h({ type: 'result', subtype: 'success', is_error: false });

    expect(rec.filter((r) => r.cb === 'onMessage').map((r) => r.data.content)).toEqual(['config.ts: purple-otter-42']);
    expect(rec.filter((r) => r.cb === 'onNarration').map((r) => r.data.content)).toEqual(['Delegating.']);
    expect(rec.filter((r) => r.cb === 'onMessageDelta').map((r) => r.data.content)).toEqual(['Delegating.', 'config.ts: purple-otter-42']);
    expect(rec.filter((r) => r.cb === 'onError')).toHaveLength(0);
    expect(rec.filter((r) => r.cb === 'onToolStart').map((r) => r.data.toolName)).toEqual(['Task', 'Grep']);
    expect(rec.filter((r) => r.cb === 'onUsageUpdate').at(-1)!.data).toMatchObject({ inputTokens: 9500, contextTokens: 9000 });
  });

  describe('background subagents (Claude Code 2.1.220 default)', () => {
    // Shapes from a live run of the real Claude Code CLI against a loopback API.
    const P1 = 'toolu_A', P2 = 'toolu_B';
    let rec: Rec[];
    let h: (m: Record<string, unknown>) => void;
    const query = { stopTask: vi.fn(async () => {}), interrupt: vi.fn(async () => {}) };
    beforeEach(async () => {
      await claude.createSession({ sessionId: 's', cwd: root, model: 'sonnet' });
      rec = record(claude);
      const internals = claude as unknown as { sessions: Map<string, { query: unknown; turnFinalized?: boolean }>; handleSDKMessage: (id: string, m: unknown) => void };
      internals.sessions.get('s')!.query = query; internals.sessions.get('s')!.turnFinalized = false;
      query.stopTask.mockClear();
      h = (m) => internals.handleSDKMessage('s', m);
    });
    const text = (t: string, parent: string | null = null) => h({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text: t }] } });
    const launch = (id: string, task: string, desc: string) => {
      h({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { description: desc } }] } });
      h({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: id, description: desc, subagent_type: 'general-purpose', task_type: 'local_agent' });
      h({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Async agent launched successfully.' }] } });
    };
    const done = (task: string, id: string) => {
      h({ type: 'system', subtype: 'task_updated', task_id: task, patch: { status: 'completed' } });
      h({ type: 'system', subtype: 'task_notification', task_id: task, tool_use_id: id, status: 'completed', summary: 'report' });
    };
    const result = () => h({ type: 'result', subtype: 'success', is_error: false });
    const continuation = (t: string) => { h({ type: 'system', subtype: 'init', session_id: 'sdk' }); text(t); result(); };
    const replies = () => rec.filter((r) => r.cb === 'onMessage').map((r) => r.data.content);
    const idles = () => rec.filter((r) => r.cb === 'onIdle').length;

    it('holds the turn open until Claude Code wakes the parent with the answer', () => {
      text('Delegating.'); launch(P1, 'a1', 'Find codeword'); text('Waiting for the subagent.'); result();
      expect(idles()).toBe(0);
      expect(claude.isTurnSettled('s')).toBe(false);
      expect(rec.filter((r) => r.cb === 'onNarration').map((r) => r.data.content)).toEqual(['Delegating.', 'Waiting for the subagent.']);
      text('SUBAGENT REPORT', P1); done('a1', P1);
      continuation('src/deep/config.ts: purple-otter-42');
      expect(replies()).toEqual(['src/deep/config.ts: purple-otter-42']);
      expect(idles()).toBe(1);
    });

    it('parallel subagents: one continuation per completion, the last one answers', () => {
      launch(P1, 'a1', 'Find codeword'); launch(P2, 'a2', 'Count'); text('Waiting.'); result();
      done('a1', P1); done('a2', P2);
      continuation('Waiting.');
      expect(idles()).toBe(0);
      continuation('both done');
      expect(replies()).toEqual(['both done']);
      expect(idles()).toBe(1);
    });

    it('settles after a grace period when no continuation arrives', () => {
      vi.useFakeTimers();
      try {
        launch(P1, 'a1', 'Find codeword'); text('Waiting.'); result();
        done('a1', P1);
        expect(idles()).toBe(0);
        vi.advanceTimersByTime(ClaudeAdapter.SUBAGENT_CONTINUATION_GRACE_MS + 1);
        expect(idles()).toBe(1);
        expect(claude.isTurnSettled('s')).toBe(true);
      } finally { vi.useRealTimers(); }
    });

    it('stop while held settles silently and stops the running subagents', async () => {
      launch(P1, 'a1', 'Find codeword'); text('Waiting.'); result();
      await claude.abortSession('s');
      expect(query.stopTask).toHaveBeenCalledWith('a1');
      expect(claude.isTurnSettled('s')).toBe(true);
      expect(idles()).toBe(0);
      expect(replies()).toEqual([]);
    });

    it('an interjection while held owns the next provider turn', async () => {
      claude.setTurnIdentity('s', 'turn-1');
      (claude as unknown as { sessions: Map<string, { eventTurnId?: string }> }).sessions.get('s')!.eventTurnId = 'turn-1';
      launch(P1, 'a1', 'Find codeword'); text('Waiting.'); result();
      const internals = claude as unknown as { sessions: Map<string, { inputChannel: { push: (m: unknown) => void } }> };
      internals.sessions.get('s')!.inputChannel.push = () => {};
      claude.setTurnIdentity('s', 'turn-2');
      await claude.sendMessage('s', 'also check X', undefined, { delivery: 'steer' });
      continuation('checked X; still waiting');
      expect(idles()).toBe(0); // the subagent is still running
      done('a1', P1);
      continuation('final answer');
      expect(rec.filter((r) => r.cb === 'onNarration').at(-1)!.data).toEqual({ content: 'checked X; still waiting', turnId: 'turn-2' });
      expect(rec.filter((r) => r.cb === 'onMessage')).toEqual([{ cb: 'onMessage', data: { content: 'final answer', turnId: 'turn-2' } }]);
      expect(rec.filter((r) => r.cb === 'onIdle').map((r) => r.data)).toEqual([{ turnId: 'turn-2' }]);
    });

    it('sync (foreground) subagents settle on the first result as before', () => {
      launch(P1, 'a1', 'Find codeword'); done('a1', P1); text('answer'); result();
      expect(replies()).toEqual(['answer']);
      expect(idles()).toBe(1);
    });

    it('a background shell task never holds the turn', () => {
      h({ type: 'system', subtype: 'task_started', task_id: 'b1', description: 'dev server', task_type: 'local_bash' });
      text('started the server'); result();
      expect(idles()).toBe(1);
    });
  });
});
