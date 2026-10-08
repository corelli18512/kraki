import type { ContentRef } from '@kraki/protocol';
import { ChevronRight, CheckCircle2, CircleSlash, Loader2, Lock, TriangleAlert, XCircle } from 'lucide-react';
import {
  callIdOf, contentsLabel, formatDuration, isSubagentStep, mergeSteps, stepsUnder,
  subagentOf, subagentStatus,
} from '../../lib/subagent-steps';
import type { ChatMessage } from '../../types/store';
import { Markdown, StreamingMarkdown } from './Markdown';
import { ToolActivity } from './ToolActivity';

const pull = (sid: string, ref: ContentRef): void => {
  void import('../../lib/ws-client').then(({ wsClient }) => wsClient.requestAttachment(sid, ref));
};

/** One non-prose step: a tool chip, a permission record or an error. */
function StepRow({ msg, sessionId, forceExpanded, cancelled }: { msg: ChatMessage; sessionId: string; forceExpanded?: boolean; cancelled?: boolean }) {
  const p = msg.payload as Record<string, unknown>;
  if (msg.type === 'tool_start' || msg.type === 'tool_complete') {
    return (
      <ToolActivity
        type={msg.type === 'tool_start' ? 'start' : 'complete'}
        toolName={String(p.toolName ?? 'tool')}
        headline={String(p.headline ?? '')}
        argsRef={p.argsRef as ContentRef | undefined}
        resultRef={p.resultRef as ContentRef | undefined}
        sessionId={sessionId}
        requestPull={pull}
        success={p.success as boolean | undefined}
        termination={p.termination as never}
        cancelled={cancelled}
        forceExpanded={forceExpanded}
      />
    );
  }
  if (msg.type === 'permission') {
    const decision = p.decision as string | undefined;
    const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
    return (
      <div className="kstep-note">
        <Lock className="kstep-icon" aria-hidden />
        <span>{String(p.description || (p.toolName ? `Run ${String(p.toolName)}` : 'Permission'))}</span>
        {decision && <span className={decision === 'deny' ? 'kstep-bad' : 'kstep-good'}>{decision === 'deny' ? (reason ? `Denied: ${reason}` : 'Denied') : decision === 'always_allow' ? 'Always allowed' : 'Approved'}</span>}
      </div>
    );
  }
  if (msg.type === 'error') {
    return (
      <div className="kstep-note kstep-bad">
        <TriangleAlert className="kstep-icon" aria-hidden />
        <span>{String(p.message ?? 'Error')}</span>
      </div>
    );
  }
  return null;
}

/** A step that dispatched a subagent: a card that opens the subagent's page. */
export function SubagentCard({ msg, merged, onOpen }: { msg: ChatMessage; merged: ChatMessage[]; onOpen: (id: string) => void }) {
  const id = callIdOf(msg) ?? '';
  const info = subagentOf(msg);
  const status = subagentStatus(msg);
  const meta = [
    status === 'running' ? 'Running' : undefined,
    contentsLabel(merged, id),
    formatDuration(info?.durationMs),
  ].filter(Boolean).join(' · ');
  const Icon = status === 'running' ? Loader2 : status === 'failed' ? XCircle : status === 'stopped' ? CircleSlash : CheckCircle2;
  return (
    <button type="button" className="ksub-card" data-status={status} onClick={() => onOpen(id)} aria-label={`Open subagent ${info?.name ?? ''}`}>
      <Icon className={`ksub-status ksub-status-${status}`} aria-hidden />
      <span className="ksub-text">
        <span className="ksub-name">{info?.name ?? String((msg.payload as { toolName?: string }).toolName ?? 'subagent')}</span>
        {info?.task && <span className="ksub-task">{info.task}</span>}
      </span>
      {meta && <span className="ksub-meta">{meta}</span>}
      <ChevronRight className="ksub-chevron" aria-hidden />
    </button>
  );
}

interface StepsListProps {
  /** Interleaved trace steps in recorded order (tool_start/tool_complete +
   *  agent_narration / agent_message narration prose). */
  messages: ChatMessage[];
  /** Agent id (for tool chip styling / avatars in nested bubbles). */
  agent?: string;
  sessionId?: string;
  /** Live streaming delta draft (ephemeral) shown after the finalized steps. */
  streamingText?: string;
  /** Force every tool chip open (used by the "expand all" affordance). */
  allExpanded?: boolean;
  /** Mark in-flight tool_start chips as cancelled (aborted turn). */
  aborted?: boolean;
  /** Show one subagent's steps (its dispatch toolCallId); default: the turn's own. */
  parentId?: string;
  /** Open a subagent's page. Without it, dispatches render as plain tool chips. */
  onOpenSubagent?: (id: string) => void;
}

/**
 * Presentational core that renders a turn's TRACE steps as an interleaved list
 * of narration prose and tool chips, optionally followed by the live streaming
 * draft. Shared by the live in-progress LiveAgentBubble and the
 * right-click "Open steps" history popover on concluded agent_message bubbles.
 */
export function StepsList({ messages, agent: _agent, sessionId, streamingText, allExpanded, aborted, parentId, onOpenSubagent }: StepsListProps) {
  // Merge tool_start → tool_complete by toolCallId (protocol contract): once a
  // tool has completed, drop its earlier tool_start chip so a finished tool
  // renders as a single "done" chip instead of a duplicate "Running…" + "done"
  // pair. In-flight tools (no matching tool_complete) keep their tool_start.
  // Subagents' own steps are on their pages, not here.
  const merged = mergeSteps(messages);
  const resolvedPromptIds = new Set<string>();
  for (const msg of messages) {
    if (msg.type === 'permission') {
      const p = msg.payload as { id?: string; decision?: string; cancelled?: boolean };
      if (p.id && (p.decision || p.cancelled)) resolvedPromptIds.add(`permission:${p.id}`);
    }
  }
  const visible = stepsUnder(merged, parentId).filter((msg) => {
    if (msg.type === 'permission') {
      const p = msg.payload as { id?: string; decision?: string; cancelled?: boolean };
      const resolved = !!p.decision || !!p.cancelled;
      return resolved || !p.id || !resolvedPromptIds.has(`${msg.type}:${p.id}`);
    }
    return true;
  });

  return (
    <div className="min-w-0 space-y-3">
      {visible.map((msg, idx) => {
        if (msg.type === 'active') return null;
        const key = 'seq' in msg && (msg as { seq?: number }).seq
          ? `${(msg as { seq?: number }).seq}-${msg.type}`
          : `step-${idx}`;
        if (msg.type === 'agent_message' || msg.type === 'agent_narration') {
          return (
            <div key={key} className="kstep-prose">
              <Markdown text={(msg.payload as { content: string }).content} />
            </div>
          );
        }
        if (onOpenSubagent && isSubagentStep(merged, msg)) {
          return <SubagentCard key={key} msg={msg} merged={merged} onOpen={onOpenSubagent} />;
        }
        return (
          <StepRow
            key={key}
            msg={msg}
            sessionId={sessionId ?? ''}
            forceExpanded={allExpanded || undefined}
            cancelled={aborted && msg.type === 'tool_start'}
          />
        );
      })}
      {streamingText && (
        <div className="kstep-prose"><StreamingMarkdown text={streamingText} /></div>
      )}
    </div>
  );
}
