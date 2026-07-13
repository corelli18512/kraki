import { useState, lazy, Suspense } from 'react';
import { Loader2, CheckCircle2, XCircle, CircleSlash, FileText, FileEdit, Terminal, Search, FolderSearch } from 'lucide-react';
import type { ContentRef } from '@kraki/protocol';

import { useAttachmentText } from '../../hooks/useAttachment';

const ReactDiffViewer = lazy(() => import('react-diff-viewer-continued'));

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
  /** Fired with a sessionId/id when the cache misses and we need to pull. */
  requestPull: (sessionId: string, id: string) => void;
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
        className="group flex w-full items-center gap-1 rounded-lg py-1.5 text-left transition-all hover:bg-surface-tertiary active:scale-[0.98]"
      >
        {isStart
          ? (cancelled
            ? <CircleSlash className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            : <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-text-muted" />)
          : termination
            ? <CircleSlash className={`h-3.5 w-3.5 shrink-0 ${termination === 'cancelled' ? 'text-amber-500' : 'text-red-500'}`} />
            : (success === false
              ? <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
              : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />)
        }
        <ToolIcon className="h-3.5 w-3.5 shrink-0 text-text-muted opacity-0" aria-hidden="true" />
        <span className="shrink-0 text-xs font-medium text-text-secondary">
          {isStart ? 'Running ' : termination === 'cancelled' ? 'Cancelled ' : termination === 'interrupted' ? 'Interrupted ' : ''}
          <span className="font-mono text-ocean-600 dark:text-ocean-400">{toolName}</span>
        </span>
        {headline && (
          <span className="truncate font-mono text-[11px] text-text-muted">{headline}</span>
        )}
        <svg
          className={`h-3 w-3 shrink-0 text-text-muted transition-transform ${
            expanded ? 'rotate-180' : ''
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
        <div className="mt-1 space-y-2 rounded-lg bg-surface-tertiary p-3 text-xs">
          {argsRef && (
            <ToolArgsBody
              toolName={toolName}
              argsRef={argsRef}
              sessionId={sessionId}
              requestPull={requestPull}
              headline={headline}
            />
          )}
          {!argsRef && headline && (
            <div>
              <p className="font-semibold text-text-muted">{getDetailLabel(toolName)}</p>
              <pre className="mt-1 overflow-x-auto font-mono text-text-secondary whitespace-pre-wrap">
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
 *  then renders the full args. Special-cases edit/create file dumps to
 *  show a diff/preview instead of raw JSON. */
function ToolArgsBody({
  toolName, argsRef, sessionId, requestPull, headline,
}: {
  toolName: string;
  argsRef: ContentRef;
  sessionId: string;
  requestPull: (sessionId: string, id: string) => void;
  headline: string;
}) {
  const { status, text, error } = useAttachmentText(argsRef, sessionId, requestPull, true);

  if (status === 'loading') {
    return (
      <div>
        <p className="font-semibold text-text-muted">{getDetailLabel(toolName)}</p>
        <pre className="mt-1 overflow-x-auto font-mono text-text-secondary whitespace-pre-wrap">
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
        <pre className="mt-1 max-h-60 overflow-auto text-text-secondary whitespace-pre-wrap font-mono">
          {text}
        </pre>
      </div>
    );
  }
  return <ToolArgsRendered toolName={toolName} args={args} />;
}

function ToolArgsRendered({ toolName, args }: { toolName: string; args: Record<string, unknown> }) {
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const editDiff = getEditDiff(toolName, args);
  const argsDetail = getArgsDetail(toolName, args);

  if (editDiff) {
    return (
      <div className="overflow-hidden rounded text-[11px]">
        <Suspense fallback={<pre className="p-2 text-text-muted">Loading diff…</pre>}>
          <ReactDiffViewer
            oldValue={editDiff.oldStr}
            newValue={editDiff.newStr}
            splitView={false}
            hideLineNumbers={false}
            useDarkTheme={isDark}
            styles={{
              contentText: { fontSize: '11px', lineHeight: '1.5' },
            }}
          />
        </Suspense>
      </div>
    );
  }
  if (argsDetail) {
    return (
      <div>
        <p className="font-semibold text-text-muted">{argsDetail.label}</p>
        <pre className="mt-1 max-h-60 overflow-auto text-text-secondary whitespace-pre-wrap font-mono">
          {argsDetail.content}
        </pre>
      </div>
    );
  }
  // Fallback: pretty JSON.
  return (
    <div>
      <p className="font-semibold text-text-muted">Arguments</p>
      <pre className="mt-1 max-h-60 overflow-auto text-text-secondary whitespace-pre-wrap font-mono">
        {JSON.stringify(args, null, 2)}
      </pre>
    </div>
  );
}

function ToolResultBody({
  resultRef, sessionId, requestPull,
}: {
  resultRef: ContentRef;
  sessionId: string;
  requestPull: (sessionId: string, id: string) => void;
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
        <pre className="mt-1 max-h-60 overflow-auto text-text-secondary whitespace-pre-wrap">
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

function getDetailLabel(toolName: string): string {
  switch (toolName) {
    case 'shell':
    case 'bash':
      return 'Command';
    case 'read_file':
    case 'view':
    case 'write_file':
    case 'edit_file':
    case 'edit':
    case 'create_file':
    case 'create':
      return 'Path';
    case 'grep':
    case 'search':
      return 'Pattern';
    case 'glob':
      return 'Pattern';
    case 'fetch_url':
      return 'URL';
    default:
      return 'Summary';
  }
}

/** Extract old/new strings for diff view from any tool with old_str/new_str args. */
function getEditDiff(_toolName: string, args: Record<string, unknown>): { oldStr: string; newStr: string } | null {
  const oldStr = typeof args.old_str === 'string' ? args.old_str : '';
  const newStr = typeof args.new_str === 'string' ? args.new_str : '';
  if (!oldStr && !newStr) return null;
  return { oldStr, newStr };
}

/** Extract additional detail args to display beyond the summary. */
function getArgsDetail(toolName: string, args: Record<string, unknown>): { label: string; content: string } | null {
  switch (toolName) {
    case 'edit':
    case 'edit_file': {
      const old_str = typeof args.old_str === 'string' ? args.old_str : undefined;
      const new_str = typeof args.new_str === 'string' ? args.new_str : undefined;
      if (old_str != null || new_str != null) {
        const parts: string[] = [];
        if (old_str != null) parts.push(`- ${old_str}`);
        if (new_str != null) parts.push(`+ ${new_str}`);
        return { label: 'Changes', content: parts.join('\n') };
      }
      return null;
    }
    case 'write_file':
    case 'create_file':
    case 'create': {
      const content = typeof args.file_text === 'string' ? args.file_text
        : typeof args.content === 'string' ? args.content
        : undefined;
      if (content) {
        const preview = content.length > 500 ? content.slice(0, 497) + '…' : content;
        return { label: 'Content', content: preview };
      }
      return null;
    }
    case 'grep':
    case 'search': {
      const path = typeof args.path === 'string' ? args.path : undefined;
      if (path) return { label: 'Directory', content: path };
      return null;
    }
    case 'shell':
    case 'bash': {
      const command = typeof args.command === 'string' ? args.command : undefined;
      if (command) return { label: 'Command', content: `$ ${command}` };
      return null;
    }
    case 'view':
    case 'read_file': {
      const path = typeof args.path === 'string' ? args.path : undefined;
      if (path) return { label: 'Path', content: path };
      return null;
    }
    default:
      return null;
  }
}
