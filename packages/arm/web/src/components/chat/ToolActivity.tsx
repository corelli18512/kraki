import { useState } from 'react';
import { Loader2, CheckCircle2 } from 'lucide-react';

interface ToolActivityProps {
  type: 'start' | 'complete';
  toolName: string;
  args: Record<string, unknown> | object;
  result?: string;
}

export function ToolActivity({ type, toolName, args, result }: ToolActivityProps) {
  const [expanded, setExpanded] = useState(false);
  const isStart = type === 'start';

  const summary = getToolSummary(toolName, args as Record<string, unknown>);
  const resultPreview = result ? getResultPreview(result) : '';

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

      {expanded && (
        <div className="ml-7 mt-1 space-y-2 rounded-lg bg-surface-tertiary p-3 text-xs">
          {summary && (
            <div>
              <p className="font-semibold text-text-muted">Command</p>
              <pre className="mt-1 overflow-x-auto font-mono text-text-secondary">
                {summary}
              </pre>
            </div>
          )}
          {!summary && Object.keys(args).length > 0 && (
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

function getToolSummary(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'shell':
    case 'bash':
      return typeof args.command === 'string' ? `$ ${args.command}` : '';
    case 'write_file':
    case 'edit_file':
    case 'edit':
    case 'create_file':
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
