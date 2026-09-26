import { useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import type { ChatMessage } from '../../types/store';
import { useStore } from '../../hooks/useStore';
import { messageProvider } from '../../lib/message-provider';
import { StepsList } from './StepsList';

const isTrace = (t: string) =>
  t === 'tool_start' || t === 'tool_complete' || t === 'agent_narration' ||
  t === 'permission' || t === 'error';
const isTurnStart = (message: ChatMessage) =>
  message.type === 'user_message' && message.payload.delivery !== 'steer';

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

  const inProgress = isTurnStart(messages[targetIdx]);
  let start: number;
  let end: number;
  if (inProgress) {
    start = targetIdx;            // steps live after the user_message
    end = messages.length;        // …through the current tail
  } else {
    let turnStartIdx = -1;
    for (let i = targetIdx - 1; i >= 0; i--) {
      if (isTurnStart(messages[i])) { turnStartIdx = i; break; }
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
      if (isTurnStart(messages[i])) {
        return 'seq' in messages[i] ? (messages[i] as { seq?: number }).seq ?? -1 : -1;
      }
    }
    return -1;
  }, [live, bubbleSeq, messages]);
  const steps = useMemo(() => collectTurnSteps(messages, targetSeq), [messages, targetSeq]);
  return { steps, targetSeq };
}

/**
 * The turn's Steps (narration + tool chips), opened from a bubble's "···".
 * `bubbleSeq` is the concluding bubble's seq, or null for the live turn. The
 * trace is pulled lazily (`request_turn_trace`); a live turn re-pulls on open.
 */
export function StepsModal({ sessionId, bubbleSeq, agent, onClose }: {
  sessionId: string;
  bubbleSeq: number | null;
  agent?: string;
  onClose: () => void;
}) {
  const live = bubbleSeq === null;
  const { steps, targetSeq } = useTurnSteps(sessionId, live, bubbleSeq ?? undefined);

  useEffect(() => {
    if (targetSeq < 0) return;
    if (live) messageProvider.invalidateTurnTrace(sessionId, targetSeq);
    messageProvider.requestTurnTrace(sessionId, targetSeq);
  }, [sessionId, targetSeq, live]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="ksheet-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Steps">
      <div className="ksheet" onClick={(e) => e.stopPropagation()}>
        <div className="ksheet-head">
          <h3>Steps</h3>
          <button type="button" onClick={onClose} className="ksheet-close" aria-label="Close steps"><X aria-hidden /></button>
        </div>
        <div className="ksheet-body">
          {steps.length > 0 ? (
            <StepsList messages={steps} agent={agent} sessionId={sessionId} />
          ) : (
            <p className="ksheet-loading"><span className="kspinner" /> Loading steps…</p>
          )}
        </div>
      </div>
    </div>
  );
}
