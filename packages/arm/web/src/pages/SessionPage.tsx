import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useStore } from '../hooks/useStore';
import { ChatView } from '../components/chat/ChatView';
import { agentInfo } from '../lib/format';
import { AgentAvatar } from '../components/common/AgentAvatar';
import { wsClient } from '../lib/ws-client';

export function SessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const session = useStore((s) => (sessionId ? s.sessions.get(sessionId) : undefined));
  const device = useStore((s) => session ? s.devices.get(session.deviceId) : undefined);
  const isDeviceOnline = device?.online ?? false;
  const clearUnread = useStore((s) => s.clearUnread);
  const setActiveSessionId = useStore((s) => s.setActiveSessionId);
  const sessionMode = useStore((s) => (sessionId ? (s.sessionModes.get(sessionId) ?? 'ask') : 'ask'));
  const totalOtherUnread = useStore((s) => {
    let count = 0;
    for (const [sid, n] of s.unreadCount) {
      if (sid !== sessionId && n > 0) count++;
    }
    return count;
  });
  const navigate = useNavigate();

  // Track which session is being viewed so ws-client can suppress unread for it
  useEffect(() => {
    if (sessionId) setActiveSessionId(sessionId);
    return () => setActiveSessionId(null);
  }, [sessionId, setActiveSessionId]);

  // Clear unread when viewing session + notify server
  useEffect(() => {
    if (sessionId) {
      clearUnread(sessionId);
      // Dynamic import to avoid circular deps
      import('../lib/ws-client').then(({ wsClient }) => wsClient.markRead(sessionId));
    }
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b border-border-primary bg-surface-primary px-4">
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
        <AgentAvatar agent={session.agent} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-text-primary">{label}</span>
            {session.model && (
              <span className="text-xs text-text-muted">{session.model}</span>
            )}
            {!isDeviceOnline && (
              <span className="rounded-full bg-slate-500/10 px-1.5 py-0.5 text-[9px] font-medium text-text-muted">offline</span>
            )}
          </div>
          {session.deviceName && (
            <p className="text-[10px] text-text-muted">{session.deviceName}</p>
          )}
        </div>
        {isDeviceOnline && sessionId && (
          <button
            onClick={() => wsClient.setSessionMode(sessionId, sessionMode === 'ask' ? 'auto' : 'ask')}
            className="flex items-center gap-1.5"
          >
            <span className={`text-[11px] font-medium transition-colors duration-200 ${
              sessionMode === 'ask' ? 'text-ocean-900 dark:text-ocean-300' : 'text-text-muted'
            }`}>Ask</span>
            <div className={`relative h-5 w-9 rounded-full transition-colors duration-300 ${
              sessionMode === 'auto' ? 'bg-kraki-500' : 'bg-ocean-800'
            }`}>
              <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-300 ease-in-out ${
                sessionMode === 'auto' ? 'translate-x-4' : 'translate-x-0'
              }`} />
            </div>
            <span className={`text-[11px] font-medium transition-colors duration-200 ${
              sessionMode === 'auto' ? 'text-kraki-600 dark:text-kraki-300' : 'text-text-muted'
            }`}>Auto</span>
          </button>
        )}
      </div>

      <ChatView />
    </div>
  );
}
