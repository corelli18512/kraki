import { useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { Sidebar } from './components/layout/Sidebar';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { ErrorBanner } from './components/common/ErrorBanner';
import { useWebSocket } from './hooks/useWebSocket';
import { useStore } from './hooks/useStore';
import { useSessionShortcuts } from './hooks/useSessionShortcuts';
import { wsClient } from './lib/ws-client';

const MAX_AUTO_RECONNECT_ATTEMPTS = 5;

function RelayBlockingOverlay({
  status,
  reconnectAttempts,
  nextReconnectDelayMs,
}: {
  status: 'disconnected' | 'error' | 'awaiting_login' | 'connecting' | 'connected';
  reconnectAttempts: number;
  nextReconnectDelayMs: number | null;
}) {
  const retriesPaused = reconnectAttempts >= MAX_AUTO_RECONNECT_ATTEMPTS && nextReconnectDelayMs === null && status !== 'connecting';
  const isConnecting = status === 'connecting';
  const title = status === 'error'
    ? 'Connection Error'
    : 'Disconnected';
  const message = status === 'error'
    ? 'Could not connect to the relay server. Make sure the head is running.'
    : 'Lost connection to the relay server.';

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="relay-status-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/10 p-4 backdrop-blur-[1.5px]"
    >
      <div className="w-full max-w-md rounded-2xl border border-border-primary bg-surface-primary/95 p-8 text-center shadow-2xl">
        <img src="/logo.png" alt="Kraki" className="mx-auto h-16 w-16 object-contain" />
        <h2 id="relay-status-title" className="mt-4 text-lg font-semibold text-text-primary">
          {title}
        </h2>
        <p className="mt-2 text-sm text-text-secondary">
          {message}
        </p>
        <p className="mt-4 rounded-lg bg-surface-secondary px-4 py-2 font-mono text-xs text-text-muted">
          {wsClient.url}
        </p>
        {!isConnecting && (
          <div className="mt-5">
            <button
              type="button"
              onClick={() => wsClient.connect()}
              className="rounded-lg bg-kraki-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-kraki-600"
            >
              Connect now
            </button>
          </div>
        )}
        {isConnecting && (
          <div className="mt-5 flex items-center justify-center gap-2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-kraki-500 border-t-transparent" />
            <span className="text-sm text-text-muted">Connecting…</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function App() {
  useWebSocket();
  useSessionShortcuts();
  const inSession = useLocation().pathname.startsWith('/session/');
  const inDevices = useLocation().pathname === '/devices';
  const inSubPage = inSession || inDevices;
  const navigate = useNavigate();
  const navigateToSession = useStore((s) => s.navigateToSession);
  const setNavigateToSession = useStore((s) => s.setNavigateToSession);
  const status = useStore((s) => s.status);
  const reconnectAttempts = useStore((s) => s.reconnectAttempts);
  const nextReconnectDelayMs = useStore((s) => s.nextReconnectDelayMs);

  // First connect failure: show blocking dialog immediately
  // Reconnect: non-blocking indicator in header, blocking after max attempts
  const wasConnectedRef = useRef(false);
  if (status === 'connected') wasConnectedRef.current = true;

  const isReconnecting = wasConnectedRef.current && (status === 'disconnected' || (status === 'connecting' && reconnectAttempts > 0));
  const reconnectExhausted = isReconnecting && reconnectAttempts >= MAX_AUTO_RECONNECT_ATTEMPTS;
  const firstConnectFailed = !wasConnectedRef.current && (status === 'error' || status === 'disconnected');
  const showBlockingOverlay = firstConnectFailed || reconnectExhausted;

  // Update document.title with total unread count
  const unreadCount = useStore((s) => s.unreadCount);
  useEffect(() => {
    const BASE_TITLE = 'Kraki';
    let total = 0;
    for (const count of unreadCount.values()) total += count;
    document.title = total > 0 ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
  }, [unreadCount]);

  useEffect(() => {
    if (navigateToSession) {
      navigate(`/session/${navigateToSession}`);
      setNavigateToSession(null);
    }
  }, [navigateToSession, navigate, setNavigateToSession]);

  // Track visual viewport height for iOS PWA keyboard handling.
  // On iOS, `dvh` can desync with the actual visible area when the keyboard
  // shows/hides (especially with position:fixed on body). Using the visual
  // viewport API gives us the real height synchronously.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
    };
    update();
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, []);

  if (status === 'awaiting_login') {
    return (
      <div className="flex overflow-hidden bg-surface-primary" style={{ height: 'var(--app-height, 100dvh)' }}>
        <ErrorBanner />
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    );
  }

  return (
    <div className="flex overflow-hidden bg-surface-primary" style={{ height: 'var(--app-height, 100dvh)' }}>
      <ErrorBanner />
      <aside className="hidden w-72 shrink-0 flex-col border-r border-border-primary md:flex lg:w-80" aria-hidden={showBlockingOverlay}>
        <Sidebar />
      </aside>
      <aside className={`w-full shrink-0 flex-col md:hidden ${inSubPage ? 'hidden' : 'flex'}`} aria-hidden={showBlockingOverlay}>
        <Sidebar />
      </aside>
      <main className={`relative min-w-0 flex-1 flex-col overflow-hidden ${inSubPage ? 'flex' : 'hidden md:flex'}`} aria-hidden={showBlockingOverlay}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
      {showBlockingOverlay && (
        <RelayBlockingOverlay
          status={status}
          reconnectAttempts={reconnectAttempts}
          nextReconnectDelayMs={nextReconnectDelayMs}
        />
      )}
    </div>
  );
}
