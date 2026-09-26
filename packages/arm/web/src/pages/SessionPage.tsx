import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useStore } from '../hooks/useStore';
import { ChatView } from '../components/chat/ChatView';
import { ChatHeader, HEADER_HEIGHT, type SessionMode } from '../components/chat/ChatHeader';
import { wsClient } from '../lib/ws-client';
import { useNarrow } from '../hooks/useNarrow';
import { agentInfo } from '../lib/format';
import { SessionInfoPanel } from '../components/devices/SessionInfoPanel';
import { messageProvider } from '../lib/message-provider';
import { HtmlArtifactPanel } from '../components/chat/HtmlArtifactPanel';
import type { ContentRef } from '@kraki/protocol';
import { setDesiredSessionSubscription } from '../lib/session-subscription-lifecycle';
import { allowAutoRead, isAutoReadSuppressed } from '../lib/read-visibility';

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
  const totalOtherUnread = useStore((s) => {
    let count = 0;
    for (const [sid, n] of s.unreadCount) {
      if (sid !== sessionId && n > 0) count++;
    }
    return count;
  });
  const navigate = useNavigate();
  const [mobileInfoOpen, setMobileInfoOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<ContentRef | null>(null);
  const sessionUsage = useStore((s) => sessionId ? s.sessionUsage.get(sessionId) : undefined);
  const deviceAgentsList = useStore((s) => session ? s.deviceAgents.get(session.deviceId) : undefined);
  // Find the agent matching this session, or flatten all agents' models
  const deviceAgent = deviceAgentsList?.find(a => a.id === session?.agent) ?? deviceAgentsList?.[0];
  const deviceModels = deviceAgent?.models;
  const deviceModelDetails = deviceAgent?.modelDetails;

  const isPending = useStore((s) => sessionId ? s.pendingSessions.has(sessionId) : false);
  const sessionMode = useStore((s) => (sessionId ? s.sessionModes.get(sessionId) : undefined) ?? 'discuss') as SessionMode;
  const narrow = useNarrow();

  // Navigate home when session is deleted (removed from store while viewing)
  // but not if it's a pending session (optimistic open before session_created)
  useEffect(() => {
    if (sessionId && !session && !isPending) navigate('/', { replace: true });
  }, [sessionId, session, isPending, navigate]);

  // Track which session is being viewed so ws-client can suppress unread for it
  useEffect(() => {
    if (sessionId) setActiveSessionId(sessionId);
    setSelectedArtifact(null);
    return () => setActiveSessionId(null);
  }, [sessionId, setActiveSessionId]);

  // Session changes replace the desired value directly (A→B is one atomic
  // set on the same tentacle; do not emit an intermediate null from effect cleanup).
  useEffect(() => {
    if (sessionId) setDesiredSessionSubscription(sessionId);
  }, [sessionId]);

  // Only leaving the SessionPage route entirely unsubscribes.
  useEffect(() => () => setDesiredSessionSubscription(null), []);

  // Tier 2: on-demand message loading when user opens a session
  useEffect(() => {
    if (!sessionId) return;
    messageProvider.ensureLoaded(sessionId);
  }, [sessionId]);

  // Mark read only while this detail is genuinely visible and focused.
  useEffect(() => {
    if (!sessionId) return;
    allowAutoRead(sessionId);

    const doMarkRead = () => {
      if (
        !isAutoReadSuppressed(sessionId)
        && document.visibilityState === 'visible'
        && document.hasFocus()
      ) {
        clearUnread(sessionId);
        import('../lib/ws-client').then(({ wsClient }) => wsClient.markRead(sessionId, undefined, true));
      }
    };

    doMarkRead();
    window.addEventListener('focus', doMarkRead);
    document.addEventListener('visibilitychange', doMarkRead);
    return () => {
      allowAutoRead(sessionId);
      window.removeEventListener('focus', doMarkRead);
      document.removeEventListener('visibilitychange', doMarkRead);
    };
  }, [sessionId, clearUnread]);

  if (!session && isPending) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-kraki-500 border-t-transparent" />
          <p className="mt-3 text-sm text-text-secondary">Starting session…</p>
        </div>
      </div>
    );
  }

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
  const displayTitle = session.title ?? session.autoTitle ?? label;
  const topInset = narrow ? HEADER_HEIGHT.narrow : HEADER_HEIGHT.wide;

  return (
    <div className="kchat-page">
      <ChatHeader
        title={displayTitle}
        mode={sessionMode}
        narrow={narrow}
        backBadge={totalOtherUnread}
        onBack={() => navigate('/')}
        onTitle={() => {
          if (narrow) setMobileInfoOpen(true);
          else navigate(`/devices?device=${session.deviceId}&session=${sessionId}`);
        }}
        onMode={(mode) => wsClient.setSessionMode(sessionId!, mode)}
      />
      {(isReconnecting || !isDeviceOnline) && (
        <div className="kchat-banner" style={{ top: topInset }}>
          {isReconnecting ? 'Reconnecting…' : `${session.deviceName ?? 'Device'} is offline — messages will be sent when it reconnects`}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1">
          <ChatView sessionId={sessionId!} topInset={topInset} onOpenArtifact={setSelectedArtifact} />
        </div>
        {selectedArtifact && (
          <HtmlArtifactPanel artifact={selectedArtifact} sessionId={sessionId!} onClose={() => setSelectedArtifact(null)} />
        )}
      </div>

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
