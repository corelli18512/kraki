import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '../../types/store';
import { MessageBubble } from './MessageBubble';

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
}

/**
 * Presentational core that renders a turn's TRACE steps as an interleaved list
 * of narration prose and tool chips, optionally followed by the live streaming
 * draft. Shared by the live in-progress LiveAgentBubble and the
 * right-click "Open steps" history popover on concluded agent_message bubbles.
 */
export function StepsList({ messages, agent, sessionId, streamingText, allExpanded, aborted }: StepsListProps) {
  // Merge tool_start → tool_complete by toolCallId (protocol contract): once a
  // tool has completed, drop its earlier tool_start chip so a finished tool
  // renders as a single "done" chip instead of a duplicate "Running…" + "done"
  // pair. In-flight tools (no matching tool_complete) keep their tool_start.
  const completedToolIds = new Set<string>();
  const resolvedPromptIds = new Set<string>();
  for (const msg of messages) {
    if (msg.type === 'tool_complete') {
      const id = (msg.payload as { toolCallId?: string }).toolCallId;
      if (id) completedToolIds.add(id);
    } else if (msg.type === 'permission') {
      const p = msg.payload as { id?: string; decision?: string; cancelled?: boolean };
      if (p.id && (p.decision || p.cancelled)) resolvedPromptIds.add(`permission:${p.id}`);
    } else if (msg.type === 'question') {
      const p = msg.payload as { id?: string; answer?: string; cancelled?: boolean };
      if (p.id && (p.answer !== undefined || p.cancelled)) resolvedPromptIds.add(`question:${p.id}`);
    }
  }
  const visible = messages.filter((msg) => {
    if (msg.type === 'tool_start') {
      const id = (msg.payload as { toolCallId?: string }).toolCallId;
      return !(id && completedToolIds.has(id));
    }
    if (msg.type === 'permission' || msg.type === 'question') {
      const p = msg.payload as { id?: string; decision?: string; answer?: string; cancelled?: boolean };
      const resolved = !!p.decision || p.answer !== undefined || !!p.cancelled;
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
            <div key={key} className="markdown-content text-sm leading-relaxed text-text-secondary">
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {(msg.payload as { content: string }).content}
              </Markdown>
            </div>
          );
        }
        return (
          <MessageBubble
            key={key}
            message={msg}
            agent={agent}
            sessionId={sessionId}
            forceExpanded={allExpanded || undefined}
            cancelled={aborted && msg.type === 'tool_start'}
          />
        );
      })}
      {streamingText && (
        <div className="markdown-content text-sm leading-relaxed text-text-secondary">
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {streamingText}
          </Markdown>
          <span className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse bg-text-muted" />
        </div>
      )}
    </div>
  );
}
