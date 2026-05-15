import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { PermissionRequest as ProtocolPermissionRequest, QuestionRequest as ProtocolQuestionRequest, Attachment } from '@kraki/protocol';
import type { ChatMessage } from '../../types/store';
import { formatTime, agentInfo } from '../../lib/format';
import { stringToHue } from '../../lib/color';
import { ToolActivity } from './ToolActivity';
import { AgentAvatar } from '../common/AgentAvatar';
import { Lock, Check, X, LockOpen, CircleStop, Copy } from 'lucide-react';
import { useState, useRef, useCallback, useEffect } from 'react';
import { useAttachment } from '../../hooks/useAttachment';

const ID_DISPLAY_LENGTH = 8;
const IMAGE_PLACEHOLDER = '[image]';

/** Shared pull thunk for any ContentRef rendered inside a message bubble —
 *  args/result on tool calls, images, etc. We lazy-import ws-client to
 *  break the cycle (MessageBubble is re-exported through several layers). */
const ATTACHMENT_PULL = (sid: string, id: string): void => {
  void import('../../lib/ws-client').then(({ wsClient }) => {
    wsClient.requestAttachment(sid, id);
  });
};

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

export function MessageBubble({ message, agent, forceExpanded, turnImages, cancelled, sessionId }: { message: ChatMessage; agent?: string; forceExpanded?: boolean; turnImages?: Attachment[]; cancelled?: boolean; sessionId?: string }) {
  switch (message.type) {
    case 'user_message': {
      const showUserText = message.payload.content !== IMAGE_PLACEHOLDER;
      return (
        <CopyableBubble text={message.payload.content}>
          <div className="flex justify-end">
            <div className="min-w-0 max-w-[85%] overflow-x-auto rounded-2xl rounded-br-md bg-kraki-500 px-4 py-2.5 text-white shadow-sm sm:max-w-[70%]">
              {showUserText && (
                <div className="markdown-content text-sm leading-relaxed">
                  <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                    {message.payload.content}
                  </Markdown>
                </div>
              )}
              <ImageAttachments attachments={message.payload.attachments as Attachment[] | undefined} sessionId={sessionId} />
              <p className="mt-1 text-right text-[10px] text-white/60">
                {formatTime(message.timestamp)}
              </p>
            </div>
          </div>
        </CopyableBubble>
      );
    }

    case 'agent_message':
      return (
        <CopyableBubble text={message.payload.content}>
          <div className="flex gap-2">
            <div className="mt-0.5 shrink-0">
              <AgentAvatar agent={agent ?? ''} sessionId={sessionId} size="sm" />
            </div>
            <div className="min-w-0 max-w-[85%] overflow-x-auto rounded-2xl rounded-bl-md bg-ocean-500/5 px-4 py-2.5 shadow-sm sm:max-w-[70%]">
              <div className="markdown-content text-sm leading-relaxed text-text-primary">
                <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                  {message.payload.content}
                </Markdown>
              </div>
              <ImageAttachments attachments={message.payload.attachments as Attachment[] | undefined} sessionId={sessionId} />
              {turnImages && turnImages.length > 0 && <ImageAttachments attachments={turnImages} sessionId={sessionId} />}
              <p className="mt-1 text-[10px] text-text-muted">
                {formatTime(message.timestamp)}
              </p>
            </div>
          </div>
        </CopyableBubble>
      );

    case 'session_created': {
      const { emoji, label } = agentInfo(message.payload.agent);
      return (
        <div className="flex items-center justify-center py-2">
          <span className="flex items-center gap-1.5 text-xs text-text-muted">
            {emoji} {label} session {(message.payload.forked || message.seq > 1) ? 'forked' : 'started'}
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
      return <ToolActivity
        type="start"
        toolName={message.payload.toolName}
        headline={(message.payload as { headline?: string }).headline ?? ''}
        argsRef={(message.payload as { argsRef?: import('@kraki/protocol').ContentRef }).argsRef}
        sessionId={sessionId ?? ''}
        requestPull={ATTACHMENT_PULL}
        cancelled={cancelled}
        forceExpanded={forceExpanded}
      />;

    case 'tool_complete':
      return (
        <>
          <ToolActivity
            type="complete"
            toolName={message.payload.toolName}
            headline={(message.payload as { headline?: string }).headline ?? ''}
            argsRef={(message.payload as { argsRef?: import('@kraki/protocol').ContentRef }).argsRef}
            resultRef={(message.payload as { resultRef?: import('@kraki/protocol').ContentRef }).resultRef}
            sessionId={sessionId ?? ''}
            requestPull={ATTACHMENT_PULL}
            success={message.payload.success}
            forceExpanded={forceExpanded}
          />
          <ImageAttachments attachments={message.payload.attachments as Attachment[] | undefined} sessionId={sessionId} />
        </>
      );

    case 'error':
      return (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5">
          <p className="text-xs font-medium text-red-500">Error</p>
          <div className="mt-0.5 markdown-content text-sm text-red-400">
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
              {message.payload.message}
            </Markdown>
          </div>
        </div>
      );

    case 'send_input':
      return (
        <div className="flex justify-end">
          <div className="min-w-0 max-w-[85%] overflow-x-auto rounded-2xl rounded-br-md bg-kraki-500 px-4 py-2.5 text-white shadow-sm sm:max-w-[70%]">
            {message.payload.text !== IMAGE_PLACEHOLDER && <p className="text-sm">{message.payload.text}</p>}
            <ImageAttachments attachments={message.payload.attachments as Attachment[] | undefined} sessionId={sessionId} />
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
      const resolution = (message.payload as ProtocolPermissionRequest['payload'] & { resolution?: 'approved' | 'denied' | 'always_allowed' | 'cancelled' }).resolution;
      // Build a meaningful description
      const displayDesc = desc && desc !== 'Run:' && desc !== `Run: `
        ? desc
        : argsSummary
          ? `Run: ${argsSummary}`
          : `Run ${toolName}`;

      if (resolution) {
        const isApproved = resolution === 'approved' || resolution === 'always_allowed';
        const isCancelled = resolution === 'cancelled';
        const ResIcon = resolution === 'always_allowed' ? LockOpen
          : isCancelled ? CircleStop
          : isApproved ? Check : X;
        const label = resolution === 'approved' ? 'Approved'
          : resolution === 'always_allowed' ? 'Allowed for session'
          : resolution === 'cancelled' ? 'Cancelled'
          : 'Denied';
        const colorClass = isApproved ? 'bg-emerald-500/10' : isCancelled ? 'bg-slate-500/10' : 'bg-red-500/10';
        const textClass = isApproved ? 'text-emerald-600 dark:text-emerald-400' : isCancelled ? 'text-text-muted' : 'text-red-600 dark:text-red-400';
        return (
          <div className="flex justify-end">
            <div className={`min-w-0 max-w-[85%] overflow-x-auto rounded-2xl rounded-br-md px-4 py-2.5 shadow-sm sm:max-w-[70%] ${colorClass}`}>
              <p className={`flex items-center gap-1 text-xs font-medium ${textClass}`}>
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
      return (
        <>
          <div className="flex gap-2">
            <div className="mt-0.5 shrink-0">
              <AgentAvatar agent={agent ?? ''} sessionId={sessionId} size="sm" />
            </div>
            <div className="min-w-0 max-w-[85%] overflow-x-auto rounded-2xl rounded-bl-md bg-ocean-500/5 px-4 py-2.5 shadow-sm sm:max-w-[70%]">
              <div className="markdown-content text-sm leading-relaxed text-text-primary">
                <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                  {message.payload.question}
                </Markdown>
              </div>
              <p className="mt-1 text-[10px] text-text-muted">
                {formatTime(message.timestamp)}
              </p>
            </div>
          </div>
          {answer && (
            <div className="flex justify-end">
              <div className="min-w-0 max-w-[85%] overflow-x-auto rounded-2xl rounded-br-md bg-kraki-500 px-4 py-2.5 text-white shadow-sm sm:max-w-[70%]">
                <p className="text-sm">{answer}</p>
                <p className="mt-1 text-right text-[10px] text-white/60">
                  {formatTime(message.timestamp)}
                </p>
              </div>
            </div>
          )}
        </>
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
            {message.text !== IMAGE_PLACEHOLDER && <p className="text-sm">{message.text}</p>}
            <ImageAttachments attachments={message.attachments as Attachment[] | undefined} sessionId={sessionId} />
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

const LONG_PRESS_MS = 500;

function CopyableBubble({ text, children }: { text: string; children: React.ReactNode }) {
  const [showCopy, setShowCopy] = useState(false);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); setShowCopy(false); }, 1000);
    }).catch(() => {});
  }, [text]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setShowCopy(true);
  }, []);

  const handleTouchStart = useCallback(() => {
    timerRef.current = setTimeout(() => { setShowCopy(true); }, LONG_PRESS_MS);
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  // Dismiss on outside click
  useEffect(() => {
    if (!showCopy) return;
    const dismiss = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowCopy(false);
      }
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('touchstart', dismiss);
    return () => { document.removeEventListener('mousedown', dismiss); document.removeEventListener('touchstart', dismiss); };
  }, [showCopy]);

  return (
    <div
      ref={containerRef}
      className="relative"
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      {children}
      {showCopy && (
        <button
          onClick={handleCopy}
          className="absolute -top-8 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-lg bg-surface-primary px-2.5 py-1 text-xs font-medium text-text-primary shadow-lg border border-border-primary transition-all active:scale-95"
        >
          <Copy className="h-3 w-3" />
          {copied ? 'Copied!' : 'Copy'}
        </button>
      )}
    </div>
  );
}

function ImageAttachments({ attachments, sessionId }: { attachments?: Attachment[]; sessionId?: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const images = attachments?.filter(
    (a): a is (Attachment & { type: 'image' }) | (Attachment & { type: 'content_ref' }) =>
      a.type === 'image' || a.type === 'content_ref',
  );
  if (!images?.length) return null;

  return (
    <>
      <div className="mt-2 flex flex-wrap gap-3">
        {images.map((img, i) => (
          <AttachmentTile
            key={i}
            attachment={img}
            sessionId={sessionId}
            onExpand={(url) => setExpanded(url)}
          />
        ))}
      </div>
      {expanded && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
          onClick={() => setExpanded(null)}
          onKeyDown={(e) => e.key === 'Escape' && setExpanded(null)}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
        >
          <img src={expanded} alt="Full size" className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain" />
        </div>
      )}
    </>
  );
}

function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>): void {
  const scrollable = (e.target as HTMLElement).closest('[data-chat-scroll]');
  if (scrollable) {
    const { scrollTop, scrollHeight, clientHeight } = scrollable;
    if (scrollHeight - scrollTop - clientHeight < 80) {
      scrollable.scrollTop = scrollHeight;
    }
  }
}

