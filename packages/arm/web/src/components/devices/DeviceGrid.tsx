import { useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { useStore } from '../../hooks/useStore';
import { DevicePanel } from './DevicePanel';
import { SessionInfoPanel } from './SessionInfoPanel';
import type { DeviceSummary } from '@kraki/protocol';

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches,
  );
  useState(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(min-width: 640px)');
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  });
  return isDesktop;
}

export function DeviceGrid() {
  const devices = useStore((s) => s.devices);
  const deviceModels = useStore((s) => s.deviceModels);
  const deviceModelDetails = useStore((s) => s.deviceModelDetails);
  const sessionUsage = useStore((s) => s.sessionUsage);
  const sessions = useStore((s) => s.sessions);
  const myDeviceId = useStore((s) => s.deviceId);
  const [searchParams] = useSearchParams();
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(searchParams.get('device'));
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(searchParams.get('session'));
  const isDesktop = useIsDesktop();

  const tentacles = [...devices.values()]
    .filter((d) => d.role === 'tentacle')
    .sort((a, b) => a.name.localeCompare(b.name));

  // Desktop: auto-select first device + first session. Mobile: user navigates.
  const effectiveDeviceId = selectedDeviceId && devices.has(selectedDeviceId)
    ? selectedDeviceId
    : isDesktop && tentacles.length > 0 ? tentacles[0].id : null;
  const selectedDevice = effectiveDeviceId ? devices.get(effectiveDeviceId) : undefined;

  const deviceSessions = useMemo(
    () => selectedDevice ? [...sessions.values()].filter((s) => s.deviceId === selectedDevice.id) : [],
    [sessions, selectedDevice],
  );
  const effectiveSessionId = selectedSessionId && sessions.has(selectedSessionId)
    ? selectedSessionId
    : isDesktop && deviceSessions.length > 0 ? deviceSessions[0].id : null;
  const selectedSession = effectiveSessionId ? sessions.get(effectiveSessionId) : undefined;

  const models = selectedDevice ? deviceModels.get(selectedDevice.id) : undefined;

  const handleSelectDevice = useCallback((id: string) => {
    setSelectedDeviceId((prev) => prev === id ? null : id);
    setSelectedSessionId(null);
  }, []);

  const handleSelectSession = useCallback((id: string) => {
    setSelectedSessionId((prev) => prev === id ? null : id);
  }, []);

  if (tentacles.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
        <div className="text-4xl">📡</div>
        <h3 className="mt-4 text-sm font-semibold text-text-primary">No devices connected</h3>
        <p className="mt-2 max-w-sm text-xs text-text-secondary">
          Run <code className="rounded bg-surface-secondary px-1 py-0.5">kraki connect</code> in
          your terminal to pair a new device.
        </p>
      </div>
    );
  }

  // Mobile: single column based on explicit user selection (not auto-selected)
  const mobileView = selectedSessionId && selectedDeviceId
    ? 'session'
    : selectedDeviceId
      ? 'device'
      : 'list';

  return (
    <div className="flex min-h-0 flex-1">
      {/* Column 1: device list */}
      <div className={`min-h-0 w-full shrink-0 overflow-y-auto border-r border-border-primary p-3 sm:block sm:w-56 ${mobileView !== 'list' ? 'hidden' : ''}`}>
        <div className="space-y-1">
          {tentacles.map((d) => (
            <DeviceButton
              key={d.id}
              device={d}
              hasGreeting={deviceModels.has(d.id)}
              isSelected={effectiveDeviceId === d.id}
              isSelf={d.id === myDeviceId}
              onClick={() => handleSelectDevice(d.id)}
            />
          ))}
        </div>
      </div>

      {/* Column 2: device detail */}
      {selectedDevice ? (
        <div className={`min-h-0 min-w-0 flex-1 overflow-y-auto ${selectedSession ? 'sm:max-w-sm' : ''} ${mobileView !== 'device' ? 'hidden sm:block' : ''}`}>
          <DevicePanel
            device={selectedDevice}
            models={models}
            isCurrentDevice={selectedDevice.id === myDeviceId}
            selectedSessionId={effectiveSessionId}
            onSelectSession={handleSelectSession}
            onClose={() => { setSelectedDeviceId(null); setSelectedSessionId(null); }}
          />
        </div>
      ) : (
        <div className="hidden flex-1 items-center justify-center sm:flex">
          <p className="text-sm text-text-muted">Select a device to view details</p>
        </div>
      )}

      {/* Column 3: session info */}
      {selectedSession && selectedDevice && (
        <div className={`min-h-0 min-w-0 flex-1 overflow-y-auto border-l border-border-primary sm:block ${mobileView !== 'session' ? 'hidden' : ''}`}>
          <SessionInfoPanel
            session={selectedSession}
            usage={sessionUsage.get(selectedSession.id)}
            models={models}
            modelDetails={deviceModelDetails.get(selectedDevice.id)}
            onClose={() => setSelectedSessionId(null)}
          />
        </div>
      )}
    </div>
  );
}

// ── Device list button ──────────────────────────────

function DeviceButton({
  device,
  hasGreeting,
  isSelected,
  isSelf,
  onClick,
}: {
  device: DeviceSummary;
  hasGreeting: boolean;
  isSelected: boolean;
  isSelf: boolean;
  onClick: () => void;
}) {
  const dotClass = device.online && hasGreeting
    ? 'bg-emerald-400'
    : device.online
      ? 'animate-pulse bg-amber-400'
      : 'bg-slate-400';

  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
        isSelected
          ? 'border-border-primary bg-surface-tertiary text-text-primary'
          : 'border-border-primary bg-surface-secondary text-text-secondary hover:bg-surface-tertiary hover:text-text-primary'
      }`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{device.name}</span>
      {isSelf && (
        <span className="shrink-0 rounded-full bg-kraki-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-kraki-600 dark:text-kraki-400">
          You
        </span>
      )}
    </button>
  );
}
