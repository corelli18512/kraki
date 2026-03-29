import { useNavigate } from 'react-router';
import { DeviceGrid } from '../components/devices/DeviceGrid';

export function DevicesPage() {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b border-border-primary bg-surface-primary px-4">
        <button
          onClick={() => navigate('/')}
          className="mr-1 text-text-secondary hover:text-text-primary md:hidden"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <svg className="h-4 w-4 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />
        </svg>
        <span className="text-sm font-semibold text-text-primary">Devices</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <DeviceGrid />
      </div>
    </div>
  );
}
