import { useEffect, useMemo } from 'react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { CircleStop, OctagonX } from 'lucide-react';
import { AgentAvatar } from '../common/AgentAvatar';
import { PermissionInput } from '../actions/PermissionInput';
import { QuestionInput } from '../actions/QuestionInput';
import { ToolActivity } from './ToolActivity';
import { StepsButton, useTurnSteps } from './StepsModal';
import { markdownComponents, ImageAttachments, HtmlArtifactCards } from './MessageBubble';
import { messageProvider } from '../../lib/message-provider';
import { formatTime } from '../../lib/format';
import { cardActionKey } from '../../lib/session-status';
import type { SessionCard } from '../../types/store';
import type { Attachment, ContentRef } from '@kraki/protocol';

/** Lazy attachment pull for tool args/result refs rendered in the status
 *  section (mirrors MessageBubble's ATTACHMENT_PULL). */
const ATTACHMENT_PULL = (sid: string, id: string): void => {
  void import('../../lib/ws-client').then(({ wsClient }) => {
    wsClient.requestAttachment(sid, id);
  });
};


interface LiveAgentBubbleProps {
  sessionId: string;
  agent?: string;
  card: SessionCard;
  /** Render as a permanent read-only card rebuilt from a persisted
   *  `turn_status` message. Uses the supplied timestamp/bubbleSeq instead of
   *  the live "now" clock, skips the proactive live trace-pull, and always
   *  shows a bottom footer (timestamp + Steps). The action slot carries the
   *  terminal outcome (`user_abort` | `failed`) rendered with the SAME action
   *  section the live card uses — there is no separate terminal-card chrome. */
  frozen?: {
    timestamp: string;
    bubbleSeq: number;
    stepHint?: number;
    attachments?: Attachment[];
    artifacts?: ContentRef[];
    onOpenArtifact?: (artifact: ContentRef) => void;
  };
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
 *
 * Frozen mode: a persisted `turn_status` (user abort / terminal backend error)
 * reuses this EXACT rendering with the action slot set to the terminal outcome.
 * It looks identical to the live card that was on screen the instant the turn
 * ended — just frozen read-only with a permanent footer.
 */
export function LiveAgentBubble({ sessionId, agent, card, frozen }: LiveAgentBubbleProps) {
  const live = !frozen;
  const draft = card.text ?? '';
  const hasContent = draft.length > 0;
  const hasFrozenArtifacts = !!frozen?.attachments?.length || !!frozen?.artifacts?.length;
  const showContentSection = hasContent || hasFrozenArtifacts;
  const a = card.action;

  const runningTool = a?.type === 'tool_start' ? a : null;
  const completedTool = a?.type === 'tool_complete' ? a : null;
  const tool = runningTool ?? completedTool;
  const batchRunning = a?.type === 'tool_batch' ? a.payload.running : 0;
  // Both PENDING and RESOLVED prompts render: a pending one is the live blocking
  // affordance; a resolved one (decided permission / answered question) shows its
  // read-only outcome as the latest activity until narration resumes (the
  // tentacle retires it from the slot the instant it does — same rule as a
  // completed tool). The input components render their own resolved read-only view.
  const permission = a?.type === 'permission' ? a : null;
  const question = a?.type === 'question' ? a : null;
  const userAbort = a?.type === 'user_abort' ? a : null;
  const failed = a?.type === 'failed' ? a : null;
  const hasAction = !!tool || batchRunning > 0 || !!permission || !!question || !!userAbort || !!failed;

  const { steps, targetSeq } = useTurnSteps(sessionId, live, frozen?.bubbleSeq);

  // TRACE steps are NOT broadcast live (Phase-10: retired from the wire) — they
  // only enter the store via a request_turn_trace pull. So proactively pull the
  // in-progress turn's trace on mount and at each STEP BOUNDARY (a card-action
  // transition: tool start/complete, prompt open/resolve) so `steps` reflects
  // reality and the Steps footer self-hides only while the turn genuinely has no
  // steps yet. Keyed off the action identity — NOT card.text — so a narration
  // token stream doesn't spam pulls. The Steps modal re-pulls fresh on open.
  // Frozen cards skip this — their trace is already persisted and the Steps
  // button pulls it lazily on open (same as any concluded bubble).
  const actionKey = useMemo(() => cardActionKey(card.action), [card.action]);
  useEffect(() => {
    if (!live) return;
    if (targetSeq < 0) return;
    messageProvider.invalidateTurnTrace(sessionId, targetSeq);
    messageProvider.requestTurnTrace(sessionId, targetSeq);
  }, [sessionId, targetSeq, actionKey, live]);

  const terminalKind = userAbort ? 'user_abort' : failed ? 'failed' : undefined;

  return (
    <div className="flex gap-2" data-live-bubble={live || undefined} data-terminal-card={terminalKind}>
      <div className="mt-0.5 shrink-0">
        <AgentAvatar agent={agent ?? ''} sessionId={sessionId} size="sm" />
      </div>
      <div className="min-w-0 max-w-[85%] overflow-hidden rounded-2xl rounded-bl-md bg-ocean-500/5 shadow-sm sm:max-w-[70%]">
        {showContentSection && (
          <div className="overflow-x-auto px-4 py-2.5">
            {hasContent && (
              <div className="markdown-content text-sm leading-relaxed text-text-primary">
                <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                  {draft}
                </Markdown>
              </div>
            )}
            <ImageAttachments attachments={frozen?.attachments} sessionId={sessionId} />
            {frozen?.artifacts && frozen.artifacts.length > 0 && (
              <HtmlArtifactCards artifacts={frozen.artifacts} onOpen={frozen.onOpenArtifact} />
            )}
            {/* Settled tail (no live action): render a footer BYTE-IDENTICAL to
               the concluded agent bubble (MessageBubble's agent_message) — same
               `mt-1` row, same timestamp (HH:MM of ~now, which matches the
               concluding message that lands <1s later), same inline Steps entry.
               So when this live bubble crystallizes into the spine agent_message,
               the DOM swap repaints the SAME pixels → zero visible flicker. The
               Steps button self-hides while the turn has no steps yet. */}
            {live && !hasAction && (
              <div className="mt-1 flex items-center gap-2">
                <p className="text-[10px] text-text-muted">{formatTime(new Date().toISOString())}</p>
                <StepsButton sessionId={sessionId} agent={agent} live />
              </div>
            )}
          </div>
        )}

        {hasAction && (
          <div className={`bg-surface-tertiary/40 px-3 py-2 ${showContentSection ? 'border-t border-border-primary/50' : ''}`}>
            {tool && (
              <ToolActivity
                type={runningTool ? 'start' : 'complete'}
                toolName={tool.payload.toolName}
                headline={tool.payload.headline ?? ''}
                argsRef={tool.payload.argsRef}
                resultRef={completedTool?.payload.resultRef}
                success={completedTool ? completedTool.payload.success !== false : undefined}
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

            {/* Terminal outcomes live in the SAME action section as tools /
               prompts — a read-only status row, no separate card chrome. A
               frozen card therefore looks exactly like the live card that was
               on screen when the turn ended, just stopped. */}
            {userAbort && (
              <div className="flex items-center gap-2 rounded-lg border border-border-primary bg-surface-primary/40 px-3 py-2 text-xs text-text-secondary">
                <CircleStop className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                <span className="font-medium">User aborted</span>
              </div>
            )}

            {failed && (
              <div className="flex items-center gap-2 rounded-lg border border-border-primary bg-surface-primary/40 px-3 py-2 text-xs">
                <OctagonX className="h-3.5 w-3.5 shrink-0 text-red-500" />
                <span className="font-medium text-red-600 dark:text-red-400">Turn failed</span>
                {failed.payload.message && (
                  <span className="truncate text-text-muted">{failed.payload.message}</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Frozen terminal card: always a permanent bottom footer (real
           timestamp + Steps) — the same footer a concluded agent_message owns,
           so the aborted/failed turn anchors its Steps history like any other. */}
        {frozen ? (
          <div className="flex items-center gap-2 px-4 py-2">
            <p className="text-[10px] text-text-muted">{formatTime(frozen.timestamp)}</p>
            <StepsButton sessionId={sessionId} agent={agent} bubbleSeq={frozen.bubbleSeq} stepHint={frozen.stepHint} />
          </div>
        ) : (
          /* Mid-turn only (an action occupies the slot): the subtle bottom-right
             Steps entry. At the settled tail the inline footer above owns Steps
             so it aligns with the concluded bubble. */
          hasAction && steps.length > 0 && (
            <div className="flex justify-end px-2 pb-1 pt-0.5">
              <StepsButton sessionId={sessionId} agent={agent} live />
            </div>
          )
        )}
      </div>
    </div>
  );
}
