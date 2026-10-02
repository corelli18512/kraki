import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Archive, ChevronDown, ChevronRight } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';

/** Total archived sessions across this account's computers. */
export function useArchivedCount(): number {
  const info = useStore((s) => s.archiveInfo);
  return useMemo(() => [...info.values()].reduce((sum, i) => sum + i.count, 0), [info]);
}

function relativeDays(iso?: string): string {
  if (!iso) return '';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days) || days < 1) return 'today';
  if (days < 60) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/**
 * Collapsed "Archived (N)" group at the bottom of the session list (F2).
 * Archived sessions are not sent with the session list; opening the group
 * asks each computer for its archived sessions. Opening one restores it.
 */
export function ArchivedSessions() {
  const count = useArchivedCount();
  const info = useStore((s) => s.archiveInfo);
  const archived = useStore((s) => s.archivedSessions);
  const devices = useStore((s) => s.devices);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  if (count === 0) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      for (const [deviceId, i] of info) if (i.count > 0) wsClient.requestArchivedSessions(deviceId);
    }
  };

  const rows = [...archived.entries()]
    .flatMap(([deviceId, sessions]) => sessions.map((s) => ({ deviceId, session: s })))
    .sort((a, b) => (b.session.lastActivityAt ?? '').localeCompare(a.session.lastActivityAt ?? ''));
  const loading = open && rows.length === 0;

  return (
    <div className="ksb-archived">
      <button type="button" className="ksb-archived-toggle" aria-expanded={open} onClick={toggle}>
        {open ? <ChevronDown /> : <ChevronRight />}
        <Archive />
        <span>Archived ({count})</span>
      </button>
      {open && (
        <div className="ksb-archived-list" role="list">
          {loading && <p className="ksb-archived-hint">Loading…</p>}
          {rows.map(({ deviceId, session }) => (
            <button
              key={session.id}
              type="button"
              role="listitem"
              className="ksb-archived-row"
              onClick={() => {
                wsClient.openArchivedSession(deviceId, session);
                navigate(`/session/${session.id}`);
              }}
            >
              <span className="ksb-archived-title">{session.title || session.autoTitle || 'Untitled session'}</span>
              <span className="ksb-archived-meta">
                {devices.size > 1 ? `${devices.get(deviceId)?.name ?? ''} · ` : ''}{relativeDays(session.lastActivityAt)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Settings: auto-archive days and deleting archived sessions (F2). */
export function ArchiveSettings() {
  const info = useStore((s) => s.archiveInfo);
  const count = useArchivedCount();
  const [confirming, setConfirming] = useState(false);
  const deviceIds = [...info.keys()];
  if (deviceIds.length === 0) return null;
  const days = info.get(deviceIds[0])?.days ?? 14;

  return (
    <div className="space-y-2">
      <label className="flex items-center justify-between gap-3 text-sm text-text-primary">
        <span>Archive sessions after</span>
        <select
          className="rounded-md border border-border-primary bg-surface-secondary px-2 py-1 text-sm"
          value={days}
          onChange={(e) => {
            const value = Number(e.target.value);
            for (const id of deviceIds) wsClient.setAutoArchiveDays(id, value);
          }}
        >
          {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days without messages</option>)}
          <option value={0}>Never</option>
        </select>
      </label>
      <p className="text-xs text-text-muted">Pinned sessions are never archived. Opening an archived session brings it back.</p>
      {count > 0 && !confirming && (
        <button type="button" className="text-sm text-red-500 hover:underline" onClick={() => setConfirming(true)}>
          Delete {count} archived session{count === 1 ? '' : 's'}…
        </button>
      )}
      {confirming && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-text-secondary">Delete {count} archived session{count === 1 ? '' : 's'} from your computers? This can't be undone.</span>
          <button
            type="button"
            className="text-red-500 hover:underline"
            onClick={() => {
              for (const [id, i] of info) if (i.count > 0) wsClient.deleteArchivedSessions(id);
              setConfirming(false);
            }}
          >
            Delete
          </button>
          <button type="button" className="text-text-secondary hover:underline" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
