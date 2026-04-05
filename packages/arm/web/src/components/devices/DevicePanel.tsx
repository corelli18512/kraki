import { useState } from 'react';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';
import type { DeviceSummary } from '@kraki/protocol';
import { X } from 'lucide-react';

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const normalized = iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function DevicePanel({
  device,
  models,
  isCurrentDevice,
  selectedSessionId,
  onSelectSession,
  onClose,
}: {
  device: DeviceSummary;
  models?: string[];
  isCurrentDevice: boolean;
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  onClose: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const sessions = useStore((s) => s.sessions);

  const deviceSessions = [...sessions.values()].filter((s) => s.deviceId === device.id);
  const canRemove = !device.online && !isCurrentDevice;
  const hasGreeting = models && models.length > 0;

  const statusDot = device.online && hasGreeting
    ? 'bg-emerald-400'
    : device.online
      ? 'animate-pulse bg-amber-400'
      : 'bg-slate-400';
  const statusLabel = device.online && hasGreeting
    ? 'online'
    : device.online
      ? 'connecting…'
      : 'offline';

  const handleRemove = () => {
    wsClient.send({ type: 'remove_device', deviceId: device.id });
    setConfirmOpen(false);
    onClose();
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${statusDot}`} />
            <h2 className="truncate text-sm font-semibold text-text-primary">{device.name}</h2>
            <span className="text-[11px] text-text-muted">{statusLabel}</span>
            {isCurrentDevice && (
              <span className="rounded-full bg-kraki-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-kraki-600 dark:text-kraki-400">
                This device
              </span>
            )}
            {!isCurrentDevice && (
              <span className="relative flex items-center">
                <button
                  onClick={() => canRemove ? setConfirmOpen(true) : setShowTooltip((v) => !v)}
                  onMouseEnter={() => !canRemove && setShowTooltip(true)}
                  onMouseLeave={() => setShowTooltip(false)}
                  className={`peer rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    canRemove ? 'text-red-500 hover:bg-red-500/10' : 'text-text-muted opacity-50'
                  }`}
                >
                  Remove
                </button>
                {!canRemove && showTooltip && (
                  <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-1 -translate-y-1/2 whitespace-nowrap rounded-md bg-surface-tertiary px-2 py-1 text-[10px] text-text-secondary shadow-lg">
                    Disconnect the device first
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-tertiary hover:text-text-primary sm:hidden"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-4 px-5 pb-4">
        {/* Device info */}
        <div className="space-y-1.5">
          <div className="flex justify-between text-[11px]">
            <span className="text-text-muted">Added</span>
            <span className="text-text-secondary">{formatDate(device.createdAt)}</span>
          </div>
          <div className="flex justify-between text-[11px]">
            <span className="text-text-muted">Last online</span>
            <span className="text-text-secondary">{device.online ? 'Now' : formatDate(device.lastSeen)}</span>
          </div>
        </div>

        {/* Models */}
        {models && models.length > 0 && (
          <div>
            <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Supported Models</h3>
            <div className="flex flex-wrap gap-1">
              {models.map((m) => (
                <span key={m} className="rounded-full bg-surface-secondary px-2 py-0.5 text-[10px] text-text-secondary">
                  {m}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Sessions */}
        <div>
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            Sessions{deviceSessions.length > 0 ? ` (${deviceSessions.length})` : ''}
          </h3>
          {deviceSessions.length > 0 ? (
            <div className="space-y-0.5">
              {deviceSessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => onSelectSession(s.id)}
                  className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] transition-colors ${
                    selectedSessionId === s.id
                      ? 'bg-ocean-500/15 text-ocean-400 font-medium'
                      : 'text-text-secondary hover:bg-surface-tertiary hover:text-text-primary'
                  }`}
                >
                  <span className="truncate">{s.title ?? s.autoTitle ?? `${s.agent}${s.model ? ` · ${s.model}` : ''}`}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-text-muted">No sessions on this device</p>
          )}
        </div>
      </div>

      {/* Confirm remove dialog */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            className="mx-4 w-full max-w-sm rounded-xl border border-border-primary bg-surface-primary p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-text-primary">Remove device</h3>
            <p className="mt-2 text-xs text-text-secondary">
              Are you sure you want to remove <strong>{device.name}</strong>? This action is permanent
              and cannot be undone. The device will need to reconnect and re-authenticate to appear again.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmOpen(false)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-tertiary"
              >
                Cancel
              </button>
              <button
                onClick={handleRemove}
                className="rounded-lg bg-red-700 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-800"
              >
                Remove permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
