import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../types/store';
import { frozenCardOf, openQuestions, presentQuestions, rowKey, seqOf, spineRows } from './spine';

const m = (type: string, seq: number, payload: Record<string, unknown> = {}): ChatMessage =>
  ({ type, seq, sessionId: 's', deviceId: 'd', timestamp: '2026-09-01T00:00:00Z', payload }) as unknown as ChatMessage;

const ask = (seq: number, id: string, extra: Record<string, unknown> = {}) =>
  m('agent_message', seq, { content: '有两个方案', question: { id, text: '删旧接口？', choices: ['删', '留'] }, ...extra });
const abort = (seq: number, draft = '') => m('turn_status', seq, { draft, action: { type: 'user_abort', payload: {} } });

describe('questions on the spine', () => {
  it('open at the head, undetermined elsewhere, answered by answerTo', () => {
    const raw = [ask(1, 'q1'), ask(2, 'q2'), m('user_message', 3, { content: '好', answerTo: 'q2' })];
    const items = presentQuestions(raw, [], true);
    expect(items[0].question?.state).toBe('open');
    expect(items[1].question?.state).toBe('answered');
    expect(presentQuestions(raw, [], false)[0].question?.state).toBe('undetermined');
    expect(openQuestions(raw, [], true).map((q) => q.id)).toEqual(['q1']);
  });

  it('an optimistic answer closes the question at once', () => {
    const raw = [ask(1, 'q1')];
    expect(presentQuestions(raw, ['q1'], true)[0].question?.state).toBe('answered');
    expect(openQuestions(raw, ['q1'], true)).toEqual([]);
  });

  it('the text is identical open and answered; only open adds choices', () => {
    const open = frozenCardOf({ message: ask(1, 'q1'), question: { state: 'open' } })!;
    const answered = frozenCardOf({ message: ask(1, 'q1'), question: { state: 'answered' } })!;
    expect(open.text).toBe('有两个方案\n\n**删旧接口？**');
    expect(answered.text).toBe(open.text);
    expect(open.action).toEqual({ type: 'question', id: 'q1', choices: ['删', '留'] });
    expect(answered.action).toBeUndefined();
  });

  it('abort while asking draws User aborted inside the question, no separate row', () => {
    const rows = spineRows([m('user_message', 1, { content: 'go' }), ask(2, 'q1'), abort(3), m('idle', 4)], [], true);
    expect(rows.map((r) => seqOf(r.message))).toEqual([1, 2]);
    expect(rowKey(rows[1])).toBe('2#q-user_abort');
    expect(frozenCardOf(rows[1])?.action).toEqual({ type: 'user_abort' });
  });

  it('an abort after further output keeps its own card and the question stays plain', () => {
    const rows = spineRows([
      m('user_message', 1, { content: 'go' }), ask(2, 'q1'), m('agent_message', 3, { content: 'partial' }), abort(4), m('idle', 5),
    ], [], true);
    const q = rows.find((r) => seqOf(r.message) === 2)!;
    expect(q.question?.state).toBe('unanswered');
    expect(frozenCardOf(q)?.action).toBeUndefined();
    expect(frozenCardOf(rows.find((r) => seqOf(r.message) === 4)!)?.text).toBe('partial');
  });

  it('never borrows an older reply across a question', () => {
    const rows = spineRows([
      m('agent_message', 1, { content: '上一轮' }), m('user_message', 2, { content: '继续' }),
      ask(3, 'q1'), abort(4), m('idle', 5),
    ], [], true);
    // (A segment without an idle belongs to the aborted turn — as on iOS.)
    expect(rows.map((r) => seqOf(r.message))).toEqual([2, 3]);
    expect(frozenCardOf(rows[1])?.action).toEqual({ type: 'user_abort' });
  });
});

describe('turn projection', () => {
  it('keeps only the final reply of a turn and drops errors / trace', () => {
    const rows = spineRows([
      m('user_message', 1, { content: 'go' }), m('agent_message', 2, { content: 'thinking' }),
      m('tool_start', 3, { toolName: 'bash' }), m('error', 4, { message: 'x' }),
      m('agent_message', 5, { content: 'done' }), m('idle', 6),
    ], [], true);
    expect(rows.map((r) => seqOf(r.message))).toEqual([1, 5]);
  });

  it('a terminal status takes over the reply as its draft', () => {
    const rows = spineRows([
      m('user_message', 1, { content: 'go' }), m('agent_message', 2, { content: 'half' }), abort(3), m('idle', 4),
    ], [], true);
    expect(rows.map((r) => seqOf(r.message))).toEqual([1, 3]);
    expect(frozenCardOf(rows[1])).toEqual({ text: 'half', action: { type: 'user_abort' } });
  });

  it('a steer stays inside the turn', () => {
    const rows = spineRows([
      m('user_message', 1, { content: 'go' }), m('agent_message', 2, { content: 'a' }),
      m('user_message', 3, { content: 'also', delivery: 'steer' }), m('agent_message', 4, { content: 'b' }), m('idle', 5),
    ], [], true);
    expect(rows.map((r) => seqOf(r.message))).toEqual([1, 3, 4]);
  });

  it('turn artifacts attach to the visible outcome', () => {
    const ref = { type: 'content_ref', id: 'r1', mimeType: 'text/html', size: 3 };
    const rows = spineRows([
      m('user_message', 1, { content: 'go' }), m('agent_message', 2, { content: 'done' }), m('idle', 3, { turnArtifacts: [ref] }),
    ], [], true);
    expect((rows[1].message as { payload: { attachments: unknown[] } }).payload.attachments).toEqual([ref]);
  });

  it('draft-less legacy interrupted turn without a reply renders nothing', () => {
    const rows = spineRows([m('user_message', 1, { content: 'go' }), m('interrupted_turn', 2, { reason: 'user_aborted' }), m('idle', 3)], [], true);
    expect(rows.map((r) => seqOf(r.message))).toEqual([1]);
  });
});
