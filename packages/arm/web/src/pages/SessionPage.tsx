import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useStore } from '../hooks/useStore';
import { ChatView } from '../components/chat/ChatView';
import { agentInfo } from '../lib/format';
import { AgentAvatar } from '../components/common/AgentAvatar';
import { SessionInfoPanel } from '../components/devices/SessionInfoPanel';

export function SessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const session = useStore((s) => (sessionId ? s.sessions.get(sessionId) : undefined));
  const device = useStore((s) => session ? s.devices.get(session.deviceId) : undefined);
  const isDeviceOnline = device?.online ?? false;
  const clearUnread = useStore((s) => s.clearUnread);
  const setActiveSessionId = useStore((s) => s.setActiveSessionId);
  const status = useStore((s) => s.status);
  const reconnectAttempts = useStore((s) => s.reconnectAttempts);
  const isReconnecting = (status === 'disconnected' || status === 'connecting') && reconnectAttempts > 0;
  const isLoadingMessages = useStore((s) => sessionId ? s.loadingSessions.has(sessionId) : false);
  const hasMessages = useStore((s) => sessionId ? (s.messages.get(sessionId)?.length ?? 0) > 0 : false);
  const showLoadingSpinner = isLoadingMessages && !hasMessages;
  const totalOtherUnread = useStore((s) => {
    let count = 0;
    for (const [sid, n] of s.unreadCount) {
      if (sid !== sessionId && n > 0) count++;
    }
    return count;
  });
  const navigate = useNavigate();
  const [mobileInfoOpen, setMobileInfoOpen] = useState(false);
  const sessionUsage = useStore((s) => sessionId ? s.sessionUsage.get(sessionId) : undefined);
  const deviceModels = useStore((s) => session ? s.deviceModels.get(session.deviceId) : undefined);
  const deviceModelDetails = useStore((s) => session ? s.deviceModelDetails.get(session.deviceId) : undefined);

  // Navigate home when session is deleted (removed from store while viewing)
  useEffect(() => {
    if (sessionId && !session) navigate('/', { replace: true });
  }, [sessionId, session, navigate]);

  // Track which session is being viewed so ws-client can suppress unread for it
  useEffect(() => {
    if (sessionId) setActiveSessionId(sessionId);
    return () => setActiveSessionId(null);
  }, [sessionId, setActiveSessionId]);

  // Clear unread when viewing session + notify server
  useEffect(() => {
    if (!sessionId) return;

    const doMarkRead = () => {
      if (document.hasFocus()) {
        clearUnread(sessionId);
        import('../lib/ws-client').then(({ wsClient }) => wsClient.markRead(sessionId));
      }
    };

    doMarkRead();
    window.addEventListener('focus', doMarkRead);
    return () => window.removeEventListener('focus', doMarkRead);
  }, [sessionId, clearUnread]);

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <span className="text-4xl">🤷</span>
          <p className="mt-3 text-sm text-text-secondary">Session not found</p>
          <button
            onClick={() => navigate('/')}
            className="mt-3 text-xs font-medium text-kraki-500 hover:text-kraki-400"
          >
            ← Back to sessions
          </button>
        </div>
      </div>
    );
  }

  const { label } = agentInfo(session.agent);
  const displayTitle = session.title ?? session.autoTitle;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-primary bg-surface-primary px-4">
        <button
          onClick={() => navigate('/')}
          className="relative mr-1 text-text-secondary hover:text-text-primary md:hidden"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          {totalOtherUnread > 0 && (
            <span className="absolute -top-1.5 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
              {totalOtherUnread}
            </span>
          )}
        </button>
        <div className="relative">
          <AgentAvatar agent={session.agent} sessionId={sessionId} size="sm" status={session.state as 'active' | 'idle'} />
          {isReconnecting && (
            <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/30">
              <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-amber-400 border-t-transparent" />
            </div>
          )}
          {showLoadingSpinner && !isReconnecting && (
            <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/30">
              <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-kraki-400 border-t-transparent" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-text-primary">
            {displayTitle ?? label}
          </span>
          <div className="flex items-center gap-1">
            {session.deviceName && (
              <>
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    !isDeviceOnline ? 'bg-slate-400'
                    : session.state === 'active' ? 'bg-blue-400 animate-pulse'
                    : 'bg-emerald-400'
                  }`}
                />
                <span className="text-[10px] text-text-muted">{session.deviceName}</span>
              </>
            )}
            {session.model && (
              <span className="text-[10px] text-text-muted">{session.model}</span>
            )}
          </div>
        </div>
        {/* More button — slide-over on mobile, navigate on desktop */}
        <button
          onClick={() => {
            if (window.innerWidth < 768) { setMobileInfoOpen(true); }
            else { navigate(`/devices?device=${session.deviceId}&session=${sessionId}`); }
          }}
          className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-tertiary hover:text-text-primary"
          title="Session settings"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z" />
          </svg>
        </button>
      </div>

      <ChatView />

      {/* Mobile session info slide-over */}
      {mobileInfoOpen && session && (
        <div className="fixed inset-0 z-50 md:hidden" onKeyDown={(e) => e.key === 'Escape' && setMobileInfoOpen(false)} role="dialog" aria-modal="true" tabIndex={-1}>
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileInfoOpen(false)} />
          <div className="absolute inset-y-0 right-0 w-full max-w-sm animate-slide-in-right bg-surface-primary shadow-xl">
            <SessionInfoPanel
              session={session}
              usage={sessionUsage}
              models={deviceModels}
              modelDetails={deviceModelDetails}
              onClose={() => setMobileInfoOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