function AttachmentTile({
  attachment,
  sessionId,
  onExpand,
}: {
  attachment: Attachment & ({ type: 'image' } | { type: 'content_ref' });
  sessionId?: string;
  onExpand: (url: string) => void;
}) {
  if (attachment.type === 'image') {
    const src = `data:${attachment.mimeType};base64,${attachment.data}`;
    return (
      <figure className="m-0 flex flex-col items-start gap-1">
        <button
          type="button"
          className="overflow-hidden rounded-lg border border-border-primary/20"
          onClick={() => onExpand(src)}
        >
          <img
            src={src}
            alt={attachment.caption ?? attachment.name ?? 'Attachment'}
            className="max-h-72 max-w-full object-contain"
            onLoad={onImageLoad}
          />
        </button>
        {attachment.caption && (
          <figcaption className="text-xs italic text-text-secondary">{attachment.caption}</figcaption>
        )}
      </figure>
    );
  }

  // type === 'content_ref'
  if (!sessionId) {
    // No sessionId in scope means we can't fetch — render placeholder only
    return <RefImagePlaceholder ref_={attachment} />;
  }
  return <RefImageTile ref_={attachment} sessionId={sessionId} onExpand={onExpand} />;
}

function RefImagePlaceholder({ ref_ }: { ref_: Attachment & { type: 'content_ref' } }) {
  return (
    <figure className="m-0 flex flex-col items-start gap-1">
      <div
        className="flex flex-col items-center justify-center rounded-lg border border-border-primary/20 bg-surface-secondary/50 text-text-secondary"
        style={{
          width: ref_.width ? Math.min(ref_.width, 320) : 320,
          height: ref_.height ? Math.min(ref_.height, 180) : 180,
        }}
      >
        <div className="text-xs">🖼 {ref_.name ?? 'image'}</div>
        <div className="text-[10px] opacity-60">{formatBytes(ref_.size)}</div>
      </div>
      {ref_.caption && <figcaption className="text-xs italic text-text-secondary">{ref_.caption}</figcaption>}
    </figure>
  );
}

