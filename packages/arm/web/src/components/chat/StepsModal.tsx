import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, X } from 'lucide-react';
import type { ContentRef } from '@kraki/protocol';
import { useAttachmentText } from '../../hooks/useAttachment';
import { callIdOf, contentsLabel, formatDuration, formatTokens, mergeSteps, subagentOf, subagentStatus } from '../../lib/subagent-steps';
import { Markdown } from './Markdown';
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

  // A running turn keeps its Steps (and any open subagent page) current.
  useEffect(() => {
    if (!live || targetSeq < 0) return;
    const timer = setInterval(() => {
      messageProvider.invalidateTurnTrace(sessionId, targetSeq);
      messageProvider.requestTurnTrace(sessionId, targetSeq);
    }, 2500);
    return () => clearInterval(timer);
  }, [sessionId, targetSeq, live]);

  // Subagent pages pushed on top of the turn's Steps (dispatch toolCallIds).
  const [path, setPath] = useState<string[]>([]);
  const open = (id: string) => setPath((p) => [...p, id]);
  const back = () => setPath((p) => p.slice(0, -1));
  const merged = useMemo(() => mergeSteps(steps), [steps]);
  const current = path.length ? merged.find((m) => callIdOf(m) === path[path.length - 1]) : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (path.length) back(); else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, path.length]);

  const title = current ? (subagentOf(current)?.name ?? 'Subagent') : 'Steps';
  return (
    <div className="ksheet-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Steps">
      <div className="ksheet" onClick={(e) => e.stopPropagation()}>
        <div className="ksheet-head">
          {path.length > 0 && (
            <button type="button" onClick={back} className="ksheet-back" aria-label="Back">
              <ChevronLeft aria-hidden />{path.length > 1 ? 'Back' : 'Steps'}
            </button>
          )}
          <h3>{title}</h3>
          <button type="button" onClick={onClose} className="ksheet-close" aria-label="Close steps"><X aria-hidden /></button>
        </div>
        <div className="ksheet-body" key={path.join('/')}>
          {steps.length === 0 ? (
            <p className="ksheet-loading"><span className="kspinner" /> Loading steps…</p>
          ) : current ? (
            <SubagentPage msg={current} merged={merged} steps={steps} agent={agent} sessionId={sessionId} onOpen={open} />
          ) : (
            <StepsList messages={steps} agent={agent} sessionId={sessionId} onOpenSubagent={open} />
          )}
        </div>
      </div>
    </div>
  );
}

const pullRef = (sid: string, ref: ContentRef): void => {
  void import('../../lib/ws-client').then(({ wsClient }) => wsClient.requestAttachment(sid, ref));
};

/** One subagent: what it was asked, its own steps, and what it reported back. */
function SubagentPage({ msg, merged, steps, agent, sessionId, onOpen }: {
  msg: ChatMessage;
  merged: ChatMessage[];
  steps: ChatMessage[];
  agent?: string;
  sessionId: string;
  onOpen: (id: string) => void;
}) {
  const id = callIdOf(msg) ?? '';
  const info = subagentOf(msg);
  const status = subagentStatus(msg);
  const facts = [
    status === 'running' ? 'Running' : status === 'failed' ? 'Failed' : status === 'stopped' ? 'Stopped' : 'Done',
    contentsLabel(merged, id),
    formatDuration(info?.durationMs),
    formatTokens(info?.tokens),
  ].filter(Boolean).join(' · ');
  const resultRef = msg.type === 'tool_complete' ? (msg.payload as { resultRef?: ContentRef }).resultRef : undefined;
  return (
    <div className="ksub-page">
      {info?.task && <p className="ksub-page-task">{info.task}</p>}
      <p className="ksub-page-facts">{facts}</p>
      {merged.some((m) => (m.payload as { parentToolCallId?: string }).parentToolCallId === id) ? (
        <StepsList messages={steps} agent={agent} sessionId={sessionId} parentId={id} onOpenSubagent={onOpen} />
      ) : (
        <p className="ksub-empty">{status === 'running' ? 'Working… its steps appear here as it reports them.' : 'The agent did not report this subagent\'s steps.'}</p>
      )}
      {resultRef && status !== 'running' && <SubagentReport resultRef={resultRef} sessionId={sessionId} />}
    </div>
  );
}

function SubagentReport({ resultRef, sessionId }: { resultRef: ContentRef; sessionId: string }) {
  const { text } = useAttachmentText(resultRef, sessionId, pullRef, true);
  return (
    <div className="ksub-report">
      <div className="ksub-report-label">Report</div>
      {text === null ? <p className="ksheet-loading"><span className="kspinner" /> Loading…</p> : <Markdown text={text} />}
    </div>
  );
}
