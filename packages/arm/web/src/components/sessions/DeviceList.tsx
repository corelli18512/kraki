import { useNavigate } from 'react-router';
import { useStore } from '../../hooks/useStore';

export function DeviceList() {
  const devices = useStore((s) => s.devices);
  const deviceModels = useStore((s) => s.deviceModels);
  const navigate = useNavigate();

  // Only show online/connecting tentacles
  const onlineTentacles = [...devices.values()].filter(
    (d) => d.role === 'tentacle' && d.online,
  );

  if (onlineTentacles.length === 0) return null;

  return (
    <button
      onClick={() => navigate('/devices')}
      className="group w-full border-b border-border-primary px-4 py-2 text-left transition-colors hover:bg-surface-tertiary"
    >
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          Devices
        </h3>
        <svg
          className="h-3 w-3 text-text-muted opacity-0 transition-opacity group-hover:opacity-100"
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {onlineTentacles.map((d) => {
          const hasGreeting = deviceModels.has(d.id);
          const dotClass = hasGreeting ? 'bg-emerald-400' : 'animate-pulse bg-amber-400';
          return (
            <span key={d.id} className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
              <span className="text-[11px] text-text-primary">{d.name}</span>
            </span>
          );
        })}
      </div>
    </button>
  );
}
