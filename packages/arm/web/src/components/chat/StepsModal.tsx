import { useCallback, useMemo, useState } from 'react';
import { ListTree, X } from 'lucide-react';
import type { ChatMessage } from '../../types/store';
import { useStore } from '../../hooks/useStore';
import { messageProvider } from '../../lib/message-provider';
import { StepsList } from './StepsList';

const isTrace = (t: string) => t === 'tool_start' || t === 'tool_complete' || t === 'agent_narration';

/**
 * Collect the TRACE steps (narration + tool chips) belonging to one turn,
 * keyed by a `targetSeq`:
 *  - Concluded turn: `targetSeq` is the concluding agent_message's seq — steps
 *    are the trace entries between the PRIOR user_message and that bubble.
 *  - In-progress turn: `targetSeq` is the turn's leading user_message seq —
 *    steps are the trace entries AFTER it through the current tail.
 * Mirrors the region logic in store.setTurnSteps so a live pull and this reader
 * agree on the same slice.
 */
export function collectTurnSteps(messages: ChatMessage[] | undefined, targetSeq: number): ChatMessage[] {
  if (!messages) return [];
  const targetIdx = messages.findIndex(
    (m) => 'seq' in m && (m as { seq?: number }).seq === targetSeq,
  );
  if (targetIdx < 0) return [];

  const inProgress = messages[targetIdx].type === 'user_message';
  let start: number;
  let end: number;
  if (inProgress) {
    start = targetIdx;            // steps live after the user_message
    end = messages.length;        // …through the current tail
  } else {
    let turnStartIdx = -1;
    for (let i = targetIdx - 1; i >= 0; i--) {
      if (messages[i].type === 'user_message') { turnStartIdx = i; break; }
    }
    start = turnStartIdx;         // steps live after the prior user_message
    end = targetIdx;              // …up to (before) the concluding bubble
  }

  const out: ChatMessage[] = [];
  for (let i = start + 1; i < end; i++) {
    if (isTrace(messages[i].type)) out.push(messages[i]);
  }
  return out;
}

/**
 * Resolve a turn's TRACE steps for either a live or a concluded bubble, plus the
 * `targetSeq` the trace-pull is keyed by. Shared by `StepsButton` (to render /
 * self-hide) and by callers that gate a "Steps" footer on whether the turn has
 * any steps yet.
 */
export function useTurnSteps(
  sessionId: string,
  live?: boolean,
  bubbleSeq?: number,
): { steps: ChatMessage[]; targetSeq: number } {
  const messages = useStore((s) => s.messages.get(sessionId));
  // For a live turn the target is the current turn's leading user_message; for a
  // concluded turn it is the passed-in bubble seq.
  const targetSeq = useMemo(() => {
    if (!live) return bubbleSeq ?? -1;
    if (!messages) return -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'user_message') {
        return 'seq' in messages[i] ? (messages[i] as { seq?: number }).seq ?? -1 : -1;
      }
    }
    return -1;
  }, [live, bubbleSeq, messages]);
  const steps = useMemo(() => collectTurnSteps(messages, targetSeq), [messages, targetSeq]);
  return { steps, targetSeq };
}

interface StepsButtonProps {
  sessionId: string;
  agent?: string;
  /** Concluded turn: the concluding agent_message bubble seq. Omit for `live`. */
  bubbleSeq?: number;
  /** Live/in-progress turn: resolve the target to the current turn's leading
   *  user_message and re-pull on every open so the running steps stay fresh. */
  live?: boolean;
  /** Replay-visible step count from the bubble's `payload.steps` (stamped by the
   *  tentacle). When `> 0` the button shows even before the (transient) trace is
   *  pulled into the store — the click then lazily pulls it. Lets Steps survive a
   *  page reload / history load, where the store holds no trace entries yet. */
  stepHint?: number;
}

/**
 * TRACE-axis "Steps" affordance shared by (a) a concluded agent_message bubble
 * and (b) the live in-progress LiveAgentBubble. A subtle button that lazily pulls the
 * turn's trace via `request_turn_trace` (keyed by the turn's user_message seq,
 * which the tentacle resolves for both finished and running turns) and shows the
 * interleaved narration + tool chips in a full-screen modal.
 */
export function StepsButton({ sessionId, agent, bubbleSeq, live, stepHint }: StepsButtonProps) {
  const [open, setOpen] = useState(false);
  const { steps, targetSeq } = useTurnSteps(sessionId, live, bubbleSeq);

  const handleOpen = useCallback(() => {
    if (targetSeq >= 0) {
      // Live turns grow, so force a fresh pull on each open; concluded turns are
      // deduped by the provider.
      if (live) messageProvider.invalidateTurnTrace(sessionId, targetSeq);
      messageProvider.requestTurnTrace(sessionId, targetSeq);
    }
    setOpen(true);
  }, [sessionId, targetSeq, live]);

  // Show the affordance when EITHER the store already has this turn's trace
  // steps (live turns, or a turn pulled earlier) OR the bubble's replay hint
  // says it has steps (`stepHint > 0`) — the latter survives a reload where the
  // transient trace isn't in the store yet; the click lazily pulls it. Hide only
  // when we're confident the turn has no steps (e.g. an opening bubble before any
  // tool ran), rather than showing a dead button that opens an empty modal.
  if (steps.length === 0 && (stepHint ?? 0) <= 0) return null;

  return (
    <>
      <button
        onClick={handleOpen}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-text-muted transition-colors hover:bg-surface-tertiary hover:text-text-secondary"
        aria-label="Open steps"
      >
        <ListTree className="h-3 w-3" />
        Steps
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
        >
          <div
            className="mx-4 flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border-primary bg-surface-primary shadow-2xl sm:max-w-3xl lg:max-w-6xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border-primary px-5 py-3">
              <h3 className="text-sm font-semibold text-text-primary">Steps</h3>
              <button
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-tertiary hover:text-text-primary"
                aria-label="Close steps"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-w-0 overflow-y-auto px-5 py-4">
              {steps.length > 0 ? (
                <StepsList messages={steps} agent={agent} sessionId={sessionId} />
              ) : (
                <p className="flex items-center gap-2 text-xs text-text-muted">
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-text-muted/40 border-t-text-muted/90" />
                  Loading steps…
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
