import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { Sidebar } from './components/layout/Sidebar';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { ErrorBanner } from './components/common/ErrorBanner';
import { SyncOverlay } from './components/common/SyncOverlay';
import { useWebSocket } from './hooks/useWebSocket';
import { useStore } from './hooks/useStore';
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
  const blocking = status === 'disconnected' || status === 'error' || (status === 'connecting' && reconnectAttempts > 0);
  if (!blocking) return null;

  const retriesPaused = reconnectAttempts >= MAX_AUTO_RECONNECT_ATTEMPTS && nextReconnectDelayMs === null && status !== 'connecting';
  const showManualConnect = retriesPaused;
  const title = status === 'error'
    ? 'Connection Error'
    : status === 'connecting'
      ? 'Reconnecting'
      : 'Disconnected';
  const message = status === 'error'
    ? 'Could not connect to the relay server. Make sure the head is running.'
    : status === 'connecting'
      ? 'Trying to reconnect to the relay server…'
      : 'Lost connection to the relay server. Reconnecting…';

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
        {showManualConnect && (
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
      </div>
    </div>
  );
}

export function App() {
  useWebSocket();
  const inSession = useLocation().pathname.startsWith('/session/');
  const navigate = useNavigate();
  const navigateToSession = useStore((s) => s.navigateToSession);
  const setNavigateToSession = useStore((s) => s.setNavigateToSession);
  const status = useStore((s) => s.status);
  const reconnectAttempts = useStore((s) => s.reconnectAttempts);
  const nextReconnectDelayMs = useStore((s) => s.nextReconnectDelayMs);
  const relayBlocked = status === 'disconnected' || status === 'error' || (status === 'connecting' && reconnectAttempts > 0);

  useEffect(() => {
    if (navigateToSession) {
      navigate(`/session/${navigateToSession}`);
      setNavigateToSession(null);
    }
  }, [navigateToSession, navigate, setNavigateToSession]);

  if (status === 'awaiting_login') {
    return (
      <div className="flex h-dvh overflow-hidden bg-surface-primary">
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
    <div className="flex h-dvh overflow-hidden bg-surface-primary">
      <ErrorBanner />
      <aside className="hidden w-72 shrink-0 flex-col border-r border-border-primary md:flex lg:w-80" aria-hidden={relayBlocked}>
        <Sidebar />
      </aside>
      <aside className={`w-full shrink-0 flex-col md:hidden ${inSession ? 'hidden' : 'flex'}`} aria-hidden={relayBlocked}>
        <Sidebar />
      </aside>
      <main className={`relative min-w-0 flex-1 flex-col overflow-hidden ${inSession ? 'flex' : 'hidden md:flex'}`} aria-hidden={relayBlocked}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
      <RelayBlockingOverlay
        status={status}
        reconnectAttempts={reconnectAttempts}
        nextReconnectDelayMs={nextReconnectDelayMs}
      />
      <SyncOverlay />
    </div>
  );
}
