import { useState, useRef, useEffect, useCallback } from 'react';
import { X } from 'lucide-react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '../../types/store';
import { MessageBubble } from './MessageBubble';

interface ThinkingBoxProps {
  messages: ChatMessage[];
  isActive: boolean;
  agent?: string;
  streamingText?: string;
}

export function ThinkingBox({ messages, isActive, agent, streamingText }: ThinkingBoxProps) {
  const [open, setOpen] = useState(false);
  const [allExpanded, setAllExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, []);

  // Scroll to bottom when modal opens
  useEffect(() => {
    if (open) {
      // Defer to allow the modal to render and measure content
      requestAnimationFrame(scrollToBottom);
    }
  }, [open, scrollToBottom]);

  // Auto-scroll on new content if already at bottom
  useEffect(() => {
    if (open && isAtBottomRef.current) {
      scrollToBottom();
    }
  }, [open, messages, streamingText, scrollToBottom]);

  const handleScroll = () => {
    if (!contentRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = contentRef.current;
    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 40;
  };

  if (messages.length === 0 && !streamingText) return null;

  const summary = streamingText
    ? streamingText.trim()
    : messages.length > 0
      ? getMessageSummary(messages[messages.length - 1])
      : 'Processing…';

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="group my-1 flex w-full items-start gap-2 rounded-lg px-3 py-1.5 text-left transition-all hover:bg-surface-tertiary active:scale-[0.98]"
      >
        <span className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${isActive ? 'animate-pulse bg-ocean-500' : 'bg-emerald-500'}`} />

        <span className="markdown-content min-w-0 text-xs font-medium text-text-secondary [&_p]:!m-0 [&_code]:text-[11px]">
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {summary}
          </Markdown>
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="mx-4 flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border-primary bg-surface-primary shadow-2xl sm:max-w-3xl lg:max-w-6xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border-primary px-5 py-3">
              <h3 className="text-sm font-semibold text-text-primary">
                Steps
              </h3>
              <button
                onClick={() => setOpen(false)}
                className="hidden rounded-md p-1 text-text-muted transition-colors hover:bg-surface-tertiary hover:text-text-primary sm:block"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div ref={contentRef} onScroll={handleScroll} className="min-w-0 overflow-y-auto px-5 py-4">
              <div className="min-w-0 space-y-3">
                {messages.map((msg, idx) => {
                  if (msg.type === 'agent_message') {
                    return (
                      <div key={'seq' in msg && msg.seq ? `${msg.seq}-${msg.type}` : `thinking-${idx}`} className="markdown-content text-sm leading-relaxed text-text-secondary">
                        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                          {msg.payload.content}
                        </Markdown>
                      </div>
                    );
                  }
                  return (
                    <MessageBubble
                      key={'seq' in msg && msg.seq ? `${msg.seq}-${msg.type}` : `thinking-${idx}`}
                      message={msg}
                      agent={agent}
                      forceExpanded={allExpanded || undefined}
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
            </div>

            <div className="flex items-center border-t border-border-primary px-5 py-3 sm:hidden">
              <button
                onClick={() => setAllExpanded(!allExpanded)}
                className="rounded-lg bg-ocean-500/10 px-3 py-2 text-xs font-medium text-ocean-600/80 transition-colors hover:bg-ocean-500/20 active:scale-[0.98] dark:text-ocean-400/80"
              >
                {allExpanded ? 'Collapse All' : 'Expand All'}
              </button>
              <div className="flex-1" />
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg bg-kraki-500 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-kraki-600 active:scale-[0.98]"
              >
                Back to Chat
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
      const detail = getToolDetail(args);
      return detail || (toolName ? `Running ${toolName}` : 'Running…');
    }
    case 'tool_complete': {
      const toolName = msg.payload.toolName;
      const args = msg.payload.args as Record<string, unknown>;
      const detail = getToolDetail(args);
      return detail || toolName || 'Done';
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
    case 'error':
      return `Error: ${truncate(msg.payload.message, 50)}`;
    case 'idle':
      return 'Waiting…';
    case 'session_mode_set':
      return `Mode: ${msg.payload.mode ?? 'updated'}`;
    default:
      return 'Processing…';
  }
}

function getToolDetail(args: Record<string, unknown>): string {
  if (typeof args.command === 'string') return truncate(`$ ${args.command}`, 50);
  if (typeof args.path === 'string') return truncate(args.path, 50);
  if (typeof args.pattern === 'string') return truncate(args.pattern, 50);
  if (typeof args.url === 'string') return truncate(args.url, 50);
  return '';
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}
