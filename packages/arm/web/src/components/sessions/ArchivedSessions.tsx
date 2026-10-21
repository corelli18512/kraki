import { useTranslation } from 'react-i18next';
import { SettingsAlert } from '../layout/SettingsControls';
import { useMemo, useState } from 'react';
import { Archive, ChevronDown, ChevronRight } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';
import type { WebSessionSummary } from '../../types/store';
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
  const { t } = useTranslation(['sessions', 'common']);
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
        <span>{t('archive.heading', { count })}</span>
      </button>
      {open && rows.length === 0 && <p className="ksb-archived-hint">{t('archive.loading')}</p>}
      {open && rows.map(({ deviceId, digest }) => (
        <SessionRow
          key={digest.id}
          session={{
            id: digest.id,
            deviceId,
            deviceName: devices.get(deviceId)?.name ?? '',
            agent: digest.agent,
            model: digest.model,
            reasoningEffort: digest.reasoningEffort,
            createdAt: digest.createdAt,
            title: digest.title,
            autoTitle: digest.autoTitle,
            state: 'idle',
            messageCount: digest.messageCount,
            lastSeq: digest.lastSeq,
            readSeq: digest.readSeq,
          } as WebSessionSummary}
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
  const { t } = useTranslation(['sessions', 'common']);
  const info = useStore((s) => s.archiveInfo);
  const count = useArchivedCount();
  const [confirming, setConfirming] = useState(false);
  const deviceIds = [...info.keys()];
  if (deviceIds.length === 0) return null;
  const days = info.get(deviceIds[0])?.days ?? 14;

  return (
    <div className="space-y-2">
      <label className="kp-group kp-row" style={{ padding: '8px 10px' }}>
        <span>{t('archive.after')}</span>
        <select
          className="rounded-md bg-transparent px-2 text-[13px]"
          value={days}
          onChange={(e) => {
            const value = Number(e.target.value);
            for (const id of deviceIds) wsClient.setAutoArchiveDays(id, value);
          }}
        >
          {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{t('archive.days', { count: d })}</option>)}
          <option value={0}>{t('archive.never')}</option>
        </select>
      </label>
      <p className="kp-section-footer">{t('archive.detail')}</p>
      {count > 0 && !confirming && (
        <button type="button" className="text-sm text-red-500 hover:underline" onClick={() => setConfirming(true)}>
          {t('archive.delete', { count })}
        </button>
      )}
      {confirming && <SettingsAlert title={t('archive.deleteConfirm')} body="" confirm={t('common:action.delete')} onCancel={() => setConfirming(false)} onConfirm={() => {
        for (const [id, i] of info) if (i.count > 0) wsClient.deleteArchivedSessions(id);
        setConfirming(false);
      }} />}

    </div>
  );
}
