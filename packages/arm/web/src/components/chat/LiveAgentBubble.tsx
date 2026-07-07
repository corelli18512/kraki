import { useEffect, useMemo } from 'react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { AgentAvatar } from '../common/AgentAvatar';
import { PermissionInput } from '../actions/PermissionInput';
import { QuestionInput } from '../actions/QuestionInput';
import { ToolActivity } from './ToolActivity';
import { StepsButton, useTurnSteps } from './StepsModal';
import { markdownComponents } from './MessageBubble';
import { messageProvider } from '../../lib/message-provider';
import { formatTime } from '../../lib/format';
import type { CardActionState, SessionCard } from '../../types/store';

/** Lazy attachment pull for tool args/result refs rendered in the status
 *  section (mirrors MessageBubble's ATTACHMENT_PULL). */
const ATTACHMENT_PULL = (sid: string, id: string): void => {
  void import('../../lib/ws-client').then(({ wsClient }) => {
    wsClient.requestAttachment(sid, id);
  });
};

/** A stable identity string for an action slot — changes only at a genuine step
 *  boundary (tool start/complete, prompt open/resolve, batch count), so it can
 *  drive a trace re-pull without reacting to per-token narration updates. */
function actionIdentity(a: CardActionState | null): string {
  if (!a) return 'none';
  switch (a.kind) {
    case 'tool':
      return `tool:${a.id}:${a.status}`;
    case 'tool_batch':
      return `batch:${a.running}`;
    case 'permission':
      return `perm:${a.id}:${a.decision ?? 'pending'}`;
    case 'question':
      return `q:${a.id}:${a.answer === undefined ? 'pending' : 'answered'}`;
  }
}


interface LiveAgentBubbleProps {
  sessionId: string;
  agent?: string;
  card: SessionCard;
}

/**
 * The single LIVE agent bubble for an in-progress turn.
 *   ① content section (top): the streaming narration / reply draft (when there
 *      is draft text). At the SETTLED tail (no live action) it carries an inline
 *      footer — timestamp + Steps — that is byte-identical to the concluded
 *      agent bubble, so the crystallize into the spine is a zero-flicker DOM
 *      swap (same width, same footer, same pixels).
 *   ② action section (darker): shown ONLY when the slot carries live work — a
 *      running tool / parallel batch, the most-recent COMPLETED tool (the
 *      tentacle retires it the instant narration resumes, so its presence means
 *      "the latest thing that happened was this tool"), or an (un)resolved
 *      permission / question. While an action is live, the Steps entry sits in a
 *      subtle bottom-right footer instead. There is NO generic "working/thinking"
 *      chrome: when nothing is in the slot (pure narration / finalize tail) the
 *      bubble reads exactly like the settled concluded bubble.
 *
 * When the concluding agent_message lands on the spine (and the draft + action
 * clear), ChatView stops rendering this bubble — the concluded spine bubble
 * takes over in place with no visible change.
 */
export function LiveAgentBubble({ sessionId, agent, card }: LiveAgentBubbleProps) {
  const draft = card.text ?? '';
  const hasContent = draft.length > 0;
  const a = card.action;

  const runningTool = a?.kind === 'tool' && a.status === 'running' ? a : null;
  const completedTool = a?.kind === 'tool' && a.status !== 'running' ? a : null;
  const tool = runningTool ?? completedTool;
  const batchRunning = a?.kind === 'tool_batch' ? a.running : 0;
  // Both PENDING and RESOLVED prompts render: a pending one is the live blocking
  // affordance; a resolved one (decided permission / answered question) shows its
  // read-only outcome as the latest activity until narration resumes (the
  // tentacle retires it from the slot the instant it does — same rule as a
  // completed tool). The input components render their own resolved read-only view.
  const permission = a?.kind === 'permission' ? a : null;
  const question = a?.kind === 'question' ? a : null;
  const hasAction = !!tool || batchRunning > 0 || !!permission || !!question;

  const { steps, targetSeq } = useTurnSteps(sessionId, true);

  // TRACE steps are NOT broadcast live (Phase-10: retired from the wire) — they
  // only enter the store via a request_turn_trace pull. So proactively pull the
  // in-progress turn's trace on mount and at each STEP BOUNDARY (a card-action
  // transition: tool start/complete, prompt open/resolve) so `steps` reflects
  // reality and the Steps footer self-hides only while the turn genuinely has no
  // steps yet. Keyed off the action identity — NOT card.text — so a narration
  // token stream doesn't spam pulls. The Steps modal re-pulls fresh on open.
  const actionKey = useMemo(() => actionIdentity(card.action), [card.action]);
  useEffect(() => {
    if (targetSeq < 0) return;
    messageProvider.invalidateTurnTrace(sessionId, targetSeq);
    messageProvider.requestTurnTrace(sessionId, targetSeq);
  }, [sessionId, targetSeq, actionKey]);


  return (
    <div className="flex gap-2" data-live-bubble>
      <div className="mt-0.5 shrink-0">
        <AgentAvatar agent={agent ?? ''} sessionId={sessionId} size="sm" />
      </div>
      <div className="min-w-0 max-w-[85%] overflow-hidden rounded-2xl rounded-bl-md bg-ocean-500/5 shadow-sm sm:max-w-[70%]">
        {hasContent && (
          <div className="overflow-x-auto px-4 py-2.5">
            <div className="markdown-content text-sm leading-relaxed text-text-primary">
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                {draft}
              </Markdown>
            </div>
            {/* Settled tail (no live action): render a footer BYTE-IDENTICAL to
               the concluded agent bubble (MessageBubble's agent_message) — same
               `mt-1` row, same timestamp (HH:MM of ~now, which matches the
               concluding message that lands <1s later), same inline Steps entry.
               So when this live bubble crystallizes into the spine agent_message,
               the DOM swap repaints the SAME pixels → zero visible flicker. The
               Steps button self-hides while the turn has no steps yet. */}
            {!hasAction && (
              <div className="mt-1 flex items-center gap-2">
                <p className="text-[10px] text-text-muted">{formatTime(new Date().toISOString())}</p>
                <StepsButton sessionId={sessionId} agent={agent} live />
              </div>
            )}
          </div>
        )}

        {hasAction && (
          <div className={`bg-surface-tertiary/40 px-3 py-2 ${hasContent ? 'border-t border-border-primary/50' : ''}`}>
            {tool && (
              <ToolActivity
                type={runningTool ? 'start' : 'complete'}
                toolName={tool.toolName}
                headline={tool.headline ?? ''}
                argsRef={tool.argsRef}
                resultRef={completedTool?.resultRef}
                success={completedTool ? completedTool.status === 'success' : undefined}
                sessionId={sessionId}
                requestPull={ATTACHMENT_PULL}
              />
            )}

            {batchRunning > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-border-primary bg-surface-primary/40 px-3 py-2 text-xs text-text-secondary">
                <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-ocean-500" />
                <span>{batchRunning} 个工具并行运行中…</span>
              </div>
            )}

            {permission && <PermissionInput action={permission} sessionId={sessionId} />}

            {question && <QuestionInput action={question} sessionId={sessionId} />}
          </div>
        )}

        {/* Mid-turn only (an action occupies the slot): the subtle bottom-right
           Steps entry. At the settled tail the inline footer above owns Steps so
           it aligns with the concluded bubble. */}
        {hasAction && steps.length > 0 && (
          <div className="flex justify-end px-2 pb-1 pt-0.5">
            <StepsButton sessionId={sessionId} agent={agent} live />
          </div>
        )}
      </div>
    </div>
  );
}
