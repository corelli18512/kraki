import { describe, it, expect } from 'vitest';
import { CardManager, type CardBroadcast } from '../card-manager.js';
import type { CardActionState } from '@kraki/protocol';

type RunningTool = Extract<CardActionState, { type: 'tool_start' }>;
type CompletedTool = Extract<CardActionState, { type: 'tool_complete' }>;
type PromptAction = Extract<CardActionState, { type: 'permission' | 'question' }>;

// ── Action factories: build the reused message-shaped card slots ──
const tool = (toolCallId: string, headline: string): RunningTool => ({
  type: 'tool_start',
  payload: { toolName: 'bash', headline, toolCallId },
});
const toolDone = (toolCallId: string, headline: string, success = true): CompletedTool => ({
  type: 'tool_complete',
  payload: { toolName: 'bash', headline, toolCallId, success },
});
const question = (id: string, q: string): PromptAction => ({
  type: 'question',
  payload: { id, question: q },
});
const permission = (id: string, description = 'x', toolName = 'bash'): PromptAction => ({
  type: 'permission',
  payload: { toolName, args: {}, id, description },
});

function setup() {
  const sent: CardBroadcast[] = [];
  const card = new CardManager((m) => sent.push(structuredClone(m)));
  return { card, sent };
}

const msgs = (sent: CardBroadcast[]) =>
  sent.filter((s) => s.type === 'agent_message_delta').map((s) => s.payload as { content: string; reset?: boolean });
const actions = (sent: CardBroadcast[]) =>
  sent.filter((s) => s.type === 'card_action').map((s) => (s.payload as { action: unknown }).action);

