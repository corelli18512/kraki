import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ChatMessage } from '../../types/store';
import { MessageBubble } from './MessageBubble';

interface ThinkingBoxProps {
  messages: ChatMessage[];
  isActive: boolean;
  agent?: string;
}

export function ThinkingBox({ messages, isActive, agent }: ThinkingBoxProps) {
  const [expanded, setExpanded] = useState(false);

  if (messages.length === 0) return null;

  const lastMsg = messages[messages.length - 1];
  const summary = getMessageSummary(lastMsg);
  const stepCount = messages.filter((m) =>
    m.type === 'tool_start' || m.type === 'tool_complete' ||
    m.type === 'agent_message' || m.type === 'permission' ||
    m.type === 'question' || m.type === 'error'
  ).length;

  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="group flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-all hover:bg-surface-tertiary active:scale-[0.98]"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform duration-200 ${
            expanded ? 'rotate-90' : ''
          }`}
        />

        {isActive && (
          <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-ocean-500" />
        )}

        <span className="shrink-0 text-xs font-medium text-text-secondary">
          {stepCount > 0 && (
            <span className="text-text-muted">
              {stepCount} {stepCount === 1 ? 'step' : 'steps'}
              {' · '}
            </span>
          )}
          {summary}
        </span>
      </button>

      {expanded && (
        <div className="ml-3 mt-1 space-y-2 border-l-2 border-border-primary pl-3">
          {messages.map((msg, idx) => (
            <MessageBubble
              key={'seq' in msg && msg.seq ? `${msg.seq}-${msg.type}` : `thinking-${idx}`}
              message={msg}
              agent={agent}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function getMessageSummary(msg: ChatMessage): string {
  switch (msg.type) {
    case 'tool_start': {
      const toolName = msg.payload.toolName;
      const args = msg.payload.args as Record<string, unknown>;
      const detail = getToolDetail(toolName, args);
      return detail ? `Running ${toolName} ${detail}` : `Running ${toolName}`;
    }
    case 'tool_complete': {
      const toolName = msg.payload.toolName;
      const args = msg.payload.args as Record<string, unknown>;
      const detail = getToolDetail(toolName, args);
      return detail ? `Completed ${toolName} ${detail}` : `Completed ${toolName}`;
    }
    case 'agent_message': {
      const content = msg.payload.content;
      if (!content) return 'Agent thinking…';
      const trimmed = content.trim();
      const firstLine = trimmed.split('\n')[0];
      return firstLine.length > 60 ? firstLine.slice(0, 57) + '…' : firstLine;
    }
    case 'permission':
      return `Permission: ${msg.payload.toolName}`;
    case 'question':
      return `Question: ${truncate(msg.payload.question, 50)}`;
    case 'error':
      return `Error: ${truncate(msg.payload.message, 50)}`;
    default:
      return 'Processing…';
  }
}

function getToolDetail(toolName: string, args: Record<string, unknown>): string {
  if ((toolName === 'shell' || toolName === 'bash') && typeof args.command === 'string') {
    return truncate(`$ ${args.command}`, 50);
  }
  if (typeof args.path === 'string') return truncate(args.path, 50);
  if (typeof args.pattern === 'string') return truncate(args.pattern, 50);
  if (typeof args.url === 'string') return truncate(args.url, 50);
  return '';
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}
