/**
 * Which spine rows a turn's pulled TRACE steps belong to, keyed by the seq a
 * trace pull uses (`request_turn_trace` bubbleSeq). Shared by the store
 * (`setTurnSteps`, where pulled steps are inserted) and the Steps view
 * (`collectTurnSteps`, which reads them back), so both use the same slice.
 *
 * A turn starts at a prompt (a non-steer user_message) or, for a turn the
 * agent started itself (e.g. Pi woken by a background run after the previous
 * turn settled), right after the previous turn's `idle`: the tentacle keys
 * that turn's trace at the seq after the idle, so its steps never mix with
 * the previous prompt's.
 */

import type { ChatMessage } from '../../types/store';

export const isTurnStart = (message: ChatMessage): boolean =>
  message.type === 'user_message' && message.payload.delivery !== 'steer';

const isPromptBoundary = (message: ChatMessage): boolean =>
  isTurnStart(message) || message.type === 'send_input';

const seqOf = (message: ChatMessage): number | undefined => (message as { seq?: number }).seq;

/**
 * The trace-pull seq of the running turn: its prompt's seq, or — when the
 * newest turn boundary is an `idle` (the agent started this turn itself) —
 * the seq after that idle, which the tentacle resolves to that turn. A
 * prompted turn's prompt usually is that next seq anyway. Older tentacles map
 * it to the previous prompt's trace. -1 when no boundary is loaded yet.
 */
export function liveTurnTraceSeq(messages: ChatMessage[] | undefined): number {
  if (!messages) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isTurnStart(message)) return seqOf(message) ?? -1;
    if (message.type === 'idle') {
      const seq = seqOf(message);
      return seq === undefined ? -1 : seq + 1;
    }
  }
  return -1;
}

export interface TurnStepsRegion {
  /** Exclusive index bounds of the turn's TRACE slot. */
  start: number;
  end: number;
  /** Index of the row the steps attach to: inserted after it (`after`) for a
   *  running turn's prompt or idle, before it for a concluding bubble. */
  anchorIndex: number;
  after: boolean;
  /** Pulled steps get fractional seqs in (base, base + 1). */
  base: number;
}

/** The slot of the turn a trace pull for `targetSeq` belongs to, or null when
 *  that turn is not loaded. */
export function turnStepsRegion(messages: ChatMessage[], targetSeq: number): TurnStepsRegion | null {
  const targetIndex = messages.findIndex((m) => seqOf(m) === targetSeq);
  const nextPrompt = (from: number) => {
    for (let i = from + 1; i < messages.length; i++) if (isPromptBoundary(messages[i])) return i;
    return messages.length;
  };
  // Running prompted turn: its steps follow the prompt.
  if (targetIndex >= 0 && isTurnStart(messages[targetIndex])) {
    return { start: targetIndex, end: nextPrompt(targetIndex), anchorIndex: targetIndex, after: true, base: targetSeq };
  }
  // Running turn the agent started itself: keyed at the seq after the idle;
  // no row of it, or only a steer into it, is loaded at that seq.
  const target = targetIndex >= 0 ? messages[targetIndex] : undefined;
  if (!target || (target.type === 'user_message' && !isTurnStart(target))) {
    const idleIndex = messages.findIndex((m) => m.type === 'idle' && seqOf(m) === targetSeq - 1);
    if (idleIndex >= 0) {
      return { start: idleIndex, end: nextPrompt(idleIndex), anchorIndex: idleIndex, after: true, base: targetSeq - 1 };
    }
  }
  if (targetIndex < 0) return null;
  // Concluded turn: steps sit between its start (the prompt, or the previous
  // turn's idle) and its concluding bubble.
  let start = -1;
  for (let i = targetIndex - 1; i >= 0; i--) {
    if (isTurnStart(messages[i]) || messages[i].type === 'idle') { start = i; break; }
  }
  return { start, end: targetIndex, anchorIndex: targetIndex, after: false, base: targetSeq - 1 };
}