describe('CardManager draft bubble', () => {
  it('streams the first delta with reset=false and appends subsequent deltas', () => {
    const { card, sent } = setup();
    card.onDelta('s1', 'Hel');
    card.onDelta('s1', 'lo');
    expect(msgs(sent)).toEqual([
      { content: 'Hel', reset: false },
      { content: 'lo', reset: false },
    ]);
  });

  it('resets the next delta after a narration finalizes (keep-last new segment)', () => {
    const { card, sent } = setup();
    card.onDelta('s1', 'first segment');
    card.onNarrationFinal('s1', 'first segment');
    card.onDelta('s1', 'second');
    const m = msgs(sent);
    expect(m[m.length - 1]).toEqual({ content: 'second', reset: true });
  });

  it('does NOT broadcast on finalize when the delta stream already matches', () => {
    const { card, sent } = setup();
    card.onDelta('s1', 'complete narration');
    sent.length = 0;
    // The live stream fully delivered the segment → no reconcile broadcast.
    card.onNarrationFinal('s1', 'complete narration');
    expect(msgs(sent)).toEqual([]);
  });

  it('reconciles a SHORT draft to the authoritative content at finalize (no handoff jump)', () => {
    const { card, sent } = setup();
    // pi under-delivered: the live text_delta stream stopped at a prefix.
    card.onDelta('s1', 'The answer is fo');
    sent.length = 0;
    // message_end carries the full authoritative prose → broadcast a reset so the
    // draft catches up BEFORE the concluding bubble lands (else the bubble jumps).
    card.onNarrationFinal('s1', 'The answer is forty-two.');
    expect(msgs(sent)).toEqual([{ content: 'The answer is forty-two.', reset: true }]);
    expect((card.snapshot('s1')[0].payload as { content: string }).content).toBe('The answer is forty-two.');
  });

  it('a resummarize after a finalized narration REPLACES the draft (keep-last)', () => {
    const { card, sent } = setup();
    card.onDelta('s1', 'narration draft');
    card.onNarrationFinal('s1', 'narration draft');
    sent.length = 0;
    // finalize_reply.text streams via onDelta too; the pending resetNext makes
    // the first chunk replace the frozen narration in place.
    card.onDelta('s1', 'clean summary');
    expect(msgs(sent)).toEqual([{ content: 'clean summary', reset: true }]);
    expect((card.snapshot('s1')[0].payload as { content: string }).content).toBe('clean summary');
  });

  it('onBubble clears the draft WITHOUT broadcasting (no flicker frame)', () => {
    const { card, sent } = setup();
    card.onDelta('s1', 'draft');
    sent.length = 0;
    card.onBubble('s1');
    // Deliberately silent: the arm clears the draft in the same store update
    // that lands the permanent bubble. Server state is cleared for snapshots.
    expect(sent).toHaveLength(0);
    expect((card.snapshot('s1')[0].payload as { content: string }).content).toBe('');
  });

  it('onBubble leaves the action slot untouched (a tool may still resolve)', () => {
    const { card, sent } = setup();
    card.onToolStart('s1', tool('tc1', '$ echo'));
    card.onDelta('s1', 'draft');
    sent.length = 0;
    card.onBubble('s1');
    // No action broadcast — the running tool stays in the slot.
    expect(actions(sent)).toHaveLength(0);
    expect((card.snapshot('s1')[1].payload as { action: unknown }).action).toMatchObject({ payload: { toolCallId: 'tc1' } });
  });

  it('onBubble promptly clears a slot holding only a COMPLETED tool (land-and-clear, no lag)', () => {
    const { card, sent } = setup();
    card.onToolStart('s1', tool('tc1', '$ echo'));
    card.onToolComplete('s1', toolDone('tc1', '$ echo'));
    sent.length = 0;
    card.onBubble('s1');
    // Nothing live remains → the stale completed-tool slot is retired at once,
    // so the card vanishes with the reply instead of lingering until onIdle.
    expect(actions(sent)).toEqual([null]);
    expect((card.snapshot('s1')[1].payload as { action: unknown }).action).toBeNull();
  });

  it('onBubble keeps the slot when a tool is STILL running in parallel', () => {
    const { card, sent } = setup();
    card.onToolStart('s1', tool('tc1', 'slow'));
    sent.length = 0;
    card.onBubble('s1');
    expect(actions(sent)).toHaveLength(0);
    expect((card.snapshot('s1')[1].payload as { action: unknown }).action).toMatchObject({ payload: { toolCallId: 'tc1' } });
  });

  it('onBubble keeps the slot when an UNRESOLVED prompt occupies it', () => {
    const { card, sent } = setup();
    card.onPrompt('s1', question('q1', 'a?'));
    sent.length = 0;
    card.onBubble('s1');
    expect(actions(sent)).toHaveLength(0);
    expect((card.snapshot('s1')[1].payload as { action: unknown }).action).toMatchObject({ payload: { id: 'q1' } });
  });

  it('ignores empty deltas', () => {
    const { card, sent } = setup();
    card.onDelta('s1', '');
    expect(sent).toHaveLength(0);
  });

  it('snapshot carries the full accumulated draft with reset=true', () => {
    const { card } = setup();
    card.onDelta('s1', 'abc');
    card.onDelta('s1', 'def');
    const snap = card.snapshot('s1');
    expect(snap[0]).toMatchObject({ type: 'agent_message_delta', payload: { content: 'abcdef', reset: true } });
    expect(snap[1]).toMatchObject({ type: 'card_action', payload: { action: null } });
  });
});

