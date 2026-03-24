import { useStore } from '../../hooks/useStore';

export function DeviceList() {
  const devices = useStore((s) => s.devices);
  const deviceModels = useStore((s) => s.deviceModels);
  const tentacles = [...devices.values()].filter((d) => d.role === 'tentacle');

  if (tentacles.length === 0) return null;

  return (
    <div className="border-b border-border-primary px-4 py-2">
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        Devices
      </h3>
      <div className="space-y-1">
        {tentacles.map((d) => {
          const hasGreeting = deviceModels.has(d.id);
          const dotClass = d.online && hasGreeting
            ? 'bg-emerald-400'
            : d.online
              ? 'animate-pulse bg-amber-400'
              : 'bg-slate-400';
          return (
            <div key={d.id} className="flex items-center gap-2 px-1 py-0.5">
              <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
              <span className="truncate text-[11px] text-text-primary">{d.name}</span>
              <span className="ml-auto text-[10px] text-text-muted">
                {d.kind ?? d.role}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
