/**
 * Switching a session to auto/delegate releases what already waits on the
 * human (base contract, as Pi does): permissions are approved through each
 * adapter's normal approve path, and delegate answers open questions.
 * Claude, Copilot and Codex.
 */
import { describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude.js';
import { CopilotAdapter } from '../adapters/copilot.js';
import { CodexAdapter } from '../adapters/codex.js';
import { DELEGATE_ANSWER } from '../adapters/permission-policy.js';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function callbacks(adapter: { onPermissionAutoResolved: unknown; onQuestionAutoResolved: unknown }) {
  const perm = vi.fn();
  const question = vi.fn();
  adapter.onPermissionAutoResolved = perm;
  adapter.onQuestionAutoResolved = question;
  return { perm, question };
}

describe('Claude mode switch', () => {
  function setup() {
    const adapter = new ClaudeAdapter({});
    const permResolve = vi.fn();
    const questionResolve = vi.fn();
    const entry = {
      pendingPermissions: new Map([['perm-1', { resolve: permResolve, toolKind: 'shell', input: { command: 'rm x' } }]]),
      pendingQuestions: new Map([['q-1', {
        resolve: questionResolve, questionId: 'q-1', qIndex: 1,
        questions: [{ question: 'First?' }, { question: 'Second?' }], collected: { 'First?': 'yes' },
      }]]),
    };
    (adapter as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', entry);
    adapter.setSessionMode('s1', 'safe');
    return { adapter, entry, permResolve, questionResolve, ...callbacks(adapter) };
  }

  it('auto approves the waiting permission with its original input', () => {
    const t = setup();
    t.adapter.setSessionMode('s1', 'auto');
    expect(t.permResolve).toHaveBeenCalledWith({ behavior: 'allow', updatedInput: { command: 'rm x' } });
    expect(t.perm).toHaveBeenCalledWith('s1', 'perm-1', 'approved');
    expect(t.entry.pendingPermissions.size).toBe(0);
    expect(t.questionResolve).not.toHaveBeenCalled();
  });

  it('delegate also answers the open question (remaining questions only)', () => {
    const t = setup();
    t.adapter.setSessionMode('s1', 'delegate');
    expect(t.permResolve).toHaveBeenCalled();
    expect(t.questionResolve).toHaveBeenCalledWith({
      behavior: 'allow',
      updatedInput: { questions: [{ question: 'First?' }, { question: 'Second?' }], answers: { 'First?': 'yes', 'Second?': DELEGATE_ANSWER } },
    });
    expect(t.question).toHaveBeenCalledWith('s1', 'q-1');
  });
});

describe('Copilot mode switch', () => {
  function setup() {
    const adapter = new CopilotAdapter();
    const permResolve = vi.fn();
    const questionResolve = vi.fn();
    const entry = {
      pendingPermissions: new Map([['perm-1', { resolve: permResolve, toolKind: 'shell' }]]),
      pendingQuestions: new Map([['q-1', { resolve: questionResolve }]]),
    };
    (adapter as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', entry);
    return { adapter, entry, permResolve, questionResolve, ...callbacks(adapter) };
  }

  it('auto approves the waiting permission', () => {
    const t = setup();
    t.adapter.setSessionMode('s1', 'auto');
    expect(t.permResolve).toHaveBeenCalledWith({ kind: 'approve-once' });
    expect(t.perm).toHaveBeenCalledWith('s1', 'perm-1', 'approved');
    expect(t.questionResolve).not.toHaveBeenCalled();
  });

  it('delegate also answers the open question', () => {
    const t = setup();
    t.adapter.setSessionMode('s1', 'delegate');
    expect(t.questionResolve).toHaveBeenCalledWith({ answer: DELEGATE_ANSWER, wasFreeform: true });
    expect(t.question).toHaveBeenCalledWith('s1', 'q-1');
    expect(t.entry.pendingQuestions.size).toBe(0);
  });
});

describe('Codex mode switch', () => {
  function setup() {
    const adapter = new CodexAdapter({ cliPath: '/unused', sessionsDir: '/unused' });
    const rpc = { alive: true, respond: vi.fn() };
    const s = {
      sessionId: 's1', mode: 'safe',
      pendingPermissions: new Map([['perm-1', { rpcId: 7, kind: 'command', toolKind: 'shell', params: {} }]]),
      pendingQuestions: new Map<string, unknown>([
        ['q-1', { rpcId: 8, source: 'ask_user' }],
        ['q-2', { rpcId: 9, source: 'native', index: 1, questions: [{ id: 'a', question: 'A?' }, { id: 'b', question: 'B?' }], collected: { a: { answers: ['x'] } } }],
      ]),
    };
    Object.assign(adapter, { rpc });
    (adapter as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', s);
    return { adapter, rpc, s, ...callbacks(adapter) };
  }

  it('auto approves the waiting permission', () => {
    const t = setup();
    t.adapter.setSessionMode('s1', 'auto');
    expect(t.rpc.respond).toHaveBeenCalledWith(7, { decision: 'accept' });
    expect(t.perm).toHaveBeenCalledWith('s1', 'perm-1', 'approved');
    expect(t.rpc.respond).toHaveBeenCalledTimes(1);
  });

  it('delegate also answers open ask_user and native questions', () => {
    const t = setup();
    t.adapter.setSessionMode('s1', 'delegate');
    expect(t.rpc.respond).toHaveBeenCalledWith(8, { contentItems: [{ type: 'inputText', text: DELEGATE_ANSWER }], success: true });
    expect(t.rpc.respond).toHaveBeenCalledWith(9, { answers: { a: { answers: ['x'] }, b: { answers: [DELEGATE_ANSWER] } } });
    expect(t.question).toHaveBeenCalledWith('s1', 'q-1');
    expect(t.question).toHaveBeenCalledWith('s1', 'q-2');
    expect(t.s.pendingQuestions.size).toBe(0);
  });
});