describe('CardManager action part', () => {
  it('shows a running tool then its completion', () => {
    const { card, sent } = setup();
    card.onToolStart('s1', tool('tc1', '$ echo'));
    card.onToolComplete('s1', toolDone('tc1', '$ echo'));
    const a = actions(sent);
    expect(a[0]).toMatchObject({ type: 'tool_start', payload: { toolCallId: 'tc1' } });
    expect(a[1]).toMatchObject({ type: 'tool_complete', payload: { toolCallId: 'tc1', success: true } });
  });

  it('retires a COMPLETED tool from the slot when narration resumes (latest≠tool)', () => {
    const { card, sent } = setup();
    card.onToolStart('s1', tool('tc1', '$ echo'));
    card.onToolComplete('s1', toolDone('tc1', '$ echo'));
    sent.length = 0;
    // A narration delta after the tool completed → the completed tool is no
    // longer the latest activity, so the slot clears to null.
    card.onDelta('s1', 'now reporting the result');
    expect(actions(sent)).toEqual([null]);
    expect((card.snapshot('s1')[1].payload as { action: unknown }).action).toBeNull();
  });

  it('does NOT retire a RUNNING tool when narration streams in parallel', () => {
    const { card, sent } = setup();
    card.onToolStart('s1', tool('tc1', 'slow'));
    sent.length = 0;
    // Agent narrates while the tool is still in flight — the running tool stays.
    card.onDelta('s1', 'meanwhile, some progress');
    expect(actions(sent)).toEqual([]);
    expect((card.snapshot('s1')[1].payload as { action: unknown }).action)
      .toMatchObject({ type: 'tool_start', payload: { toolCallId: 'tc1' } });
  });

  it('onNarrationFinal also retires a completed tool (segment with no delta)', () => {
    const { card, sent } = setup();
    card.onToolStart('s1', tool('tc1', '$ echo'));
    card.onToolComplete('s1', toolDone('tc1', '$ echo'));
    sent.length = 0;
    card.onNarrationFinal('s1', 'done');
    expect(actions(sent)).toEqual([null]);
  });

  it('retires an ANSWERED question from the slot when narration resumes', () => {
    const { card, sent } = setup();
    card.onPrompt('s1', question('q1', 'a?'));
    card.resolvePrompt('s1', 'q1', { answer: '面条' });
    sent.length = 0;
    // Once the agent narrates again the answered question is settled → slot clears.
    card.onDelta('s1', 'thanks, continuing');
    expect(actions(sent)).toEqual([null]);
    expect((card.snapshot('s1')[1].payload as { action: unknown }).action).toBeNull();
  });

  it('retires a DECIDED permission from the slot on onNarrationFinal', () => {
    const { card, sent } = setup();
    card.onPrompt('s1', permission('p1'));
    card.resolvePrompt('s1', 'p1', { decision: 'approve' });
    sent.length = 0;
    card.onNarrationFinal('s1', 'ran it');
    expect(actions(sent)).toEqual([null]);
  });

  it('does NOT retire an UNRESOLVED prompt when narration streams in parallel', () => {
    const { card, sent } = setup();
    card.onPrompt('s1', question('q1', 'a?'));
    sent.length = 0;
    // A pending (unanswered) question stays put even as the agent narrates.
    card.onDelta('s1', 'while you decide, here is context');
    expect(actions(sent)).toEqual([]);
    expect((card.snapshot('s1')[1].payload as { action: unknown }).action)
      .toMatchObject({ type: 'question', payload: { id: 'q1' } });
  });

  it('a later prompt takes over the slot from a running tool (last-write-wins)', () => {
    const { card, sent } = setup();
    card.onToolStart('s1', tool('tc1', 'wf'));
    card.onPrompt('s1', permission('p1', 'write?', 'write_file'));
    const a = actions(sent);
    expect(a[a.length - 1]).toMatchObject({ type: 'permission', payload: { id: 'p1' } });
  });

  it('two parallel tools collapse into a tool_batch count', () => {
    const { card, sent } = setup();
    card.onToolStart('s1', tool('tc1', 'a'));
    card.onToolStart('s1', tool('tc2', 'b'));
    const a = actions(sent);
    expect(a[0]).toMatchObject({ type: 'tool_start', payload: { toolCallId: 'tc1' } });
    expect(a[a.length - 1]).toEqual({ type: 'tool_batch', payload: { running: 2 } });
  });

  it('three parallel tools report running:3; completing one drops to a batch of 2, then the last standalone', () => {
    const { card, sent } = setup();
    card.onToolStart('s1', tool('tc1', 'a'));
    card.onToolStart('s1', tool('tc2', 'b'));
    card.onToolStart('s1', tool('tc3', 'c'));
    expect(actions(sent).at(-1)).toEqual({ type: 'tool_batch', payload: { running: 3 } });
    card.onToolComplete('s1', toolDone('tc1', 'a'));
    // Two still in flight → batch of 2 (NOT the just-completed tool).
    expect(actions(sent).at(-1)).toEqual({ type: 'tool_batch', payload: { running: 2 } });
    card.onToolComplete('s1', toolDone('tc2', 'b'));
    // One left in flight → show that single remaining running tool.
    expect(actions(sent).at(-1)).toMatchObject({ type: 'tool_start', payload: { toolCallId: 'tc3' } });
    card.onToolComplete('s1', toolDone('tc3', 'c'));
    // None left → land the just-completed tool as the last state.
    expect(actions(sent).at(-1)).toMatchObject({ type: 'tool_complete', payload: { toolCallId: 'tc3', success: true } });
  });

  it('resolving a question updates it IN PLACE to show the answer (no fallback)', () => {
    const { card, sent } = setup();
    card.onToolStart('s1', tool('tc1', 't'));
    card.onPrompt('s1', question('q1', 'a?'));
    card.resolvePrompt('s1', 'q1', { answer: '面条' });
    const a = actions(sent);
    expect(a[a.length - 1]).toMatchObject({ type: 'question', payload: { id: 'q1', answer: '面条' } });
  });

  it('resolving a permission updates it IN PLACE with the decision (no fallback to tool)', () => {
    const { card, sent } = setup();
    card.onToolStart('s1', tool('tc1', 't'));
    card.onPrompt('s1', permission('p1'));
    card.resolvePrompt('s1', 'p1', { decision: 'approve' });
    const a = actions(sent);
    expect(a[a.length - 1]).toMatchObject({ type: 'permission', payload: { id: 'p1', decision: 'approve' } });
  });

  it('resolving without a resolution freezes a question as cancelled', () => {
    const { card, sent } = setup();
    card.onPrompt('s1', question('q1', 'a?'));
    card.resolvePrompt('s1', 'q1');
    const a = actions(sent);
    expect(a[a.length - 1]).toMatchObject({ type: 'question', payload: { id: 'q1', cancelled: true } });
  });

  it('an UNRESOLVED prompt blocks a subsequent tool from taking the slot', () => {
    const { card, sent } = setup();
    card.onPrompt('s1', question('q1', 'a?'));
    sent.length = 0;
    card.onToolStart('s1', tool('tc1', 't'));
    // Tool is suppressed while the human hasn't answered — slot still holds q1.
    expect(actions(sent)).toHaveLength(0);
  });

  it('a RESOLVED prompt IS superseded by later tool activity (fix #1)', () => {
    const { card, sent } = setup();
    card.onPrompt('s1', permission('p1'));
    card.resolvePrompt('s1', 'p1', { decision: 'approve' });
    sent.length = 0;
    card.onToolStart('s1', tool('tc1', '$ echo'));
    card.onToolComplete('s1', toolDone('tc1', '$ echo'));
    const a = actions(sent);
    expect(a[0]).toMatchObject({ type: 'tool_start', payload: { toolCallId: 'tc1' } });
    expect(a[a.length - 1]).toMatchObject({ type: 'tool_complete', payload: { toolCallId: 'tc1', success: true } });
  });

  it('deduplicates redundant action broadcasts (same tool + status)', () => {
    const { card, sent } = setup();
    card.onToolStart('s1', tool('tc1', 't'));
    card.onToolStart('s1', tool('tc1', 't'));
    expect(actions(sent)).toHaveLength(1);
  });

});

