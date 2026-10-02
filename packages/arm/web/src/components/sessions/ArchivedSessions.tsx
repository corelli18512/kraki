import { useMemo, useState } from 'react';
import { Archive, ChevronDown, ChevronRight } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';
import type { SessionSummary } from '@kraki/protocol';
import { SessionRow } from './SessionRow';

/** Total archived sessions across this account's computers. */
export function useArchivedCount(): number {
  const info = useStore((s) => s.archiveInfo);
  return useMemo(() => [...info.values()].reduce((sum, i) => sum + i.count, 0), [info]);
}

/**
 * Collapsed "Archived (N)" group at the bottom of the session list (F2).
 * Archived sessions are not sent with the session list; expanding the group
 * asks each computer for them and shows them as normal session rows.
 * Opening one restores it.
 */
export function ArchivedSessions({ narrow, selectedId }: { narrow: boolean; selectedId?: string }) {
  const count = useArchivedCount();
  const info = useStore((s) => s.archiveInfo);
  const archived = useStore((s) => s.archivedSessions);
  const devices = useStore((s) => s.devices);
  const [open, setOpen] = useState(false);

  const rows = useMemo(() => [...archived.entries()]
    .flatMap(([deviceId, sessions]) => sessions.map((s) => ({ deviceId, digest: s })))
    .sort((a, b) => (b.digest.lastActivityAt ?? '').localeCompare(a.digest.lastActivityAt ?? '')), [archived]);

  if (count === 0) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      for (const [deviceId, i] of info) if (i.count > 0) wsClient.requestArchivedSessions(deviceId);
    }
  };

  return (
    <div className="ksb-archived">
      <button type="button" className="ksb-archived-toggle" aria-expanded={open} onClick={toggle}>
        {open ? <ChevronDown /> : <ChevronRight />}
        <Archive />
        <span>Archived ({count})</span>
      </button>
      {open && rows.length === 0 && <p className="ksb-archived-hint">Loading…</p>}
      {open && rows.map(({ deviceId, digest }) => (
        <SessionRow
          key={digest.id}
          session={{
            id: digest.id,
            deviceId,
            deviceName: devices.get(deviceId)?.name ?? '',
            agent: digest.agent,
            model: digest.model,
            title: digest.title,
            autoTitle: digest.autoTitle,
            state: 'idle',
            messageCount: digest.messageCount,
            lastSeq: digest.lastSeq,
            readSeq: digest.readSeq,
          } as SessionSummary}
          selected={digest.id === selectedId}
          pinned={false}
          narrow={narrow}
          archived={{
            preview: digest.preview,
            onOpen: () => wsClient.openArchivedSession(deviceId, digest),
          }}
        />
      ))}
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
