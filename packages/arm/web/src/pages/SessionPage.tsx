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
  const sessionMode = useStore((s) => (sessionId ? (s.sessionModes.get(sessionId) ?? 'plan') : 'plan'));
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
          <div className="flex items-center gap-0.5 rounded-full bg-surface-secondary p-0.5">
            {(['safe', 'plan', 'execute', 'delegate'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => wsClient.setSessionMode(sessionId, mode)}
                className={`px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors duration-200 ${
                  sessionMode === mode
                    ? 'bg-white dark:bg-surface-primary text-text-primary shadow-sm'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        )}
      </div>

      <ChatView />
    </div>
  );
}
