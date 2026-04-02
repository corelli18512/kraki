import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
        <div className="relative">
          <AgentAvatar agent={session.agent} size="sm" status={session.state as 'active' | 'idle'} />
          {isReconnecting && (
            <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/30">
              <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-amber-400 border-t-transparent" />
            </div>
          )}
        </div>
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
          <ModeSelector sessionId={sessionId} currentMode={sessionMode as 'safe' | 'plan' | 'execute' | 'delegate'} />
        )}
      </div>

      <ChatView />
    </div>
  );
}

// ── Mode selector with sliding pill ──────────────────────

const MODES = ['safe', 'plan', 'execute', 'delegate'] as const;

const MODE_COLORS: Record<typeof MODES[number], { pill: string; text: string }> = {
  safe:     { pill: 'bg-emerald-400/80 dark:bg-emerald-500/60', text: 'text-emerald-900 dark:text-emerald-100' },
  plan:     { pill: 'bg-ocean-400/80 dark:bg-ocean-500/60',     text: 'text-ocean-900 dark:text-ocean-100' },
  execute:  { pill: 'bg-amber-400/80 dark:bg-amber-500/60',     text: 'text-amber-900 dark:text-amber-100' },
  delegate: { pill: 'bg-kraki-400/80 dark:bg-kraki-500/60',     text: 'text-kraki-900 dark:text-kraki-100' },
};

function ModeSelector({ sessionId, currentMode }: { sessionId: string; currentMode: typeof MODES[number] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mobileContainerRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState({ left: 0, width: 0 });
  const [mobilePill, setMobilePill] = useState<{ left: number; width: number } | null>(null);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [mobileClosing, setMobileClosing] = useState(false);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const activeIdx = MODES.indexOf(currentMode);
  const colors = MODE_COLORS[currentMode];

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const btn = container.querySelectorAll('button')[activeIdx] as HTMLElement;
    if (btn) {
      setPill({ left: btn.offsetLeft, width: btn.offsetWidth });
    }
  }, [activeIdx]);

  useLayoutEffect(() => {
    if (!mobileExpanded) {
      setMobilePill(null);
      return;
    }
    const container = mobileContainerRef.current;
    if (!container) return;
    const btn = container.querySelectorAll('button')[activeIdx] as HTMLElement;
    if (btn) {
      setMobilePill({ left: btn.offsetLeft, width: btn.offsetWidth });
    }
  }, [activeIdx, mobileExpanded]);

  const closeMobile = () => {
    setMobileClosing(true);
    setTimeout(() => {
      setMobileExpanded(false);
      setMobileClosing(false);
    }, 200);
  };

  // Auto-collapse on mobile after 3s
  useEffect(() => {
    if (mobileExpanded && !mobileClosing) {
      collapseTimerRef.current = setTimeout(closeMobile, 3000);
      return () => clearTimeout(collapseTimerRef.current);
    }
  }, [mobileExpanded, mobileClosing, currentMode]);

  const handleMobileSelect = (mode: typeof MODES[number]) => {
    wsClient.setSessionMode(sessionId, mode);
    clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = setTimeout(closeMobile, 3000);
  };

  return (
    <>
      {/* Desktop */}
      <div ref={containerRef} className="relative hidden items-center rounded-full bg-surface-secondary p-0.5 sm:flex">
        <div
          className={`absolute top-0.5 h-[calc(100%-4px)] rounded-full shadow-sm transition-all duration-300 ease-in-out ${colors.pill}`}
          style={{ left: pill.left, width: pill.width }}
        />
        {MODES.map((mode) => (
          <button
            key={mode}
            onClick={() => wsClient.setSessionMode(sessionId, mode)}
            className={`relative z-10 px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors duration-200 ${
              currentMode === mode ? colors.text : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {mode.charAt(0).toUpperCase() + mode.slice(1)}
          </button>
        ))}
      </div>

      {/* Mobile: collapsed = selected pill only */}
      {!mobileExpanded && (
        <button
          onClick={() => setMobileExpanded(true)}
          className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium sm:hidden ${colors.pill} ${colors.text}`}
        >
          {currentMode.charAt(0).toUpperCase() + currentMode.slice(1)}
        </button>
      )}

      {/* Mobile: expanded = all modes with sliding pill */}
      {mobileExpanded && (
        <div className={`absolute inset-0 flex items-center justify-end bg-gradient-to-l from-surface-primary via-surface-primary to-transparent pl-12 pr-4 sm:hidden ${mobileClosing ? 'animate-slide-out-right' : 'animate-slide-in-right'}`}>
          <div ref={mobileContainerRef} className="relative flex items-center rounded-full bg-surface-secondary p-0.5">
            {mobilePill && (
              <div
                className={`absolute top-0.5 h-[calc(100%-4px)] rounded-full shadow-sm transition-all duration-300 ease-in-out ${colors.pill}`}
                style={{ left: mobilePill.left, width: mobilePill.width }}
              />
            )}
            {MODES.map((mode) => (
              <button
                key={mode}
                onClick={() => handleMobileSelect(mode)}
                className={`relative z-10 px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors duration-200 ${
                  currentMode === mode ? colors.text : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
