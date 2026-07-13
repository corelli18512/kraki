/**
 * Regression tests for the Claude AskUserQuestion answers-key bug.
 *
 * The Claude Code SDK's AskUserQuestion tool expects the pre-populated
 * `answers` (returned from canUseTool.updatedInput) to be a Record keyed by
 * each question's `question` TEXT — not a literal `"answer"` key. Passing
 * `{ answer }` made the SDK treat every question as unanswered, so the
 * tool_result Claude received was "The user did not answer the questions."
 * and every user answer was silently dropped.
 */

import { describe, it, expect, vi } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude.js';

type CapturedResult = {
  behavior: string;
  updatedInput?: { questions?: unknown; answers?: Record<string, string> };
  message?: string;
};

type PendingLike = {
  resolve: (r: CapturedResult) => void;
  questionId: string;
  questions?: Array<{ question: string; options?: unknown }>;
};

type EntryLike = {
  pendingPermissions: Map<string, { resolve: (r: CapturedResult) => void; toolKind?: string }>;
  pendingQuestions: Map<string, PendingLike>;
};

const asSessions = (a: ClaudeAdapter) =>
  (a as unknown as { sessions: Map<string, EntryLike> }).sessions;
const asModes = (a: ClaudeAdapter) =>
  (a as unknown as { sessionModes: Map<string, string> }).sessionModes;

describe('Claude streaming input', () => {
  it('pushes an active-turn steer without clearing the current draft', async () => {
    const adapter = new ClaudeAdapter();
    const push = vi.fn();
    const entry = {
      query: {},
      inputChannel: { push, end: vi.fn() },
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      pendingText: 'working draft',
    };
    (adapter as unknown as { sessions: Map<string, typeof entry> }).sessions.set('s1', entry);

    await adapter.sendMessage('s1', 'change direction', undefined, { delivery: 'steer' });

    expect(push).toHaveBeenCalledWith({
      type: 'user',
      message: { role: 'user', content: 'change direction' },
      parent_tool_use_id: null,
    });
    expect(entry.pendingText).toBe('working draft');
  });
});

describe('Claude AskUserQuestion answers key', () => {
  it('respondToQuestion keys the answer by the question TEXT (not "answer")', async () => {
    const adapter = new ClaudeAdapter();
    let captured: CapturedResult | undefined;
    const questionText = '关于 primeExpanded 的修复，你想让我按哪个方向动手？';
    const questions = [{ question: questionText, options: [{ label: 'A' }] }];
    const pendingQuestions = new Map<string, PendingLike>([
      ['q1', { resolve: (r) => { captured = r; }, questionId: 'q1', questions }],
    ]);
    asSessions(adapter).set('s1', { pendingPermissions: new Map(), pendingQuestions });

    await adapter.respondToQuestion('s1', 'q1', '你给我做一个详细的带图示的html report', false);

    expect(captured?.behavior).toBe('allow');
    expect(captured?.updatedInput?.questions).toEqual(questions);
    expect(captured?.updatedInput?.answers).toEqual({
      [questionText]: '你给我做一个详细的带图示的html report',
    });
    // The literal-"answer" key that caused the bug must NOT be present.
    expect(Object.keys(captured?.updatedInput?.answers ?? {})).not.toContain('answer');
    // pending question is consumed
    expect(asSessions(adapter).get('s1')?.pendingQuestions.size).toBe(0);
  });

  it('delegate-mode auto-answer keys EVERY question by its text', async () => {
    const adapter = new ClaudeAdapter();
    asModes(adapter).set('s1', 'delegate');
    const input = { questions: [{ question: 'Q one' }, { question: 'Q two' }] };

    const res = await (
      adapter as unknown as {
        handleAskUserQuestion: (
          s: string,
          i: Record<string, unknown>,
          p: Map<string, PendingLike>,
        ) => Promise<CapturedResult>;
      }
    ).handleAskUserQuestion('s1', input, new Map());

    expect(res.behavior).toBe('allow');
    expect(res.updatedInput?.questions).toEqual(input.questions);
    expect(res.updatedInput?.answers).toEqual({
      'Q one': 'proceed with your best judgment',
      'Q two': 'proceed with your best judgment',
    });
  });

  it('broadcastPendingResolutions echoes questions with an empty answers map', () => {
    const adapter = new ClaudeAdapter();
    let captured: CapturedResult | undefined;
    const questions = [{ question: 'still open?' }];
    const pendingQuestions = new Map<string, PendingLike>([
      ['q1', { resolve: (r) => { captured = r; }, questionId: 'q1', questions }],
    ]);
    asSessions(adapter).set('s1', { pendingPermissions: new Map(), pendingQuestions });

    (adapter as unknown as { broadcastPendingResolutions: (s: string) => void })
      .broadcastPendingResolutions('s1');

    expect(captured?.behavior).toBe('allow');
    expect(captured?.updatedInput?.questions).toEqual(questions);
    expect(captured?.updatedInput?.answers).toEqual({});
  });

  it('asks multiple questions one at a time and resolves with every answer keyed by text', async () => {
    const adapter = new ClaudeAdapter();
    const emitted: Array<{ id: string; question: string }> = [];
    (adapter as unknown as {
      onQuestionRequest?: (s: string, q: { id: string; question: string }) => void;
    }).onQuestionRequest = (_s, q) => emitted.push({ id: q.id, question: q.question });

    const pendingQuestions = new Map<string, PendingLike>();
    asSessions(adapter).set('s1', { pendingPermissions: new Map(), pendingQuestions });

    const input = {
      questions: [
        { question: 'Which database?', options: [{ label: 'pg' }] },
        { question: 'Which cache?', options: [{ label: 'redis' }] },
      ],
    };
    const permission = (adapter as unknown as {
      handleAskUserQuestion: (
        s: string,
        i: Record<string, unknown>,
        p: Map<string, PendingLike>,
      ) => Promise<CapturedResult>;
    }).handleAskUserQuestion('s1', input, pendingQuestions);

    // Only the first question surfaces initially.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].question).toBe('Which database?');
    expect(pendingQuestions.size).toBe(1);

    // Answer the first → the second question surfaces, permission still pending.
    await adapter.respondToQuestion('s1', emitted[0].id, 'postgres', false);
    expect(emitted).toHaveLength(2);
    expect(emitted[1].question).toBe('Which cache?');
    expect(pendingQuestions.size).toBe(1);

    // Answer the second → permission resolves with BOTH answers, keyed by text.
    await adapter.respondToQuestion('s1', emitted[1].id, 'redis', true);
    const result = await permission;
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput?.answers).toEqual({
      'Which database?': 'postgres',
      'Which cache?': 'redis',
    });
    expect(result.updatedInput?.questions).toEqual(input.questions);
    expect(pendingQuestions.size).toBe(0);
  });
});
