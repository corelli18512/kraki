import { formatDateTime } from '../../i18n/format';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { sessionDisplayTitle } from '../../lib/session-status';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';
import type { DeviceSummary, AgentCapabilities } from '@kraki/protocol';
import { displayVersion } from '../../lib/device-update';
import { desktop } from '../../lib/desktop';
import { DeviceUpdateBox } from './DeviceUpdateBox';

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const normalized = iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return '—';
  return formatDateTime(d, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function DevicePanel({
  device,
  models,
  agents,
  version,
  isCurrentDevice,
  selectedSessionId,
  onSelectSession,
  onClose,
}: {
  device: DeviceSummary;
  models?: string[];
  agents?: AgentCapabilities[];
  version?: string;
  isCurrentDevice: boolean;
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('devices');
  const deviceUpdates = useStore((s) => s.deviceUpdates);
  const deviceVersions = useStore((s) => s.deviceVersions);
  const shownVersion = displayVersion(device.id, deviceUpdates, deviceVersions) ?? version;

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [builtInId, setBuiltInId] = useState<string | null>(null);
  const [builtInKnown, setBuiltInKnown] = useState(!desktop?.builtIn);
  const [identityError, setIdentityError] = useState(false);
  useEffect(() => { void desktop?.builtIn?.state().then((s) => { setBuiltInId(s.deviceId); setBuiltInKnown(true); }).catch(() => setIdentityError(true)); }, []);

  const sessions = useStore((s) => s.sessions);

  const deviceSessions = [...sessions.values()].filter((s) => s.deviceId === device.id);
  const canRemove = builtInKnown && !device.online && !isCurrentDevice && device.id !== builtInId;
  const hasGreeting = models && models.length > 0;

  const statusDot = device.online && hasGreeting
    ? 'bg-emerald-400'
    : device.online
      ? 'animate-pulse bg-amber-400'
      : 'bg-slate-400';
  const statusLabel = device.online && hasGreeting
    ? t('panel.online')
    : device.online
      ? t('panel.connecting')
      : t('panel.offline');

  const handleRemove = () => {
    wsClient.removeDevice(device.id);
    setConfirmOpen(false);
    onClose();
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-center gap-2 px-5 py-3 min-w-0">
        <button
          onClick={onClose}
          className="mr-0.5 text-text-secondary hover:text-text-primary sm:hidden"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className={`h-2 w-2 shrink-0 rounded-full ${statusDot}`} />
        <h2 className="truncate text-sm font-semibold text-text-primary">{device.name}</h2>
        <span className="text-[11px] text-text-muted">{statusLabel}</span>
        {isCurrentDevice && (
          <span className="rounded-full bg-kraki-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-kraki-600 dark:text-kraki-400">
            {t('panel.thisDevice')}
          </span>
        )}
        {canRemove && <button type="button" onClick={() => setConfirmOpen(true)} className="rounded-md px-2 py-0.5 text-[11px] font-medium text-red-500 hover:bg-red-500/10">{t('panel.removeAction')}</button>}
      </div>

      <div className="space-y-4 px-5 pb-4">
        {identityError && <p role="alert" className="text-xs text-text-muted">{t('panel.identityError')}</p>}
        {/* Device info */}
        <div className="space-y-1.5">
          <div className="flex justify-between text-[11px]">
            <span className="text-text-muted">{t('panel.added')}</span>
            <span className="text-text-secondary">{formatDate(device.createdAt)}</span>
          </div>
          <div className="flex justify-between text-[11px]">
            <span className="text-text-muted">{t('panel.lastOnline')}</span>
            <span className="text-text-secondary">{device.online ? t('panel.now') : formatDate(device.lastSeen)}</span>
          </div>
          {shownVersion && (
            <div className="flex justify-between text-[11px]">
              <span className="text-text-muted">{t('panel.version')}</span>
              <span className="text-text-secondary">{shownVersion}</span>
            </div>
          )}
        </div>

        <DeviceUpdateBox device={device} />

        {/* Agents & Models */}
        {agents && agents.length > 0 ? (
          <div>
            <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">{t('panel.agents')}</h3>
            <div className="space-y-2">
              {agents.map((agent) => (
                <div key={agent.id}>
                  <div className="mb-1 text-xs font-medium capitalize text-text-secondary">{agent.id}</div>
                  <div className="flex flex-wrap gap-1">
                    {(agent.models ?? []).map((m) => (
                      <span key={m} className="rounded-full bg-surface-secondary px-2 py-0.5 text-[10px] text-text-secondary">
                        {m}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : models && models.length > 0 ? (
          <div>
            <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">{t('panel.models')}</h3>
            <div className="flex flex-wrap gap-1">
              {models.map((m) => (
                <span key={m} className="rounded-full bg-surface-secondary px-2 py-0.5 text-[10px] text-text-secondary">
                  {m}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {/* Sessions */}
        <div>
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            {deviceSessions.length > 0 ? t('panel.sessionsCount', { count: deviceSessions.length }) : t('panel.sessions')}
          </h3>
          {deviceSessions.length > 0 ? (
            <div className="space-y-1">
              {deviceSessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => onSelectSession(s.id)}
                  className={`flex w-full items-center gap-1.5 rounded-lg border border-border-primary px-2.5 py-1.5 text-left text-[11px] transition-colors ${
                    selectedSessionId === s.id
                      ? 'bg-surface-tertiary text-text-primary font-medium'
                      : 'bg-surface-secondary text-text-secondary hover:bg-surface-tertiary hover:text-text-primary'
                  }`}
                >
                  <span className="truncate">{sessionDisplayTitle(s)}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-text-muted">{t('panel.none')}</p>
          )}
        </div>
      </div>

      {/* Confirm remove dialog */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setConfirmOpen(false)}
          onKeyDown={(e) => e.key === 'Escape' && setConfirmOpen(false)}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
        >
          <div
            className="mx-4 w-full max-w-sm rounded-xl border border-border-primary bg-surface-primary p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-text-primary">{t('panel.removeTitle', { name: device.name })}</h3>
            <p className="mt-2 text-xs text-text-secondary">
              {t('panel.removeDetail')}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmOpen(false)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-tertiary"
              >
                {t('panel.cancel')}
              </button>
              <button
                onClick={handleRemove}
                className="rounded-lg bg-red-700 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-800"
              >
                {t('panel.remove')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
