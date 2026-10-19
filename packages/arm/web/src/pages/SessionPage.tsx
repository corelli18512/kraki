import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import { markNotificationEntry } from '../lib/chat/unread-entry';
import { sessionDisplayTitle } from '../lib/session-status';
import { useParams, useNavigate, useLocation } from 'react-router';
import { diag } from '../lib/diag';
import { useStore } from '../hooks/useStore';
import { useShowsReconnecting } from '../hooks/useShowsReconnecting';
import { ChatView } from '../components/chat/ChatView';
import { ChatHeader, HEADER_HEIGHT, type SessionMode } from '../components/chat/ChatHeader';
import { wsClient } from '../lib/ws-client';
import { useNarrow } from '../hooks/useNarrow';
import { SessionInfoPanel } from '../components/devices/SessionInfoPanel';
import { messageProvider } from '../lib/message-provider';
import { ImagePreviewProvider } from '../components/chat/ImageViewer';
import { HtmlArtifactPanel } from '../components/chat/HtmlArtifactPanel';
import type { ContentRef } from '@kraki/protocol';
import { setDesiredSessionSubscription } from '../lib/session-subscription-lifecycle';
import { allowAutoRead, isAutoReadSuppressed } from '../lib/read-visibility';

export function SessionPage() {
  const { t } = useTranslation('chat');
  const { sessionId } = useParams<{ sessionId: string }>();
  const session = useStore((s) => (sessionId ? s.sessions.get(sessionId) : undefined));
  const device = useStore((s) => session ? s.devices.get(session.deviceId) : undefined);
  const isDeviceOnline = device?.online ?? false;
  const clearUnread = useStore((s) => s.clearUnread);
  const setActiveSessionId = useStore((s) => s.setActiveSessionId);
  const status = useStore((s) => s.status);
  const isReconnecting = useShowsReconnecting();
  const totalOtherUnread = useStore((s) => {
    let count = 0;
    for (const [sid, n] of s.unreadCount) {
      if (sid !== sessionId && n > 0) count++;
    }
    return count;
  });
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileInfoOpen, setMobileInfoOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<ContentRef | null>(null);
  const [selectedArtifactExpanded, setSelectedArtifactExpanded] = useState(false);
  const sessionUsage = useStore((s) => sessionId ? s.sessionUsage.get(sessionId) : undefined);
  const deviceAgentsList = useStore((s) => session ? s.deviceAgents.get(session.deviceId) : undefined);
  // Find the agent matching this session, or flatten all agents' models
  const deviceAgent = deviceAgentsList?.find(a => a.id === session?.agent) ?? deviceAgentsList?.[0];
  const deviceModels = deviceAgent?.models;
  const deviceModelDetails = deviceAgent?.modelDetails;

  const isPending = useStore((s) => sessionId ? s.pendingSessions.has(sessionId) : false);
  const sessionMode = useStore((s) => (sessionId ? s.sessionModes.get(sessionId) : undefined) ?? 'auto') as SessionMode;
  const narrow = useNarrow();

  // Opened from a notification (sw.js): mark it before ChatView's first
  // render captures the entry. The router effect below consumes the URL markers.
  const notifiedEntry = useRef<string | null>(null);
  if (sessionId && notifiedEntry.current !== sessionId
      && new URLSearchParams(location.search).get('from') === 'notification') {
    notifiedEntry.current = sessionId;
    markNotificationEntry(sessionId);
  }

  // Consume entry requests in one router replacement, including same-session Rename.
  useEffect(() => {
    if (!sessionId) return;
    const search = new URLSearchParams(location.search);
    const infoRequested = search.get('info') === '1';
    const notificationMarked = search.get('from') === 'notification' && notifiedEntry.current === sessionId;
    if (!infoRequested && !notificationMarked) return;
    if (infoRequested) {
      setMobileInfoOpen(true);
      search.delete('info');
    }
    if (notificationMarked) search.delete('from');
    navigate({ pathname: location.pathname, search: search.toString(), hash: location.hash }, {
      replace: true,
      state: location.state,
    });
  }, [sessionId, location, navigate]);

  // Navigate home when session is deleted (removed from store while viewing)
  // but not if it's a pending session (optimistic open before session_created)
  useEffect(() => {
    if (sessionId && !session && !isPending) navigate('/', { replace: true });
  }, [sessionId, session, isPending, navigate]);

  // Track which session is being viewed so ws-client can suppress unread for it
  useEffect(() => {
    if (sessionId) {
      setActiveSessionId(sessionId);
      // Performance data (open.summary): opened while online.
      const st = useStore.getState();
      const session = st.sessions.get(sessionId);
      const local = (st.messages.get(sessionId) ?? []).reduce((n, m) => {
        const seq = (m as { seq?: unknown }).seq;
        return typeof seq === 'number' && Number.isInteger(seq) && seq > n ? seq : n;
      }, 0);
      const online = st.status === 'connected' && !!session && st.devices.get(session.deviceId)?.online === true;
      diag.stability.conversationOpened(sessionId, session?.lastSeq ?? 0, local, online);
    }
    setSelectedArtifact(null);
    setSelectedArtifactExpanded(false);
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
          <p className="mt-3 text-sm text-text-secondary">{t('session.starting')}</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <span className="text-4xl">🤷</span>
          <p className="mt-3 text-sm text-text-secondary">{t('session.notFound')}</p>
          <button
            onClick={() => navigate('/')}
            className="mt-3 text-xs font-medium text-kraki-500 hover:text-kraki-400"
          >
            {t('session.back')}
          </button>
        </div>
      </div>
    );
  }

  const displayTitle = sessionDisplayTitle(session);
  const topInset = narrow ? HEADER_HEIGHT.narrow : HEADER_HEIGHT.wide;

  return (
    <div className="kchat-page">
      <div className="kmedia-pane relative flex min-h-0 flex-1">
        <ImagePreviewProvider key={sessionId}>
          <div className="relative flex min-w-0 flex-1">
            <ChatHeader
              // Reconnecting is silent in the conversation; only the title says so.
              title={isReconnecting ? t('session.connecting') : displayTitle}
              mode={sessionMode}
              narrow={narrow}
              backBadge={totalOtherUnread}
              onBack={() => navigate('/')}
              onTitle={() => {
                setMobileInfoOpen(true);
              }}
              onMode={(mode) => wsClient.setSessionMode(sessionId!, mode)}
            />
            {!isReconnecting && !isDeviceOnline && (
              <div className="kchat-banner" style={{ top: topInset }}>
                {t('session.offline', { device: session.deviceName ?? t('session.device') })}
              </div>
            )}

            <ChatView sessionId={sessionId!} topInset={topInset} onOpenArtifact={(artifact) => { setSelectedArtifact(artifact); setSelectedArtifactExpanded(false); }} />
          </div>
          {selectedArtifact && (
            <HtmlArtifactPanel key={selectedArtifact.id} artifact={selectedArtifact} sessionId={sessionId!} expanded={selectedArtifactExpanded} onToggleExpanded={() => setSelectedArtifactExpanded((value) => !value)} onClose={() => { setSelectedArtifact(null); setSelectedArtifactExpanded(false); }} />
          )}
        </ImagePreviewProvider>
      </div>

      {mobileInfoOpen && session && (
        <div className="fixed inset-0 z-50" onKeyDown={(e) => e.key === 'Escape' && setMobileInfoOpen(false)} role="dialog" aria-label={t('session.info')} aria-modal="true" tabIndex={-1}>
          <div className="ksi-backdrop absolute inset-0 bg-black/20" onClick={() => setMobileInfoOpen(false)} />
          <div className="ksi-sheet">
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
