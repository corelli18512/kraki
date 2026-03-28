import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { PermissionRequest as ProtocolPermissionRequest, QuestionRequest as ProtocolQuestionRequest } from '@kraki/protocol';
import type { ChatMessage } from '../../types/store';
import { formatTime, agentInfo } from '../../lib/format';
import { ToolActivity } from './ToolActivity';
import { AgentAvatar } from '../common/AgentAvatar';
import { Lock, HelpCircle, Check, X, Ban, LockOpen, CircleStop } from 'lucide-react';

const ID_DISPLAY_LENGTH = 8;

const markdownComponents = {
  a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
  ),
  table: ({ children, ...props }: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div className="max-h-60 overflow-auto">
      <table {...props}>{children}</table>
    </div>
  ),
};

export function MessageBubble({ message, agent, forceExpanded }: { message: ChatMessage; agent?: string; forceExpanded?: boolean }) {
  switch (message.type) {
    case 'user_message':
      return (
        <div className="flex justify-end">
          <div className="min-w-0 max-w-[85%] overflow-x-auto rounded-2xl rounded-br-md bg-kraki-500 px-4 py-2.5 text-white shadow-sm sm:max-w-[70%]">
            <div className="markdown-content text-sm leading-relaxed">
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                {message.payload.content}
              </Markdown>
            </div>
            <p className="mt-1 text-right text-[10px] text-white/60">
              {formatTime(message.timestamp)}
            </p>
          </div>
        </div>
      );

    case 'agent_message':
      return (
        <div className="flex gap-2">
          <div className="mt-0.5 shrink-0">
            <AgentAvatar agent={agent ?? ''} size="sm" />
          </div>
          <div className="min-w-0 max-w-[85%] overflow-x-auto rounded-2xl rounded-bl-md bg-ocean-500/5 px-4 py-2.5 shadow-sm sm:max-w-[70%]">
            <div className="markdown-content text-sm leading-relaxed text-text-primary">
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                {message.payload.content}
              </Markdown>
            </div>
            <p className="mt-1 text-[10px] text-text-muted">
              {formatTime(message.timestamp)}
            </p>
          </div>
        </div>
      );

    case 'session_created': {
      const { emoji, label } = agentInfo(message.payload.agent);
      return (
        <div className="flex items-center justify-center py-2">
          <span className="flex items-center gap-1.5 text-xs text-text-muted">
            {emoji} {label} session started
            {message.payload.model && (
              <span className="text-text-muted">({message.payload.model})</span>
            )}
          </span>
        </div>
      );
    }

    case 'session_ended':
      return (
        <div className="flex items-center justify-center py-2">
          <span className="text-xs text-text-muted">
            Session ended — {message.payload.reason}
          </span>
        </div>
      );

    case 'tool_start':
      return <ToolActivity type="start" toolName={message.payload.toolName} args={message.payload.args as Record<string, unknown>} forceExpanded={forceExpanded} />;

    case 'tool_complete':
      return (
        <ToolActivity
          type="complete"
          toolName={message.payload.toolName}
          args={message.payload.args as Record<string, unknown>}
          result={message.payload.result}
          forceExpanded={forceExpanded}
        />
      );

    case 'error':
      return (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5">
          <p className="text-xs font-medium text-red-500">Error</p>
          <p className="mt-0.5 text-sm text-red-400">{message.payload.message}</p>
        </div>
      );

    case 'send_input':
      return (
        <div className="flex justify-end">
          <div className="min-w-0 max-w-[85%] overflow-x-auto rounded-2xl rounded-br-md bg-kraki-500 px-4 py-2.5 text-white shadow-sm sm:max-w-[70%]">
            <p className="text-sm">{message.payload.text}</p>
            <p className="mt-1 text-right text-[10px] text-white/60">
              {formatTime(message.timestamp)}
            </p>
          </div>
        </div>
      );

    case 'permission': {
      const toolName = message.payload.toolName;
      const args = message.payload.args as Record<string, unknown> | undefined;
      const argsSummary = args ? getPermissionArgsSummary(toolName, args) : '';
      const desc = message.payload.description;
      const resolution = (message.payload as ProtocolPermissionRequest['payload'] & { resolution?: 'approved' | 'denied' | 'always_allowed' }).resolution;
      // Build a meaningful description
      const displayDesc = desc && desc !== 'Run:' && desc !== `Run: `
        ? desc
        : argsSummary
          ? `Run: ${argsSummary}`
          : `Run ${toolName}`;

      if (resolution) {
        const isApproved = resolution !== 'denied';
        const ResIcon = resolution === 'always_allowed' ? LockOpen : isApproved ? Check : X;
        const label = resolution === 'approved' ? 'Approved'
          : resolution === 'always_allowed' ? 'Allowed for session'
          : 'Denied';
        return (
          <div className="flex justify-end">
            <div className={`min-w-0 max-w-[85%] overflow-x-auto rounded-2xl rounded-br-md px-4 py-2.5 shadow-sm sm:max-w-[70%] ${isApproved ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
              <p className={`flex items-center gap-1 text-xs font-medium ${isApproved ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                <ResIcon className="h-3.5 w-3.5" />
                {label} · <span className="font-mono">{toolName}</span>
              </p>
              <p className="mt-0.5 font-mono text-sm text-text-primary">{displayDesc}</p>
              {argsSummary && argsSummary !== displayDesc.replace('Run: ', '') && (
                <pre className="mt-1 max-h-20 overflow-auto rounded bg-surface-tertiary px-2 py-1 font-mono text-[11px] text-text-secondary">
                  {argsSummary}
                </pre>
              )}
            </div>
          </div>
        );
      }

      // Pending state (normally hidden behind the PermissionInput blocker)
      return (
        <div className="flex gap-2">
          <Lock className="mt-1 h-4 w-4 text-amber-500" />
          <div className="min-w-0 max-w-[85%] overflow-x-auto rounded-2xl rounded-bl-md bg-amber-500/10 px-4 py-2.5 shadow-sm sm:max-w-[70%]">
            <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
              Permission requested · <span className="font-mono">{toolName}</span>
            </p>
            <p className="mt-0.5 font-mono text-sm text-text-primary">{displayDesc}</p>
            {argsSummary && argsSummary !== displayDesc.replace('Run: ', '') && (
              <pre className="mt-1 max-h-20 overflow-auto rounded bg-surface-tertiary px-2 py-1 font-mono text-[11px] text-text-secondary">
                {argsSummary}
              </pre>
            )}
          </div>
        </div>
      );
    }

    case 'question': {
      const answer = (message.payload as ProtocolQuestionRequest['payload'] & { answer?: string }).answer;
      if (answer) {
        return (
          <div className="flex gap-2">
            <HelpCircle className="mt-1 h-4 w-4 text-violet-500" />
            <div className="min-w-0 max-w-[85%] overflow-x-auto rounded-2xl rounded-bl-md bg-violet-500/10 px-4 py-2.5 shadow-sm sm:max-w-[70%]">
              <p className="text-xs font-medium text-violet-600 dark:text-violet-400">
                Question · <span className="text-emerald-600 dark:text-emerald-400">Answered</span>
              </p>
              <p className="mt-0.5 text-sm text-text-primary">{message.payload.question}</p>
              <p className="mt-1.5 rounded-lg bg-surface-tertiary px-3 py-1.5 text-sm text-text-primary">{answer}</p>
            </div>
          </div>
        );
      }
      return (
        <div className="flex gap-2">
          <HelpCircle className="mt-1 h-4 w-4 text-violet-500" />
          <div className="min-w-0 max-w-[85%] overflow-x-auto rounded-2xl rounded-bl-md bg-violet-500/10 px-4 py-2.5 shadow-sm sm:max-w-[70%]">
            <p className="text-xs font-medium text-violet-600 dark:text-violet-400">
              Question
            </p>
            <p className="mt-0.5 text-sm text-text-primary">{message.payload.question}</p>
          </div>
        </div>
      );
    }

    case 'approve':
    case 'deny':
    case 'always_allow':
      return null;

    case 'answer':
      return (
        <div className="flex justify-end">
          <div className="min-w-0 max-w-[85%] overflow-x-auto rounded-2xl rounded-br-md bg-kraki-600 px-4 py-2.5 text-white shadow-sm sm:max-w-[70%]">
            <p className="text-[10px] font-medium text-white/70">Answer</p>
            <p className="text-sm">{message.payload.answer}</p>
          </div>
        </div>
      );

    case 'kill_session':
      return <SystemAction icon={<CircleStop className="h-3.5 w-3.5 text-red-400" />} text="Session killed" time={'timestamp' in message ? message.timestamp : ''} />;

    case 'pending_input':
      return (
        <div className="flex justify-end">
          <div className="min-w-0 max-w-[85%] overflow-x-auto rounded-2xl rounded-br-md bg-kraki-500/70 px-4 py-2.5 text-white shadow-sm sm:max-w-[70%]">
            <p className="text-sm">{message.text}</p>
            <p className="mt-1 flex items-center justify-end gap-1 text-[10px] text-white/60">
              <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-white/40 border-t-white/90" />
              Sending…
            </p>
          </div>
        </div>
      );

    default:
      return null;
  }
}

function SystemAction({ icon, text, time }: { icon: React.ReactNode; text: string; time: string }) {
  return (
    <div className="flex items-center justify-center gap-1.5 py-1">
      <span className="flex items-center">{icon}</span>
      <span className="text-[11px] text-text-muted">{text}</span>
      {time && <span className="text-[10px] text-text-muted">· {formatTime(time)}</span>}
    </div>
  );
}

function getPermissionArgsSummary(toolName: string, args: Record<string, unknown>): string {
  if ((toolName === 'shell' || toolName === 'bash') && typeof args.command === 'string' && args.command) return args.command;
  if ((toolName === 'write_file' || toolName === 'read_file' || toolName === 'edit') && typeof args.path === 'string' && args.path) return args.path;
  if (typeof args.command === 'string' && args.command) return args.command;
  if (typeof args.path === 'string' && args.path) return args.path;
  return '';
}
