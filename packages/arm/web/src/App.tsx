import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { Sidebar } from './components/layout/Sidebar';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { ErrorBanner } from './components/common/ErrorBanner';
import { useWebSocket } from './hooks/useWebSocket';
import { useStore } from './hooks/useStore';

export function App() {
  useWebSocket();
  const inSession = useLocation().pathname.startsWith('/session/');
  const navigate = useNavigate();
  const navigateToSession = useStore((s) => s.navigateToSession);
  const setNavigateToSession = useStore((s) => s.setNavigateToSession);
  const status = useStore((s) => s.status);

  useEffect(() => {
    if (navigateToSession) {
      navigate(`/session/${navigateToSession}`);
      setNavigateToSession(null);
    }
  }, [navigateToSession, navigate, setNavigateToSession]);

  // Full-screen layout for login (no sidebar needed)
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
      {/* Desktop sidebar — always visible */}
      <aside className="hidden w-72 shrink-0 flex-col border-r border-border-primary md:flex lg:w-80">
        <Sidebar />
      </aside>
      {/* Mobile: show sidebar OR content (WeChat-style) */}
      <aside className={`w-full shrink-0 flex-col md:hidden ${inSession ? 'hidden' : 'flex'}`}>
        <Sidebar />
      </aside>
      {/* Main content */}
      <main className={`relative min-w-0 flex-1 flex-col overflow-hidden ${inSession ? 'flex' : 'hidden md:flex'}`}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
