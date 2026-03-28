import { useState, lazy, Suspense } from 'react';
import { Loader2, CheckCircle2, FileText, FileEdit, Terminal, Search, FolderSearch } from 'lucide-react';

const ReactDiffViewer = lazy(() => import('react-diff-viewer-continued'));

interface ToolActivityProps {
  type: 'start' | 'complete';
  toolName: string;
  args: Record<string, unknown> | object;
  result?: string;
  forceExpanded?: boolean;
}

export function ToolActivity({ type, toolName, args, result, forceExpanded }: ToolActivityProps) {
  const [expanded, setExpanded] = useState(false);
  const isExpanded = forceExpanded ?? expanded;
  const isStart = type === 'start';

  const summary = getToolSummary(toolName, args as Record<string, unknown>);
  const resultPreview = result ? getResultPreview(result) : '';
  const ToolIcon = getToolIcon(toolName);
  const detailLabel = getDetailLabel(toolName);
  const argsDetail = getArgsDetail(toolName, args as Record<string, unknown>);

  const editDiff = getEditDiff(toolName, args as Record<string, unknown>);
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="group flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-all hover:bg-surface-tertiary active:scale-[0.98]"
      >
        {isStart
          ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-text-muted" />
          : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        }
        <span className="shrink-0 text-xs font-medium text-text-secondary">
          {isStart ? 'Running' : 'Completed'}{' '}
          <span className="font-mono text-ocean-600 dark:text-ocean-400">{toolName}</span>
        </span>
        {summary && (
          <span className="truncate font-mono text-[11px] text-text-muted">{summary}</span>
        )}
        {!isStart && resultPreview && !summary && (
          <span className="truncate text-[11px] text-text-muted">{resultPreview}</span>
        )}
        <svg
          className={`ml-1 h-3 w-3 shrink-0 text-text-muted transition-transform ${
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
        <div className="ml-7 mt-1 space-y-2 rounded-lg bg-surface-tertiary p-3 text-xs">
          {summary && (
            <div>
              <p className="font-semibold text-text-muted">{detailLabel}</p>
              <pre className="mt-1 overflow-x-auto font-mono text-text-secondary">
                {summary}
              </pre>
            </div>
          )}
          {argsDetail && !editDiff && (
            <div>
              <p className="font-semibold text-text-muted">{argsDetail.label}</p>
              <pre className="mt-1 max-h-40 overflow-auto text-text-secondary whitespace-pre-wrap font-mono">
                {argsDetail.content}
              </pre>
            </div>
          )}
          {editDiff && (
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
          )}
          {!summary && !argsDetail && Object.keys(args).length > 0 && (
            <div>
              <p className="font-semibold text-text-muted">Arguments</p>
              <pre className="mt-1 overflow-x-auto text-text-secondary">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {result && (
            <div>
              <p className="font-semibold text-text-muted">Result</p>
              <pre className="mt-1 max-h-60 overflow-auto text-text-secondary whitespace-pre-wrap">
                {result}
              </pre>
            </div>
          )}
        </div>
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

/** Extract old/new strings for diff view from edit tool args. */
function getEditDiff(toolName: string, args: Record<string, unknown>): { oldStr: string; newStr: string } | null {
  if (toolName !== 'edit' && toolName !== 'edit_file') return null;
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
    default:
      return null;
  }
}

function getToolSummary(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'shell':
    case 'bash':
      return typeof args.command === 'string' ? `$ ${args.command}` : '';
    case 'write_file':
    case 'edit_file':
    case 'edit':
    case 'create_file':
    case 'create':
      return typeof args.path === 'string' ? args.path : '';
    case 'read_file':
    case 'view':
      return typeof args.path === 'string' ? args.path : '';
    case 'fetch_url':
      return typeof args.url === 'string' ? args.url : '';
    case 'mcp':
      return typeof args.tool === 'string' ? `${args.server}/${args.tool}` : '';
    case 'grep':
    case 'search':
      return typeof args.pattern === 'string' ? `/${args.pattern}/` : '';
    case 'glob':
      return typeof args.pattern === 'string' ? args.pattern : '';
    default:
      // Try to show the first string arg as preview
      for (const v of Object.values(args)) {
        if (typeof v === 'string' && v.length > 0 && v.length < 120) return v;
      }
      return '';
  }
}

function getResultPreview(result: string): string {
  const trimmed = result.trim();
  if (!trimmed) return '';
  // First non-empty line, truncated
  const firstLine = trimmed.split('\n')[0].trim();
  if (firstLine.length > 80) return firstLine.slice(0, 77) + '…';
  return firstLine;
}
