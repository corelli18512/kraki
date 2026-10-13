import { useState } from 'react';
import {
  Loader2, CheckCircle2, XCircle, CircleMinus, BookText, ChevronsLeftRightEllipsis,
  SquareTerminal, SearchCode, FileSearch, Link, SquareMousePointer, Server, Wrench,
} from 'lucide-react';
import type { ContentRef } from '@kraki/protocol';
import { useAttachmentText } from '../../hooks/useAttachment';

interface ToolActivityProps {
  type: 'start' | 'complete';
  toolName: string;
  headline: string;
  args?: Record<string, unknown>;
  argsRef?: ContentRef;
  resultRef?: ContentRef;
  sessionId: string;
  requestPull: (sessionId: string, ref: ContentRef) => void;
  success?: boolean;
  termination?: 'cancelled' | 'interrupted';
  cancelled?: boolean;
  forceExpanded?: boolean;
}

/** MacToolActivityRow: a tool glyph with a tiny lifecycle badge and a gray name pill. */
export function ToolActivity({
  type, toolName, headline, args, argsRef, resultRef, sessionId, requestPull,
  success, termination, cancelled, forceExpanded,
}: ToolActivityProps) {
  const [expanded, setExpanded] = useState(false);
  const isExpanded = forceExpanded ?? expanded;
  const running = type === 'start' && !cancelled;
  const stopped = cancelled || termination === 'cancelled';
  const failed = success === false || termination === 'interrupted';
  const displayHeadline = toolHeadline(toolName, headline, args);
  const ToolIcon = getToolIcon(toolName);
  const Badge = running ? Loader2 : stopped ? CircleMinus : failed ? XCircle : CheckCircle2;
  const expandable = !!argsRef || !!resultRef || !!(args && Object.keys(args).length);
  return (
    <div className="ktool">
      <button type="button" className="ktool-head" disabled={!expandable}
        aria-label={`${running ? 'Running ' : stopped ? 'Stopped ' : ''}${toolName}${displayHeadline ? ` ${displayHeadline}` : ''}`}
        aria-expanded={expandable ? isExpanded : undefined} onClick={() => setExpanded(!expanded)}>
        <span className="ktool-icon">
          <ToolIcon aria-hidden />
          <Badge aria-hidden className={`ktool-badge ${running ? 'is-running' : stopped ? 'is-stopped' : failed ? 'is-failed' : 'is-done'}`} />
        </span>
        <span className="ktool-name">{toolName}</span>
        {displayHeadline && <span className="ktool-headline">{displayHeadline.replace(/\s+/g, ' ')}</span>}
        {expandable && <svg aria-hidden className={`ktool-chevron ${isExpanded ? 'is-expanded' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="m9 5 7 7-7 7" /></svg>}
      </button>
      {isExpanded && expandable && (
        <div className="ktool-detail">
          {argsRef ? <LazySection title="Arguments" refValue={argsRef} sessionId={sessionId} requestPull={requestPull} argumentsBody />
            : args && <section><h4>Arguments</h4><pre>{formatToolArguments(args)}</pre></section>}
          {resultRef && <LazySection title="Result" refValue={resultRef} sessionId={sessionId} requestPull={requestPull} />}
        </div>
      )}
    </div>
  );
}

/** MacToolActivityRow derives missing headlines only from inline arguments. */
export function toolHeadline(toolName: string, headline: string, args?: Record<string, unknown>): string {
  if (headline || !args) return headline;
  const string = (key: string): string | undefined => typeof args[key] === 'string' ? args[key] as string : undefined;
  switch (toolName.toLowerCase()) {
    case 'shell': case 'bash': {
      const command = string('command');
      return command === undefined ? '' : `$ ${command}`;
    }
    case 'read_file': case 'view': case 'read': case 'write_file': case 'edit_file':
    case 'edit': case 'create_file': case 'create': case 'write':
      return string('path') ?? '';
    case 'fetch_url': return string('url') ?? '';
    case 'grep': case 'search': {
      const pattern = string('pattern');
      return pattern === undefined ? '' : `/${pattern}/`;
    }
    case 'glob': return string('pattern') ?? '';
    default: {
      const preferred = ['query', 'path', 'file', 'url', 'name', 'id', 'key'];
      for (const key of [...preferred, ...Object.keys(args).sort()]) {
        const value = string(key);
        if (value && [...value].length < 120) return value;
      }
      return '';
    }
  }
}

/** Preserve every argument, including timeout and edit text; native has no rich-diff view. */
export function formatToolArguments(args: Record<string, unknown>): string {
  return Object.keys(args).sort().map((key) => {
    const value = args[key];
    return `${key}: ${typeof value === 'string' ? value : JSON.stringify(sortKeys(value) ?? null)}`;
  }).join('\n');
}

/** Nested object keys sorted, matching Mac's JSONSerialization `.sortedKeys`. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  }
  return value;
}

function LazySection({ title, refValue, sessionId, requestPull, argumentsBody }: {
  title: string; refValue: ContentRef; sessionId: string;
  requestPull: (sessionId: string, ref: ContentRef) => void; argumentsBody?: boolean;
}) {
  const { status, text, error } = useAttachmentText(refValue, sessionId, requestPull, true);
  let body = text;
  if (argumentsBody && text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = formatToolArguments(parsed as Record<string, unknown>);
    } catch { /* Non-JSON trace arguments are already formatted text. */ }
  }
  return (
    <section>
      <h4>{title}</h4>
      {status === 'loading' && <p className="ktool-loading"><span className="kspinner" />Loading…</p>}
      {status === 'error' && <p className="kstep-bad">Couldn't load: {error}</p>}
      {status === 'ready' && <pre className={!argumentsBody && body?.endsWith('\n') ? 'ktool-final-line' : undefined}>{body}</pre>}
    </section>
  );
}

function getToolIcon(toolName: string): typeof Wrench {
  const lower = toolName.toLowerCase();
  if (lower.startsWith('mcp__') || lower.startsWith('mcp-') || lower === 'mcp') {
    if (lower.includes('search')) return SearchCode;
    if (lower.includes('fetch') || lower.includes('get')) return Link;
    if (['browser', 'click', 'playwright'].some((part) => lower.includes(part))) return SquareMousePointer;
    return Server;
  }
  if (lower.includes('playwright') || lower.includes('browser_')) return SquareMousePointer;
  if (['shell', 'bash', 'run', 'command'].includes(lower)) return SquareTerminal;
  if (['read_file', 'read', 'view', 'view_file', 'open', 'cat'].includes(lower)) return BookText;
  if (['write_file', 'write', 'create_file', 'create', 'new_file', 'edit_file', 'edit', 'patch', 'str_replace_editor'].includes(lower)) return ChevronsLeftRightEllipsis;
  if (['grep', 'search', 'search_code', 'search_files', 'ripgrep', 'rg'].includes(lower)) return SearchCode;
  if (['glob', 'list_files', 'find'].includes(lower)) return FileSearch;
  if (['fetch_url', 'webfetch', 'web_fetch', 'fetch', 'websearch', 'web_search'].includes(lower)) return Link;
  return Wrench;
}
