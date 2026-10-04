import { useNavigate } from 'react-router';
import { Smartphone } from 'lucide-react';
import { DeviceGrid } from '../components/devices/DeviceGrid';
import { desktop } from '../lib/desktop';
import { CONNECT_PHONE_EVENT } from '../components/devices/ConnectPhoneCard';

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
      <div className="flex min-h-0 flex-1 flex-col">
        <DeviceGrid />
        {desktop?.builtIn && (
          <div className="mx-4 mb-6 flex items-center gap-3 rounded-xl bg-surface-secondary px-4 py-3" data-testid="devices-phone-entry">
            <Smartphone className="h-5 w-5 shrink-0 text-kraki-500 dark:text-kraki-300" strokeWidth={1.6} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-text-primary">Use Kraki on your phone</p>
              <p className="text-[11px] text-text-muted">Scan a code with your phone to see and run your sessions there.</p>
            </div>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event(CONNECT_PHONE_EVENT))}
              className="shrink-0 rounded-md bg-black/[0.085] px-2.5 py-1 text-xs text-text-primary hover:bg-black/[0.12] dark:bg-white/[0.14]"
            >
              Show Code…
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
