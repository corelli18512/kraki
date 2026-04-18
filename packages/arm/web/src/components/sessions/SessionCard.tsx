import { useNavigate, useParams } from 'react-router';
import { useState, useCallback } from 'react';
import type { SessionSummary } from '@kraki/protocol';
import { agentInfo, truncate, sessionTime } from '../../lib/format';
import { useStore } from '../../hooks/useStore';
import { AgentAvatar } from '../common/AgentAvatar';
import { wsClient } from '../../lib/ws-client';
import { SwipeableCard } from './SwipeableCard';
import { Pin, PinOff, Trash2, GitFork, BellOff, BellRing } from 'lucide-react';

const PREVIEW_MAX_LENGTH = 50;

interface SessionCardProps {
  session: SessionSummary;
  pinned?: boolean;
  openSwipeId?: string | null;
  setOpenSwipeId?: (id: string | null) => void;
}

export function SessionCard({ session, pinned, openSwipeId, setOpenSwipeId }: SessionCardProps) {
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const isActive = sessionId === session.id;
  const { label } = agentInfo(session.agent);
  const device = useStore((s) => s.devices.get(session.deviceId));
  const handleTogglePin = () => {
    import('../../lib/ws-client').then(({ wsClient }) => wsClient.pinSession(session.id, !pinned));
  };
  const unreadCount = useStore((s) => isActive ? 0 : (s.unreadCount.get(session.id) ?? 0));

  const draft = useStore((s) => s.drafts.get(session.id));

  // Preview from centralized session preview service
  const sessionPreview = useStore((s) => s.sessionPreviews.get(session.id));
  const preview = sessionPreview ? truncate(sessionPreview.text, PREVIEW_MAX_LENGTH) : '';
  const lastTimestamp = sessionPreview?.timestamp ?? '';
  const avatarBadge = sessionPreview?.type === 'question' ? 'question' as const
    : sessionPreview?.type === 'permission' ? 'permission' as const
    : undefined;
  const isDeviceOnline = device?.online ?? false;
  const machineName = session.deviceName || device?.name;

  // Context menu (desktop right-click only, not mobile long-press)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if ('ontouchstart' in window) return; // skip on touch devices — use swipe instead
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
    const close = () => { setMenuPos(null); window.removeEventListener('click', close); };
    window.addEventListener('click', close);
  }, []);

  const isUnread = unreadCount > 0;

  const swipeActions = [
    {
      icon: pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />,
      label: pinned ? 'Unpin' : 'Pin',
      bgClass: 'bg-teal-400 dark:bg-teal-800',
      onClick: () => { handleTogglePin(); setOpenSwipeId?.(null); },
    },
    {
      icon: isUnread ? <BellOff className="h-4 w-4" /> : <BellRing className="h-4 w-4" />,
      label: isUnread ? 'Read' : 'Unread',
      bgClass: 'bg-blue-400 dark:bg-blue-800',
      onClick: () => {
        if (isUnread) { wsClient.markRead(session.id); }
        else { wsClient.markUnread(session.id); }
        setOpenSwipeId?.(null);
      },
    },
    {
      icon: <GitFork className="h-4 w-4" />,
      label: 'Fork',
      bgClass: 'bg-indigo-400 dark:bg-indigo-800',
      onClick: () => { wsClient.forkSession(session.id); setOpenSwipeId?.(null); },
    },
    {
      icon: <Trash2 className="h-4 w-4" />,
      label: 'Delete',
      bgClass: 'bg-red-400 dark:bg-red-900',
      onClick: () => { setOpenSwipeId?.(null); setConfirmDelete(true); },
    },
  ];

  const cardContent = (
      <button
        onClick={() => navigate(`/session/${session.id}`)}
        onContextMenu={handleContextMenu}
        className={`flex w-full items-start gap-2.5 px-2.5 py-2 text-left transition-all ${
          isActive
            ? 'border-l-2 border-kraki-500 bg-surface-primary shadow-sm dark:bg-surface-tertiary'
            : pinned
              ? 'border-l-2 border-transparent hover:bg-surface-primary hover:shadow-sm dark:hover:bg-surface-tertiary active:scale-[0.98]'
              : 'border-l-2 border-transparent hover:bg-black/[0.03] dark:hover:bg-white/[0.06] active:scale-[0.98]'
        }`}
      >
        <div className="relative self-start shrink-0">
          <AgentAvatar agent={session.agent} sessionId={session.id} status={session.state as 'active' | 'idle'} badge={avatarBadge} pinned={pinned} />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-kraki-500 ring-2 ring-surface-secondary" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {pinned && null}
            <span className="truncate text-xs font-semibold text-text-primary">
              {session.title ?? session.autoTitle ?? label}
            </span>
            {!device?.online && (
              <span className="shrink-0 rounded-full bg-slate-500/10 px-1.5 py-0.5 text-[9px] font-medium text-text-muted">offline</span>
            )}
            {lastTimestamp && (
              <span className="ml-auto shrink-0 text-[10px] text-text-muted">{sessionTime(lastTimestamp)}</span>
            )}
          </div>
          <div className="flex items-center gap-1 mt-0.5">
            {machineName && (
              <>
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    !isDeviceOnline ? 'bg-slate-400'
                    : session.state === 'active' ? 'bg-blue-400 animate-pulse'
                    : 'bg-emerald-400'
                  }`}
                />
                <span className="text-[10px] text-text-muted">{machineName}</span>
              </>
            )}
            {machineName && session.model && (
              <span className="text-[10px] text-text-muted">·</span>
            )}
            {session.model && (
              <span className="text-[10px] text-text-muted">{session.model}</span>
            )}
            {session.source && session.source !== 'kraki' && (
              <span className="shrink-0 rounded-full bg-kraki-500/10 px-1.5 py-0.5 text-[9px] font-medium text-kraki-600 dark:text-kraki-400">
                {session.source === 'copilot-cli' ? 'imported' : session.source === 'vscode' ? 'VS Code' : 'imported'}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-text-secondary">
            {draft && !isActive ? (
              <><span className="font-medium text-red-500">[draft]</span> {truncate(draft, PREVIEW_MAX_LENGTH)}</>
            ) : (
              preview || '\u00A0'
            )}
          </p>
        </div>
      </button>
  );

  return (
    <>
      <SwipeableCard
        actions={swipeActions}
        isOpen={openSwipeId === session.id}
        onSwipeOpen={() => setOpenSwipeId?.(session.id)}
        onSwipeClose={() => { if (openSwipeId === session.id) setOpenSwipeId?.(null); }}
      >
        {cardContent}
      </SwipeableCard>

      {menuPos && (
        <div
          className="fixed z-50 rounded-lg border border-border-primary bg-surface-primary py-1 shadow-lg"
          style={{ left: menuPos.x, top: menuPos.y }}
        >
          <button
            onClick={() => { handleTogglePin(); setMenuPos(null); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-primary hover:bg-surface-tertiary"
          >
            {pinned ? <><PinOff className="h-3.5 w-3.5" /> Unpin</> : <><Pin className="h-3.5 w-3.5" /> Pin to top</>}
          </button>
          <button
            onClick={() => {
              if (isUnread) { wsClient.markRead(session.id); }
              else { wsClient.markUnread(session.id); }
              setMenuPos(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-primary hover:bg-surface-tertiary"
          >
            {isUnread ? <><BellOff className="h-3.5 w-3.5" /> Mark read</> : <><BellRing className="h-3.5 w-3.5" /> Mark unread</>}
          </button>
          <button
            onClick={() => { wsClient.forkSession(session.id); setMenuPos(null); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-primary hover:bg-surface-tertiary"
          >
            <GitFork className="h-3.5 w-3.5" /> Fork session
          </button>
          <button
            onClick={() => { setMenuPos(null); setConfirmDelete(true); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-red-600 hover:bg-surface-tertiary dark:text-red-400"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete session
          </button>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setConfirmDelete(false)} onKeyDown={(e) => e.key === 'Escape' && setConfirmDelete(false)} role="dialog" aria-modal="true" tabIndex={-1}>
          <div className="mx-4 w-full max-w-sm rounded-xl bg-surface-primary p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-text-primary">Delete session?</h3>
            <p className="mt-2 text-sm text-text-secondary">
              This will permanently delete this session and all its messages. This cannot be undone.
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-secondary"
              >
                Cancel
              </button>
              <button
                onClick={() => { wsClient.deleteSession(session.id); setConfirmDelete(false); }}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
