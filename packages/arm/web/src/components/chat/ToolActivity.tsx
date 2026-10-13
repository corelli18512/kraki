import { useState } from 'react';
import { Loader2, CheckCircle2, XCircle, CircleSlash, FileText, FileEdit, Terminal, Search, FolderSearch } from 'lucide-react';
import type { ContentRef } from '@kraki/protocol';

import { useAttachmentText } from '../../hooks/useAttachment';

interface ToolActivityProps {
  type: 'start' | 'complete';
  toolName: string;
  /** Short user-facing preview composed by the tentacle. Always shown on
   *  the chip header. Replaced by full args text in the expand body once
   *  the argsRef resolves. */
  headline: string;
  /** Lazy ref to the full args JSON. */
  argsRef?: ContentRef;
  /** Lazy ref to the full result body (complete events only). */
  resultRef?: ContentRef;
  sessionId: string;
  /** Fired with a sessionId/ref when the cache misses and we need to pull. */
  requestPull: (sessionId: string, ref: ContentRef) => void;
  success?: boolean;
  termination?: 'cancelled' | 'interrupted';
  cancelled?: boolean;
  forceExpanded?: boolean;
}

export function ToolActivity({
  type, toolName, headline, argsRef, resultRef,
  sessionId, requestPull,
  success, termination, cancelled, forceExpanded,
}: ToolActivityProps) {
  const [expanded, setExpanded] = useState(false);
  const isExpanded = forceExpanded ?? expanded;
  const isStart = type === 'start';

  const ToolIcon = getToolIcon(toolName);

  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="group flex w-full items-center gap-1.5 rounded-lg py-1.5 text-left transition-all hover:bg-surface-tertiary active:scale-[0.98]"
      >
        <span className="relative mr-1 size-4 shrink-0 text-text-secondary">
          <ToolIcon className="size-4" aria-hidden="true" />
          {isStart && !cancelled
            ? <Loader2 aria-label="Running" className="absolute -right-2 bottom-0 size-2 animate-spin text-text-muted" />
            : termination || cancelled
              ? <CircleSlash className="absolute -right-[5px] bottom-px size-2 text-amber-500" />
              : success === false
                ? <XCircle className="absolute -right-[5px] bottom-px size-2 text-red-500" />
                : <CheckCircle2 className="absolute -right-[5px] bottom-px size-2 text-green-500" />}
        </span>
        <span className="shrink-0 rounded bg-surface-tertiary px-[5px] py-px font-mono text-xs text-text-secondary">{toolName}</span>
        {headline && (
          <span className="truncate text-xs text-text-secondary">{headline}</span>
        )}
        <svg
          className={`h-3 w-3 shrink-0 text-text-muted transition-transform ${
            isExpanded ? '' : '-rotate-90'
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isExpanded && (
        <div className="ktool-detail mt-1 space-y-2 rounded-lg p-3 text-[11px]">
          {argsRef && (
            <ToolArgsBody
              argsRef={argsRef}
              sessionId={sessionId}
              requestPull={requestPull}
              headline={headline}
            />
          )}
          {!argsRef && headline && (
            <div>
              <p className="font-semibold text-text-muted">Arguments</p>
              <pre className="mt-0.5 overflow-x-auto font-mono text-text-secondary whitespace-pre-wrap">
                {headline}
              </pre>
            </div>
          )}
          {resultRef && (
            <ToolResultBody
              resultRef={resultRef}
              sessionId={sessionId}
              requestPull={requestPull}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Lazy body for the args section. Shows a placeholder while fetching,
 *  then renders all argument keys as monospaced text. */
function ToolArgsBody({
  argsRef, sessionId, requestPull, headline,
}: {
  argsRef: ContentRef;
  sessionId: string;
  requestPull: (sessionId: string, ref: ContentRef) => void;
  headline: string;
}) {
  const { status, text, error } = useAttachmentText(argsRef, sessionId, requestPull, true);

  if (status === 'loading') {
    return (
      <div>
        <p className="font-semibold text-text-muted">Arguments</p>
        <pre className="mt-0.5 overflow-x-auto font-mono text-text-secondary whitespace-pre-wrap">
          {headline}
        </pre>
        <p className="mt-1 flex items-center gap-1.5 text-[10px] text-text-muted">
          <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-text-muted/40 border-t-text-muted/90" />
          Loading full arguments…
        </p>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div>
        <p className="font-semibold text-red-500">Arguments unavailable</p>
        <p className="mt-1 text-[10px] text-text-muted">{error}</p>
      </div>
    );
  }
  // ready
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(text ?? '{}') as Record<string, unknown>;
  } catch {
    return (
      <div>
        <p className="font-semibold text-text-muted">Arguments</p>
        <pre className="mt-0.5 max-h-60 overflow-auto text-text-secondary whitespace-pre-wrap font-mono">
          {text}
        </pre>
      </div>
    );
  }
  return <ToolArgsRendered args={args} />;
}

export function formatToolArguments(args: Record<string, unknown>): string {
  return Object.keys(args).sort().map((key) => `${key}: ${typeof args[key] === 'string' ? args[key] : JSON.stringify(args[key])}`).join('\n');
}

function ToolArgsRendered({ args }: { args: Record<string, unknown> }) {
  return (
    <div>
      <p className="font-semibold text-text-secondary">Arguments</p>
      <pre className="mt-0.5 max-h-60 overflow-auto text-text-secondary whitespace-pre-wrap font-mono">
        {formatToolArguments(args)}
      </pre>
    </div>
  );
}

function ToolResultBody({
  resultRef, sessionId, requestPull,
}: {
  resultRef: ContentRef;
  sessionId: string;
  requestPull: (sessionId: string, ref: ContentRef) => void;
}) {
  const { status, text, error } = useAttachmentText(resultRef, sessionId, requestPull, true);
  return (
    <div>
      <p className="font-semibold text-text-muted">Result</p>
      {status === 'loading' && (
        <p className="mt-1 flex items-center gap-1.5 text-[10px] text-text-muted">
          <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-text-muted/40 border-t-text-muted/90" />
          Loading result…
        </p>
      )}
      {status === 'error' && (
        <p className="mt-1 text-[10px] text-red-500">Failed to load result: {error}</p>
      )}
      {status === 'ready' && (
        <pre className="mt-0.5 max-h-60 overflow-auto font-mono text-text-secondary whitespace-pre-wrap">
          {text}
        </pre>
      )}
    </div>
  );
}

function getToolIcon(toolName: string): typeof FileText {
  switch (toolName) {
    case 'read_file':
    case 'view':
      return FileText;
    case 'write_file':
    case 'edit_file':
    case 'edit':
    case 'create_file':
    case 'create':
      return FileEdit;
    case 'shell':
    case 'bash':
      return Terminal;
    case 'grep':
    case 'search':
      return Search;
    case 'glob':
      return FolderSearch;
    default:
      return FileText;
  }
}

