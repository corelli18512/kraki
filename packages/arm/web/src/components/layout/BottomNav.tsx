import { useLocation, useNavigate } from 'react-router';
import { useMemo } from 'react';
import { useStore } from '../../hooks/useStore';

export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const permissionsMap = useStore((s) => s.pendingPermissions);
  const questionsMap = useStore((s) => s.pendingQuestions);
  const totalPending = permissionsMap.size + questionsMap.size;
  const isHome = location.pathname === '/';
  const inSession = location.pathname.startsWith('/session/');

  const firstActionSessionId = useMemo(() => {
    const first = permissionsMap.values().next().value ?? questionsMap.values().next().value;
    return first?.sessionId;
  }, [permissionsMap, questionsMap]);

  const isOnActionSession = inSession && firstActionSessionId && location.pathname.includes(firstActionSessionId);

  return (
    <nav className="flex h-14 shrink-0 items-center justify-around border-t border-border-primary bg-surface-primary md:hidden" role="tablist">
      <button
        onClick={() => navigate('/')}
        aria-label="Sessions"
        role="tab"
        aria-selected={isHome}
        className={`flex flex-col items-center gap-0.5 px-4 py-1 ${
          isHome ? 'text-kraki-500' : 'text-text-secondary'
        }`}
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
        <span className="text-[10px] font-medium">Sessions</span>
      </button>
      <button
        onClick={() => {
          if (firstActionSessionId) navigate(`/session/${firstActionSessionId}`);
        }}
        aria-label={`Actions, ${totalPending} pending`}
        role="tab"
        aria-selected={!!isOnActionSession}
        className={`relative flex flex-col items-center gap-0.5 px-4 py-1 ${
          isOnActionSession ? 'text-kraki-500' : 'text-text-secondary'
        }`}
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {totalPending > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
            {totalPending}
          </span>
        )}
        <span className="text-[10px] font-medium">Actions</span>
      </button>
    </nav>
  );
}
