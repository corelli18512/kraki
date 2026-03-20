import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useStore } from '../../hooks/useStore';

export function ActionQueue() {
  const permissionsMap = useStore((s) => s.pendingPermissions);
  const questionsMap = useStore((s) => s.pendingQuestions);
  const navigate = useNavigate();

  const permissions = useMemo(() => [...permissionsMap.values()], [permissionsMap]);
  const questions = useMemo(() => [...questionsMap.values()], [questionsMap]);
  const total = permissions.length + questions.length;

  if (total === 0) return null;

  // Group by session
  const sessionIds = new Set([
    ...permissions.map((p) => p.sessionId),
    ...questions.map((q) => q.sessionId),
  ]);

  return (
    <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2">
      <div className="mx-auto flex max-w-3xl items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[11px] font-bold text-white">
            {total}
          </span>
          <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
            {total === 1 ? '1 action' : `${total} actions`} pending
            {sessionIds.size > 1 && ` across ${sessionIds.size} sessions`}
          </span>
        </div>
        {sessionIds.size === 1 && (
          <button
            onClick={() => navigate(`/session/${[...sessionIds][0]}`)}
            className="text-xs font-medium text-amber-600 hover:text-amber-500 dark:text-amber-400"
          >
            View →
          </button>
        )}
      </div>
    </div>
  );
}
