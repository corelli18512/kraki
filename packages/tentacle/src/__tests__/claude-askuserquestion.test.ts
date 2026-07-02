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

import { describe, it, expect } from 'vitest';
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
});
