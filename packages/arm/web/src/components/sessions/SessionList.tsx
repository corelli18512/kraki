import { useState } from 'react';
import { useStore } from '../../hooks/useStore';
import { SessionCard } from './SessionCard';
import { NewSessionDialog } from './NewSessionDialog';
import { ImportSessionDialog } from './ImportSessionDialog';
import { Download } from 'lucide-react';

export function SessionList() {
  const sessions = useStore((s) => s.sessions);
  const pinnedSessions = useStore((s) => s.pinnedSessions);
  const sessionPreviews = useStore((s) => s.sessionPreviews);
  const devices = useStore((s) => s.devices);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [openSwipeId, setOpenSwipeId] = useState<string | null>(null);

  const hasTentacle = [...devices.values()].some((d) => d.role === 'tentacle' && d.online);

  const sorted = [...sessions.values()].sort((a, b) => {
    // Pinned first
    const aPinned = pinnedSessions.has(a.id) ? 0 : 1;
    const bPinned = pinnedSessions.has(b.id) ? 0 : 1;
    if (aPinned !== bPinned) return aPinned - bPinned;

    // Then by most recent preview timestamp (newest first)
    const aTs = sessionPreviews.get(a.id)?.timestamp ?? '';
    const bTs = sessionPreviews.get(b.id)?.timestamp ?? '';
    if (aTs !== bTs) return bTs.localeCompare(aTs);

    // Fallback: alphabetical by ID
    return a.id.localeCompare(b.id);
  });

  if (sorted.length === 0) {
    return (
      <>
        <div className="flex flex-col items-center justify-center p-8 text-center">
          <img src="/logo.png" alt="Kraki" className="mb-2 h-10 w-10 object-contain" />
          <p className="text-sm text-text-secondary">No sessions yet</p>
          <p className="mt-1 text-xs text-text-muted">
            {hasTentacle
              ? 'Start a coding agent on your connected device'
              : 'Connect an agent via tentacle to get started'}
          </p>
          {hasTentacle && (
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => setDialogOpen(true)}
                className="rounded-lg bg-kraki-500 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-kraki-600"
              >
                + New Session
              </button>
              <button
                onClick={() => setImportOpen(true)}
                title="Import local session"
                className="rounded-lg border border-border-primary bg-surface-secondary px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-tertiary hover:text-text-primary"
              >
                <Download className="inline h-3.5 w-3.5 -mt-0.5 mr-1" />
                Import
              </button>
            </div>
          )}
          {!hasTentacle && (
            <code className="mt-3 rounded bg-surface-tertiary px-2.5 py-1 text-[11px] text-text-secondary">
              npx @kraki/tentacle
            </code>
          )}
        </div>
        <NewSessionDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
        <ImportSessionDialog open={importOpen} onClose={() => setImportOpen(false)} />
      </>
    );
  }

  const pinnedList = sorted.filter((s) => pinnedSessions.has(s.id));
  const unpinnedList = sorted.filter((s) => !pinnedSessions.has(s.id));

  return (
    <>
      <div className="p-2">
        <div className="mb-1.5 flex items-center justify-between px-1">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            Sessions
          </h3>
          <div className="flex items-center gap-0.5">
            {hasTentacle && (
              <button
                onClick={() => setImportOpen(true)}
                title="Import local session"
                className="rounded p-0.5 text-text-muted transition-colors hover:bg-surface-tertiary hover:text-text-primary"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              onClick={() => setDialogOpen(true)}
              title="New session"
              className="rounded p-0.5 text-text-muted transition-colors hover:bg-surface-tertiary hover:text-text-primary"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </button>
          </div>
        </div>
      {pinnedList.length > 0 && (
        <div className="mb-1 space-y-1">
          {pinnedList.map((session) => (
            <SessionCard key={session.id} session={session} pinned openSwipeId={openSwipeId} setOpenSwipeId={setOpenSwipeId} />
          ))}
        </div>
      )}
      <div className="space-y-1">
        {unpinnedList.map((session) => (
          <SessionCard key={session.id} session={session} openSwipeId={openSwipeId} setOpenSwipeId={setOpenSwipeId} />
        ))}
      </div>
    </div>
    <NewSessionDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    <ImportSessionDialog open={importOpen} onClose={() => setImportOpen(false)} />
  </>
  );
}