function RefImageTile({
  ref_,
  sessionId,
  onExpand,
}: {
  ref_: Attachment & { type: 'content_ref' };
  sessionId: string;
  onExpand: (url: string) => void;
}) {
  const { status, url, error } = useAttachment(ref_, sessionId, ATTACHMENT_PULL);

  const placeholderStyle: React.CSSProperties = {
    width: ref_.width ? Math.min(ref_.width, 320) : 320,
    height: ref_.height ? Math.min(ref_.height, 180) : 180,
  };

  if (status === 'ready' && url) {
    return (
      <figure className="m-0 flex flex-col items-start gap-1">
        <button
          type="button"
          className="overflow-hidden rounded-lg border border-border-primary/20"
          onClick={() => onExpand(url)}
        >
          <img
            src={url}
            alt={ref_.caption ?? ref_.name ?? 'Attachment'}
            className="max-h-72 max-w-full object-contain"
            onLoad={onImageLoad}
          />
        </button>
        {ref_.caption && <figcaption className="text-xs italic text-text-secondary">{ref_.caption}</figcaption>}
      </figure>
    );
  }
  if (status === 'error') {
    return (
      <figure className="m-0 flex flex-col items-start gap-1">
        <div
          className="flex flex-col items-center justify-center rounded-lg border border-red-500/40 bg-red-500/10 text-text-secondary"
          style={placeholderStyle}
        >
          <div className="text-xs">⚠ Couldn't load image</div>
          <div className="text-[10px] opacity-60">{ref_.name ?? 'image'}</div>
          {error && <div className="text-[10px] opacity-60">{error}</div>}
        </div>
        {ref_.caption && <figcaption className="text-xs italic text-text-secondary">{ref_.caption}</figcaption>}
      </figure>
    );
  }
  // loading
  return (
    <figure className="m-0 flex flex-col items-start gap-1">
      <div
        className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border-primary/20 bg-surface-secondary/50 text-text-secondary"
        style={placeholderStyle}
      >
        <span
          className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-text-secondary/40 border-t-text-secondary"
          aria-label="Loading"
        />
        <div className="text-[10px] opacity-60">{ref_.name ?? 'image'} · {formatBytes(ref_.size)}</div>
      </div>
      {ref_.caption && <figcaption className="text-xs italic text-text-secondary">{ref_.caption}</figcaption>}
    </figure>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
