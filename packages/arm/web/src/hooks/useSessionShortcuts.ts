import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useStore } from './useStore';

/**
 * Cmd+Up / Cmd+Down (Mac) or Ctrl+Up / Ctrl+Down (Windows/Linux)
 * to switch between sessions in the sorted session list order.
 */
export function useSessionShortcuts() {
  const navigate = useNavigate();
  const params = useParams<{ sessionId: string }>();
  const sessions = useStore((s) => s.sessions);
  const pinnedSessions = useStore((s) => s.pinnedSessions);
  const messages = useStore((s) => s.messages);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;

      const sorted = [...sessions.values()].sort((a, b) => {
        const aPinned = pinnedSessions.has(a.id) ? 0 : 1;
        const bPinned = pinnedSessions.has(b.id) ? 0 : 1;
        if (aPinned !== bPinned) return aPinned - bPinned;
        const aLast = messages.get(a.id);
        const bLast = messages.get(b.id);
        const aTime = aLast?.length ? aLast[aLast.length - 1] : null;
        const bTime = bLast?.length ? bLast[bLast.length - 1] : null;
        const aTs = aTime && 'timestamp' in aTime ? aTime.timestamp : '';
        const bTs = bTime && 'timestamp' in bTime ? bTime.timestamp : '';
        if (aTs !== bTs) return bTs.localeCompare(aTs);
        return a.id.localeCompare(b.id);
      });

      if (sorted.length === 0) return;

      e.preventDefault();

      const currentId = params.sessionId;
      const currentIdx = currentId ? sorted.findIndex((s) => s.id === currentId) : -1;

      let nextIdx: number;
      if (e.key === 'ArrowUp') {
        nextIdx = currentIdx <= 0 ? sorted.length - 1 : currentIdx - 1;
      } else {
        nextIdx = currentIdx >= sorted.length - 1 ? 0 : currentIdx + 1;
      }

      navigate(`/session/${sorted[nextIdx].id}`);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sessions, pinnedSessions, messages, params.sessionId, navigate]);
}