describe('CardManager lifecycle', () => {
  it('clear() broadcasts an empty message and null action', () => {
    const { card, sent } = setup();
    card.onDelta('s1', 'draft');
    card.onToolStart('s1', tool('tc1', 't'));
    sent.length = 0;
    card.clear('s1');
    expect(msgs(sent)).toContainEqual({ content: '', reset: true });
    expect(actions(sent)).toContainEqual(null);
  });

  it('per-session isolation — clearing one leaves another intact', () => {
    const { card } = setup();
    card.onDelta('s1', 'aaa');
    card.onDelta('s2', 'bbb');
    card.clear('s1');
    expect((card.snapshot('s2')[0].payload as { content: string }).content).toBe('bbb');
    expect((card.snapshot('s1')[0].payload as { content: string }).content).toBe('');
  });

  it('delete() drops state without throwing', () => {
    const { card } = setup();
    card.onDelta('s1', 'x');
    expect(() => card.delete('s1')).not.toThrow();
    expect((card.snapshot('s1')[0].payload as { content: string }).content).toBe('');
  });
});

describe('CardManager.activeSessions', () => {
  it('lists sessions with live text', () => {
    const { card } = setup();
    card.onDelta('s1', 'hello');
    expect(card.activeSessions()).toEqual(['s1']);
  });

  it('lists sessions with an active action (prompt or tool)', () => {
    const { card } = setup();
    card.onPrompt('s1', question('q1', 'q?'));
    card.onToolStart('s2', tool('tc1', 't'));
    expect(card.activeSessions().sort()).toEqual(['s1', 's2']);
  });

  it('omits sessions with no text and no action', () => {
    const { card } = setup();
    card.onDelta('s1', 'hi');
    card.clear('s1');
    expect(card.activeSessions()).toEqual([]);
  });

  it('omits sessions that were never touched', () => {
    const { card } = setup();
    expect(card.activeSessions()).toEqual([]);
  });
});
