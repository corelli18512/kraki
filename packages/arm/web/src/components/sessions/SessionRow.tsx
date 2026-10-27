import { useTranslation } from 'react-i18next';
import { memo, useCallback, useEffect, useState } from 'react';
import { modelDisplayName, sessionDisplayTitle } from '../../lib/session-status';
import { useNavigate } from 'react-router';
import type { WebSessionSummary } from '../../types/store';
import { useOutbox } from '../../lib/chat/outbox';
import {
  Archive, MoreHorizontal, Pencil, BellOff, BellRing, BotMessageSquare, CircleSlash, CircleUser, GitFork, Keyboard,
  MessageCircleQuestion, Pin, PinOff, ShieldQuestion, Trash2, WifiOff,
} from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';
import { collapseWhitespace, resolveCardStatus, sessionTimeLabel, sessionTimestamp, STATUS_LABEL, type SessionCardStatus, sessionPendingPreview, DELIVERY_LABEL, type SessionDeliveryStatus } from '../../lib/chat/session-card';
import { SessionCardMetadata } from './SessionCardMetadata';
import { AgentAvatar } from '../common/AgentAvatar';
import { SwipeableCard } from './SwipeableCard';
import { SettingsAlert } from '../layout/SettingsControls';

function StatusGlyph({ status, draft, delivery }: { status: SessionCardStatus; draft: boolean; delivery?: SessionDeliveryStatus }) {
  if (delivery) return <svg viewBox="0 0 16 16" className={`ksr-glyph ksr-delivery is-${delivery}`} fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={DELIVERY_LABEL[delivery]}>
    <path d="M8 9V1.5M5.5 4L8 1.5 10.5 4M4 6H2.5L1 11v3h14v-3l-1.5-5H12M1 11h4l1 1.5h4l1-1.5h4" />
  </svg>;
  const label = STATUS_LABEL[status];
  const common = { 'aria-label': label, role: label ? 'img' : undefined } as const;
  switch (status) {
    case 'active': return <span className="ksr-dots" {...common}><i /><i /><i /></span>;
    case 'compacting': return <span className="ksr-glyph" {...common}><span className="kspinner ksr-mini" /></span>;
    case 'waiting': return <MessageCircleQuestion className="ksr-glyph ksr-attention text-amber-600" strokeWidth={2.2} {...common} />;
    case 'approval': return <ShieldQuestion className="ksr-glyph ksr-attention text-amber-600" strokeWidth={2.2} {...common} />;
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
  session, selected, pinned, narrow, openSwipeId, setOpenSwipeId, archived,
}: {
  session: WebSessionSummary;
  /** Archived row (F2): preview from the archive listing; opening restores it. */
  archived?: { preview?: { text: string; type: string; timestamp: string }; onOpen: () => void };
  selected: boolean;
  pinned: boolean;
  narrow: boolean;
  openSwipeId?: string | null;
  setOpenSwipeId?: (id: string | null) => void;
}) {
  const { t } = useTranslation(['sessions', 'common']);
  const navigate = useNavigate();
  const device = useStore((s) => s.devices.get(session.deviceId));
  const deviceAgents = useStore((s) => s.deviceAgents.get(session.deviceId));
  const livePreview = useStore((s) => s.sessionPreviews.get(session.id));
  const preview = livePreview ?? archived?.preview;
  const draft = useStore((s) => s.drafts.get(session.id));
  const unread = useStore((s) => !selected && (s.unreadCount.get(session.id) ?? 0) > 0);
  const compacting = useStore((s) => s.runtimeStatuses.get(session.id)?.status === 'compacting');
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const entries = useOutbox((s) => s.entries);
  const connected = useStore((s) => s.status === 'connected');
  const pending = archived ? undefined : sessionPendingPreview(entries, session.id, connected && device?.online !== false);
  const draftText = collapseWhitespace(draft);
  const hasDraft = !pending && !!draftText;
  const previewText = pending?.text ?? (hasDraft ? draftText : collapseWhitespace(preview?.text));
  const status = pending ? 'delivery' : resolveCardStatus(session.state, preview?.type, device?.online, hasDraft, compacting);
  const title = sessionDisplayTitle(session);
  // The live device name first: it follows renames.
  const machine = device?.name || session.deviceName;
  const time = sessionTimeLabel(sessionTimestamp(pending?.timestamp || preview?.timestamp, session.createdAt));

  const togglePin = () => wsClient.pinSession(session.id, !pinned);
  const toggleRead = () => (unread ? wsClient.markRead(session.id) : wsClient.markUnread(session.id));

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    if (narrow || archived) return;
    e.preventDefault();
    setMenu({ x: Math.max(0, Math.min(e.clientX, window.innerWidth - 118)), y: Math.max(0, Math.min(e.clientY, window.innerHeight - 166)) });
  }, [narrow, archived]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const row = (
    <button
      type="button"
      className={`ksr ${narrow ? 'is-narrow' : 'is-wide'} ${selected ? 'is-selected' : ''}`}
      onClick={() => { archived?.onOpen(); navigate(`/session/${session.id}`); }}
      onContextMenu={onContextMenu}
      aria-current={selected ? 'page' : undefined}
    >
      <span className="ksr-avatar">
        <AgentAvatar agent={session.agent} model={session.model} sessionId={session.id} size={narrow ? 'lg' : 'sm'} />
      </span>
      <span className="ksr-body">
        <span className="ksr-line1">
          <span className="ksr-title">{title}</span>
          {narrow && device && !device.online && <span className="ksr-offline">{t('row.offline')}</span>}
          {pinned && <Pin className="ksr-pin" aria-label={t('row.pinned')} />}
          <span className="ksr-spacer" />
          {unread && <span className="ksr-unread" aria-label={t('row.unread')} />}
          {time && <span className="ksr-time">{time}</span>}
        </span>
        {narrow ? <span className="ksr-line2">
          {machine && (
            <>
              {narrow && <span className={`ksr-devdot ${device?.online ? 'is-online' : ''}`} />}
              <span className="ksr-machine">{machine}</span>
            </>
          )}
          {machine && session.model && <span className="ksr-sep" />}
          {session.model && <span className="ksr-model">{modelDisplayName(session.model, deviceAgents, session.agent)}</span>}
        </span> : <SessionCardMetadata machine={machine} model={session.model ? modelDisplayName(session.model, deviceAgents, session.agent) : undefined} effort={session.reasoningEffort ? t(`row.effort.${session.reasoningEffort}`, { defaultValue: session.reasoningEffort }) : undefined} />}
        <span className={`ksr-line3 ${hasDraft ? 'is-draft' : ''}`}>
          <span className="ksr-status-slot" data-status={pending?.status ?? status}><StatusGlyph status={status} draft={hasDraft} delivery={pending?.status} /></span>
          {previewText
            ? <span className="ksr-preview">{previewText}</span>
            : <span className="ksr-preview is-empty">{t('row.created')}</span>}
        </span>
      </span>
    </button>
  );

  return (
    <>
      {narrow && !archived ? (
        <SwipeableCard
          actions={[
            { icon: pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />, label: pinned ? t('row.unpin') : t('row.pin'), bgClass: 'bg-teal-500', onClick: () => { togglePin(); setOpenSwipeId?.(null); } },
            { icon: unread ? <BellOff className="h-4 w-4" /> : <BellRing className="h-4 w-4" />, label: unread ? t('row.read') : t('row.unread'), bgClass: 'bg-blue-500', onClick: () => { toggleRead(); setOpenSwipeId?.(null); } },
            { icon: <MoreHorizontal className="h-4 w-4" />, label: t('row.more'), bgClass: 'bg-slate-500', onClick: () => { setOpenSwipeId?.(null); setMenu({ x: 16, y: Math.min(window.innerHeight - 280, 100) }); } },
            { icon: <Trash2 className="h-4 w-4" />, label: t('common:action.delete'), bgClass: 'bg-red-500', onClick: () => { setOpenSwipeId?.(null); setConfirmDelete(true); } },
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
            {pinned ? <PinOff /> : <Pin />} {pinned ? t('row.unpin') : t('row.pin')}
          </button>
          <button type="button" role="menuitem" onClick={() => { toggleRead(); setMenu(null); }}>
            {unread ? <BellOff /> : <BellRing />} {unread ? t('row.markRead') : t('row.markUnread')}
          </button>
          {/* Mac: Rename lives in Session Info, opened over the selected chat. */}
          <button type="button" role="menuitem" onClick={() => { navigate(`/session/${session.id}?info=1`); setMenu(null); }}><Pencil /> {t('row.rename')}</button>
          <button type="button" role="menuitem" onClick={() => { wsClient.forkSession(session.id); setMenu(null); }}>
            <GitFork /> {t('row.fork')}
          </button>
          <button type="button" role="menuitem" onClick={() => { wsClient.archiveSession(session.id, true); if (selected) navigate('/'); setMenu(null); }}>
            <Archive /> {t('row.archive')}
          </button>
          <div className="ksr-menu-divider" role="separator" />
          <button type="button" role="menuitem" className="is-destructive" onClick={() => { setMenu(null); setConfirmDelete(true); }}>
            <Trash2 /> {t('row.delete')}
          </button>
        </div>
      )}

      {confirmDelete && (
        <SettingsAlert
          viewport
          stacked
          title={t('row.deleteConfirm')}
          body=""
          confirm={t('row.deleteSession')}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => { wsClient.deleteSession(session.id); setConfirmDelete(false); }}
        />
      )}
    </>
  );
});
