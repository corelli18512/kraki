import { useState } from 'react';
import { X } from 'lucide-react';
import type { ChatMessage } from '../../types/store';
import { MessageBubble } from './MessageBubble';

interface ThinkingBoxProps {
  messages: ChatMessage[];
  isActive: boolean;
  agent?: string;
}

export function ThinkingBox({ messages, isActive, agent }: ThinkingBoxProps) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  if (messages.length === 0) return null;

  const lastMsg = messages[messages.length - 1];
  const summary = getMessageSummary(lastMsg);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="group my-1 flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-all hover:bg-surface-tertiary active:scale-[0.98]"
      >
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${isActive ? 'animate-pulse bg-ocean-500' : 'bg-emerald-500'}`} />

        <span className="truncate text-xs font-medium text-text-secondary">
          {summary}
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="mx-4 flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border border-border-primary bg-surface-primary shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border-primary px-5 py-3">
              <h3 className="text-sm font-semibold text-text-primary">
                Thinking Process
              </h3>
              <button
                onClick={() => setOpen(false)}
                className="hidden rounded-md p-1 text-text-muted transition-colors hover:bg-surface-tertiary hover:text-text-primary sm:block"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="overflow-y-auto px-5 py-4">
              {expanded ? (
                <div className="space-y-3">
                  {messages.map((msg, idx) => (
                    <MessageBubble
                      key={'seq' in msg && msg.seq ? `${msg.seq}-${msg.type}` : `thinking-${idx}`}
                      message={msg}
                      agent={agent}
                    />
                  ))}
                </div>
              ) : (
                <ol className="space-y-1 text-xs text-text-secondary">
                  {messages.map((msg, idx) => (
                    <li key={'seq' in msg && msg.seq ? `${msg.seq}-${msg.type}` : `thinking-${idx}`} className="flex items-start gap-2 py-0.5">
                      <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-text-muted" />
                      <span className="truncate">{getMessageSummary(msg)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="flex items-center border-t border-border-primary px-5 py-3 sm:hidden">
              <button
                onClick={() => setExpanded(!expanded)}
                className="rounded-lg bg-surface-tertiary px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-secondary active:scale-[0.98]"
              >
                {expanded ? 'Collapse' : 'Expand'}
              </button>
              <div className="flex-1" />
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg bg-surface-tertiary px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-secondary active:scale-[0.98]"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
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
