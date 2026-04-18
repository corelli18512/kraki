import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';
import { sessionTime } from '../../lib/format';
import type { LocalSession } from '@kraki/protocol';
import { Download, Search, ChevronRight, ChevronDown, Loader2, Check, Plus, FolderGit2, Folder, Home, Monitor } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface SessionGroup {
  label: string;
  path: string;
  repository?: string;
  branches: string[];
  sessions: LocalSession[];
  liveCount: number;
}

function groupLabel(path: string): string {
  if (path === '/' || path === '') return 'System';
  const home = '~';
  if (path === home || path === '/Users' || path.match(/^\/Users\/[^/]+$/)) return 'Home';
  // Extract last path component
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function groupIcon(path: string, hasGit: boolean) {
  if (path === '/' || path === '') return <Monitor className="h-4 w-4 text-text-muted" />;
  const home = '~';
  if (path === home || path.match(/^\/Users\/[^/]+$/)) return <Home className="h-4 w-4 text-text-muted" />;
  if (hasGit) return <FolderGit2 className="h-4 w-4 text-text-muted" />;
  return <Folder className="h-4 w-4 text-text-muted" />;
}

function buildGroups(sessions: LocalSession[]): SessionGroup[] {
  const map = new Map<string, LocalSession[]>();
  for (const s of sessions) {
    const key = s.gitRoot ?? s.cwd;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }

  const groups: SessionGroup[] = [];
  for (const [path, items] of map) {
    const branches = [...new Set(items.map(s => s.branch).filter(Boolean) as string[])].sort();
    const repo = items.find(s => s.repository)?.repository;
    const liveCount = items.filter(s => s.isLive).length;
    // Sort: live first, then by modifiedTime desc
    items.sort((a, b) => {
      if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
      return b.modifiedTime.localeCompare(a.modifiedTime);
    });
    groups.push({
      label: '', // filled below after dedup
      path,
      repository: repo,
      branches,
      sessions: items,
      liveCount,
    });
  }

  // Disambiguate labels: use repo short name, then last path component,
  // and add parent dir if there are collisions
  const labelCounts = new Map<string, number>();
  for (const g of groups) {
    const base = g.repository ? g.repository.split('/').pop()! : groupLabel(g.path);
    g.label = base;
    labelCounts.set(base, (labelCounts.get(base) ?? 0) + 1);
  }
  for (const g of groups) {
    if ((labelCounts.get(g.label) ?? 0) > 1) {
      // Disambiguate with branch info or path suffix
      const branchHint = g.branches.length === 1 ? g.branches[0] : '';
      const pathSuffix = g.path.replace(/^.*\/Repos\//, '').replace(/^.*\/Documents\//, '');
      if (branchHint && branchHint !== 'main') {
        g.label = `${g.label} (${branchHint})`;
      } else if (pathSuffix !== g.label && pathSuffix.length > 0) {
        g.label = pathSuffix;
      }
    }
  }

  // Sort groups: most recent activity first
  groups.sort((a, b) => {
    const aTime = a.sessions[0]?.modifiedTime ?? '';
    const bTime = b.sessions[0]?.modifiedTime ?? '';
    return bTime.localeCompare(aTime);
  });

  return groups;
}

const INITIAL_SHOW = 5;

function GroupSection({ group, importingIds, onImport }: {
  group: SessionGroup;
  importingIds: Set<string>;
  onImport: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const hasGit = group.sessions.some(s => s.gitRoot);
  const visible = expanded ? (showAll ? group.sessions : group.sessions.slice(0, INITIAL_SHOW)) : [];
  const hasMore = expanded && !showAll && group.sessions.length > INITIAL_SHOW;

  return (
    <div className="mb-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-tertiary"
      >
        {expanded
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        }
        {groupIcon(group.path, hasGit)}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
          {group.label}
        </span>
        {group.liveCount > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-emerald-500">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {group.liveCount}
          </span>
        )}
        <span className="text-[11px] text-text-muted">{group.sessions.length}</span>
      </button>

      {expanded && group.repository && (
        <div className="ml-9 mb-1 text-[10px] text-text-muted truncate">{group.repository}</div>
      )}

      {visible.map(session => (
        <SessionRow
          key={session.sessionId}
          session={session}
          importing={importingIds.has(session.sessionId)}
          onImport={() => onImport(session.sessionId)}
        />
      ))}

      {hasMore && (
        <button
          onClick={() => setShowAll(true)}
          className="ml-9 mt-0.5 text-[11px] text-kraki-500 hover:text-kraki-400 transition-colors"
        >
          Show {group.sessions.length - INITIAL_SHOW} more…
        </button>
      )}
    </div>
  );
}

function SessionRow({ session, importing, onImport }: {
  session: LocalSession;
  importing: boolean;
  onImport: () => void;
}) {
  const isLinked = !!session.linkedKrakiSessionId;

  return (
    <div className="ml-5 flex items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-surface-secondary transition-colors">
      <span className={`h-2 w-2 shrink-0 rounded-full ${session.isLive ? 'bg-emerald-400' : 'bg-slate-400/40'}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate text-xs text-text-primary">
            {session.summary ?? session.sessionId.slice(0, 12)}
          </span>
          {session.branch && (
            <span className="shrink-0 rounded-full bg-surface-tertiary px-1.5 py-0.5 text-[9px] text-text-muted">
              {session.branch}
            </span>
          )}
        </div>
        <span className="text-[10px] text-text-muted">
          {session.modifiedTime ? sessionTime(session.modifiedTime) : ''}
          {session.model && ` · ${session.model}`}
        </span>
      </div>
      {isLinked ? (
        <Check className="h-4 w-4 shrink-0 text-emerald-500" />
      ) : importing ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-kraki-500" />
      ) : (
        <button
          onClick={onImport}
          title="Import session"
          className="shrink-0 rounded-md p-1 text-text-muted transition-colors hover:bg-surface-tertiary hover:text-kraki-500"
        >
          <Plus className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export function ImportSessionDialog({ open, onClose }: Props) {
  const localSessions = useStore(s => s.localSessions);
  const loading = useStore(s => s.localSessionsLoading);
  const devices = useStore(s => s.devices);
  const [search, setSearch] = useState('');
  const [importingIds, setImportingIds] = useState<Set<string>>(new Set());

  // Pick the first online tentacle as the target device
  const tentacle = useMemo(() => {
    for (const [, d] of devices) {
      if (d.role === 'tentacle' && d.online) return d;
    }
    return undefined;
  }, [devices]);

  // Request sessions when dialog opens
  useEffect(() => {
    if (open && tentacle) {
      wsClient.requestLocalSessions(tentacle.id);
      setSearch('');
      setImportingIds(new Set());
    }
  }, [open, tentacle?.id]);

  // Client-side search filter
  const filtered = useMemo(() => {
    if (!search) return localSessions;
    const q = search.toLowerCase();
    return localSessions.filter(s => {
      const haystack = [s.cwd, s.gitRoot, s.repository, s.branch, s.summary, s.sessionId]
        .filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [localSessions, search]);

  const groups = useMemo(() => buildGroups(filtered), [filtered]);
  const totalCount = localSessions.length;

  const handleImport = useCallback((sessionId: string) => {
    if (!tentacle) return;
    setImportingIds(prev => new Set(prev).add(sessionId));
    wsClient.importSession(sessionId, tentacle.id);
  }, [tentacle?.id]);

  // Mark as linked when session appears in main sessions list
  const sessions = useStore(s => s.sessions);
  useEffect(() => {
    if (importingIds.size === 0) return;
    const next = new Set(importingIds);
    let changed = false;
    for (const id of importingIds) {
      if (sessions.has(id)) {
        next.delete(id);
        changed = true;
      }
    }
    if (changed) setImportingIds(next);
  }, [sessions, importingIds]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm md:items-center"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
    >
      <div
        className="flex max-h-[85dvh] w-full flex-col rounded-t-2xl border border-border-primary bg-surface-primary shadow-2xl md:mx-4 md:max-w-lg md:rounded-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border-primary px-4 py-3">
          <div className="flex items-center gap-2">
            <Download className="h-4 w-4 text-kraki-500" />
            <h2 className="text-base font-semibold text-text-primary">Import Session</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-tertiary hover:text-text-primary"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="shrink-0 border-b border-border-primary px-4 py-2">
          <div className="flex items-center gap-2 rounded-lg bg-surface-secondary px-3 py-1.5">
            <Search className="h-4 w-4 shrink-0 text-text-muted" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search sessions…"
              className="min-w-0 flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted outline-none"
              autoFocus
            />
            {search && (
              <button onClick={() => setSearch('')} className="text-text-muted hover:text-text-primary">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-kraki-500" />
              <p className="mt-2 text-sm text-text-muted">Scanning local sessions…</p>
            </div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <p className="text-sm text-text-secondary">
                {search ? 'No sessions match your search' : 'No local sessions found'}
              </p>
              <p className="mt-1 text-xs text-text-muted">
                {search ? 'Try a different search term' : 'Run copilot in your terminal to create sessions'}
              </p>
            </div>
          ) : (
            groups.map(group => (
              <GroupSection
                key={group.path}
                group={group}
                importingIds={importingIds}
                onImport={handleImport}
              />
            ))
          )}
        </div>

        {/* Footer */}
        {!loading && totalCount > 0 && (
          <div className="shrink-0 border-t border-border-primary px-4 py-2 text-center text-[11px] text-text-muted">
            {search && filtered.length !== totalCount
              ? `${filtered.length} of ${totalCount} local sessions`
              : `${totalCount} local sessions`}
          </div>
        )}
      </div>
    </div>
  );
}
