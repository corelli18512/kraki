import { useNavigate, useParams } from 'react-router';
import { useState, useCallback } from 'react';
import type { SessionSummary } from '@kraki/protocol';
import { agentInfo, truncate, sessionTime } from '../../lib/format';
import { useStore } from '../../hooks/useStore';
import { AgentAvatar } from '../common/AgentAvatar';
import { Pin, PinOff } from 'lucide-react';

const PREVIEW_MAX_LENGTH = 50;

export function SessionCard({ session, pinned }: { session: SessionSummary; pinned?: boolean }) {
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const isActive = sessionId === session.id;
  const { emoji, label } = agentInfo(session.agent);
  const device = useStore((s) => s.devices.get(session.deviceId));
  const togglePin = useStore((s) => s.togglePin);
  const unreadCount = useStore((s) => isActive ? 0 : (s.unreadCount.get(session.id) ?? 0));

  const draft = useStore((s) => s.drafts.get(session.id));

  // Get last message preview
  const messages = useStore((s) => s.messages.get(session.id));
  const lastMsg = messages?.[messages.length - 1];
  let preview = '';
  if (lastMsg && 'payload' in lastMsg) {
    const payload = lastMsg.payload as Record<string, unknown>;
    if ('content' in payload && typeof payload.content === 'string') {
      preview = truncate(payload.content, PREVIEW_MAX_LENGTH);
    } else if ('message' in payload && typeof payload.message === 'string') {
      preview = truncate(payload.message, PREVIEW_MAX_LENGTH);
    }
  }

  const lastTimestamp = lastMsg && 'timestamp' in lastMsg ? (lastMsg as { timestamp: string }).timestamp : '';
  const isDeviceOnline = device?.online ?? false;
  const machineName = session.deviceName || device?.name;

  // Context menu
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
    const close = () => { setMenuPos(null); window.removeEventListener('click', close); };
    window.addEventListener('click', close);
  }, []);

  return (
    <>
      <button
        onClick={() => navigate(`/session/${session.id}`)}
        onContextMenu={handleContextMenu}
        className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-all ${
          isActive
            ? 'border-l-2 border-kraki-500 bg-surface-primary shadow-sm dark:bg-surface-tertiary'
            : 'border-l-2 border-transparent hover:bg-surface-primary hover:shadow-sm dark:hover:bg-surface-tertiary active:scale-[0.98]'
        }`}
      >
        <div className="relative self-start shrink-0">
          <AgentAvatar agent={session.agent} />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-kraki-500 ring-2 ring-surface-secondary" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {pinned && <Pin className="h-3 w-3 text-text-muted" />}
            <span className="text-xs font-semibold text-text-primary">{label}</span>
            {session.model && (
              <span className="text-[10px] text-text-muted">{session.model}</span>
            )}
            {!device?.online && (
              <span className="rounded-full bg-slate-500/10 px-1.5 py-0.5 text-[9px] font-medium text-text-muted">offline</span>
            )}
            {lastTimestamp && (
              <span className="ml-auto text-[10px] text-text-muted">{sessionTime(lastTimestamp)}</span>
            )}
          </div>
          {machineName && (
            <div className="flex items-center gap-1 mt-0.5">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  isDeviceOnline ? 'bg-emerald-400' : 'bg-slate-400'
                }`}
              />
              <span className="text-[10px] text-text-muted">{machineName}</span>
            </div>
          )}
          <p className="mt-0.5 truncate text-[11px] text-text-secondary">
            {draft && !isActive ? (
              <><span className="font-medium text-red-500">[draft]</span> {truncate(draft, PREVIEW_MAX_LENGTH)}</>
            ) : (
              preview || '\u00A0'
            )}
          </p>
        </div>
      </button>

      {menuPos && (
        <div
          className="fixed z-50 rounded-lg border border-border-primary bg-surface-primary py-1 shadow-lg"
          style={{ left: menuPos.x, top: menuPos.y }}
        >
          <button
            onClick={() => { togglePin(session.id); setMenuPos(null); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-primary hover:bg-surface-tertiary"
          >
            {pinned ? <><PinOff className="h-3.5 w-3.5" /> Unpin</> : <><Pin className="h-3.5 w-3.5" /> Pin to top</>}
          </button>
        </div>
      )}
    </>
  );
}
