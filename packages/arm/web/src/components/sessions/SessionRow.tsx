import { memo, useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import type { SessionSummary } from '@kraki/protocol';
import {
  BellOff, BellRing, BotMessageSquare, CircleSlash, CircleUser, GitFork, Keyboard,
  MessageCircleQuestion, Pin, PinOff, ShieldQuestion, Trash2, WifiOff,
} from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { agentInfo } from '../../lib/format';
import { wsClient } from '../../lib/ws-client';
import { collapseWhitespace, resolveCardStatus, sessionTimeLabel, STATUS_LABEL, type SessionCardStatus } from '../../lib/chat/session-card';
import { AgentAvatar } from '../common/AgentAvatar';
import { SwipeableCard } from './SwipeableCard';

function StatusGlyph({ status, draft }: { status: SessionCardStatus; draft: boolean }) {
  const label = STATUS_LABEL[status];
  const common = { 'aria-label': label, role: label ? 'img' : undefined } as const;
  switch (status) {
    case 'active': return <span className="ksr-dots" {...common}><i /><i /><i /></span>;
    case 'compacting': return <span className="ksr-glyph" {...common}><span className="kspinner ksr-mini" /></span>;
    case 'waiting': return <MessageCircleQuestion className="ksr-glyph text-amber-600" strokeWidth={2.2} {...common} />;
    case 'approval': return <ShieldQuestion className="ksr-glyph text-amber-600" strokeWidth={2.2} {...common} />;
    case 'error': return <CircleSlash className="ksr-glyph text-red-500" strokeWidth={2.2} {...common} />;
    case 'offline': return <WifiOff className="ksr-glyph ksr-muted" strokeWidth={2.2} {...common} />;
    case 'agentMessage': return <BotMessageSquare className="ksr-glyph ksr-brand" strokeWidth={1.9} {...common} />;
    case 'humanMessage': return draft
      ? <Keyboard className="ksr-glyph text-[#4f8c86]" strokeWidth={2} {...common} />
      : <CircleUser className="ksr-glyph ksr-muted" strokeWidth={1.9} {...common} />;
    default: return <span className="ksr-glyph" aria-hidden />;
  }
}

export const SessionRow = memo(function SessionRow({
  session, selected, pinned, narrow, openSwipeId, setOpenSwipeId,
}: {
  session: SessionSummary;
  selected: boolean;
  pinned: boolean;
  narrow: boolean;
  openSwipeId?: string | null;
  setOpenSwipeId?: (id: string | null) => void;
}) {
  const navigate = useNavigate();
  const device = useStore((s) => s.devices.get(session.deviceId));
  const preview = useStore((s) => s.sessionPreviews.get(session.id));
  const draft = useStore((s) => s.drafts.get(session.id));
  const unread = useStore((s) => !selected && (s.unreadCount.get(session.id) ?? 0) > 0);
  const compacting = useStore((s) => s.runtimeStatuses.get(session.id)?.status === 'compacting');
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const draftText = collapseWhitespace(draft);
  const hasDraft = !!draftText && !selected;
  const previewText = hasDraft ? draftText : collapseWhitespace(preview?.text);
  const status = resolveCardStatus(session.state, preview?.type, device?.online, hasDraft, compacting);
  const title = session.title ?? session.autoTitle ?? agentInfo(session.agent).label;
  const machine = session.deviceName || device?.name;
  const time = sessionTimeLabel(preview?.timestamp ?? '');

  const togglePin = () => wsClient.pinSession(session.id, !pinned);
  const toggleRead = () => (unread ? wsClient.markRead(session.id) : wsClient.markUnread(session.id));

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    if (narrow) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
    const close = () => { setMenu(null); window.removeEventListener('click', close); };
    setTimeout(() => window.addEventListener('click', close), 0);
  }, [narrow]);

  const row = (
    <button
      type="button"
      className={`ksr ${narrow ? 'is-narrow' : 'is-wide'} ${selected ? 'is-selected' : ''}`}
      onClick={() => navigate(`/session/${session.id}`)}
      onContextMenu={onContextMenu}
      aria-current={selected ? 'page' : undefined}
    >
      <span className="ksr-avatar">
        <AgentAvatar agent={session.agent} sessionId={session.id} size={narrow ? 'lg' : 'row'} />
      </span>
      <span className="ksr-body">
        <span className="ksr-line1">
          <span className="ksr-title">{title}</span>
          {device && !device.online && <span className="ksr-offline">offline</span>}
          {pinned && <Pin className="ksr-pin" aria-label="Pinned" />}
          <span className="ksr-spacer" />
          {unread && <span className="ksr-unread" aria-label="Unread" />}
          {time && <span className="ksr-time">{time}</span>}
        </span>
        <span className="ksr-line2">
          {machine && (
            <>
              <span className={`ksr-devdot ${device?.online ? 'is-online' : ''}`} />
              <span className="ksr-machine">{machine}</span>
            </>
          )}
          {machine && session.model && <span className="ksr-sep" />}
          {session.model && <span className="ksr-model">{session.model}</span>}
        </span>
        <span className="ksr-line3">
          <StatusGlyph status={status} draft={hasDraft} />
          {previewText
            ? <span className="ksr-preview">{previewText}</span>
            : <span className="ksr-preview is-empty">Session created</span>}
        </span>
      </span>
    </button>
  );

  return (
    <>
      {narrow ? (
        <SwipeableCard
          actions={[
            { icon: pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />, label: pinned ? 'Unpin' : 'Pin', bgClass: 'bg-teal-500', onClick: () => { togglePin(); setOpenSwipeId?.(null); } },
            { icon: unread ? <BellOff className="h-4 w-4" /> : <BellRing className="h-4 w-4" />, label: unread ? 'Read' : 'Unread', bgClass: 'bg-blue-500', onClick: () => { toggleRead(); setOpenSwipeId?.(null); } },
            { icon: <Trash2 className="h-4 w-4" />, label: 'Delete', bgClass: 'bg-red-500', onClick: () => { setOpenSwipeId?.(null); setConfirmDelete(true); } },
          ]}
          isOpen={openSwipeId === session.id}
          onSwipeOpen={() => setOpenSwipeId?.(session.id)}
          onSwipeClose={() => { if (openSwipeId === session.id) setOpenSwipeId?.(null); }}
        >
          {row}
        </SwipeableCard>
      ) : row}

      {menu && (
        <div className="ksr-menu" style={{ left: menu.x, top: menu.y }} role="menu">
          <button type="button" role="menuitem" onClick={() => { togglePin(); setMenu(null); }}>
            {pinned ? <PinOff /> : <Pin />} {pinned ? 'Unpin' : 'Pin to top'}
          </button>
          <button type="button" role="menuitem" onClick={() => { toggleRead(); setMenu(null); }}>
            {unread ? <BellOff /> : <BellRing />} {unread ? 'Mark read' : 'Mark unread'}
          </button>
          <button type="button" role="menuitem" onClick={() => { wsClient.forkSession(session.id); setMenu(null); }}>
            <GitFork /> Fork session
          </button>
          <button type="button" role="menuitem" className="is-destructive" onClick={() => { setMenu(null); setConfirmDelete(true); }}>
            <Trash2 /> Delete session
          </button>
        </div>
      )}

      {confirmDelete && (
        <div className="kdialog-backdrop" onClick={() => setConfirmDelete(false)} role="dialog" aria-modal="true">
          <div className="kdialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete session?</h3>
            <p>This permanently deletes the session and its messages on {machine ?? 'the device'}.</p>
            <div className="kdialog-buttons">
              <button type="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button type="button" className="is-destructive" onClick={() => { wsClient.deleteSession(session.id); setConfirmDelete(false); }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
});
