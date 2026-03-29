import { useState, useCallback, useRef } from 'react';
import { useStore } from '../../hooks/useStore';
import { DevicePanel } from './DevicePanel';

export function DeviceGrid() {
  const devices = useStore((s) => s.devices);
  const deviceModels = useStore((s) => s.deviceModels);
  const myDeviceId = useStore((s) => s.deviceId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const cardRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const tentacles = [...devices.values()]
    .filter((d) => d.role === 'tentacle')
    .sort((a, b) => a.name.localeCompare(b.name));

  const handleSelect = useCallback((id: string) => {
    const next = selectedId === id ? null : id;
    setSelectedId(next);
    if (next) {
      requestAnimationFrame(() => {
        cardRefs.current.get(next)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  }, [selectedId]);

  const selected = selectedId ? devices.get(selectedId) : undefined;

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Card grid — takes remaining space, scrolls independently */}
      <div className={`min-h-0 overflow-y-auto p-4 ${selected ? 'h-1/3 sm:flex-1' : 'flex-1'}`}>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {tentacles.map((device) => {
            const hasGreeting = deviceModels.has(device.id);
            const dotClass = device.online && hasGreeting
              ? 'bg-emerald-400'
              : device.online
                ? 'animate-pulse bg-amber-400'
                : 'bg-slate-400';
            const statusLabel = device.online && hasGreeting
              ? 'online'
              : device.online
                ? 'connecting…'
                : 'offline';
            const isSelected = selectedId === device.id;
            const isSelf = device.id === myDeviceId;

            return (
              <button
                key={device.id}
                ref={(el) => { if (el) cardRefs.current.set(device.id, el); }}
                onClick={() => handleSelect(device.id)}
                className={`flex items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors hover:bg-surface-tertiary ${
                  isSelected ? 'border-border-primary bg-surface-tertiary' : 'border-border-primary bg-surface-secondary'
                }`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{device.name}</span>
                {isSelf && (
                  <span className="shrink-0 rounded-full bg-kraki-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-kraki-600 dark:text-kraki-400">
                    You
                  </span>
                )}
                <span className="shrink-0 text-[10px] text-text-muted">{statusLabel}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Detail panel — 2/3 on mobile, flex on desktop, scrolls independently */}
      {selected && (
        <div className="min-h-0 h-2/3 sm:flex-1 overflow-y-auto border-t border-border-primary">
          <DevicePanel
            device={selected}
            models={deviceModels.get(selected.id)}
            isCurrentDevice={selected.id === myDeviceId}
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}
    </div>
  );
}
