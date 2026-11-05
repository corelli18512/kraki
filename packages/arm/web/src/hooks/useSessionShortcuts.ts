import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useStore } from './useStore';
import { requestComposerFocus } from '../components/sessions/NewSessionComposer';
import { sortSessionsForList } from '../lib/chat/session-card';

/** Inside a text field Cmd/Ctrl+Up/Down first moves the caret to the start or
 *  end; only once it is there does the shortcut switch session. */
function caretCanMove(target: EventTarget | null, key: string): boolean {
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (!(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) return false;
  const { selectionStart, selectionEnd, value } = target;
  if (selectionStart === null || selectionEnd === null) return false;
  return key === 'ArrowUp' ? selectionEnd > 0 : selectionStart < value.length;
}

/**
 * Cmd+Up / Cmd+Down (Mac) or Ctrl+Up / Ctrl+Down (Windows/Linux)
 * to switch between sessions in the sidebar order.
 */
export function useSessionShortcuts() {
  const navigate = useNavigate();
  const params = useParams<{ sessionId: string }>();
  const sessions = useStore((s) => s.sessions);
  const pinnedSessions = useStore((s) => s.pinnedSessions);
  const sessionPreviews = useStore((s) => s.sessionPreviews);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Ctrl/Cmd+N: new session — the composer in the idle pane (wide layout).
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n' && window.innerWidth >= 768) {
        e.preventDefault();
        requestComposerFocus();
        if (params.sessionId) navigate('/');
        return;
      }
      if (!mod || e.shiftKey || e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      if (caretCanMove(e.target, e.key)) return;

      const sorted = sortSessionsForList(sessions.values(), pinnedSessions, sessionPreviews);

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
  }, [sessions, pinnedSessions, sessionPreviews, params.sessionId, navigate]);
}
