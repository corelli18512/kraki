import { useState } from 'react';
import { useNavigate } from 'react-router';
import { BotMessageSquare, MonitorCloud, UserCog, Settings } from 'lucide-react';
import { SessionList } from '../sessions/SessionList';
import { DeviceList } from '../sessions/DeviceList';
import { DeviceGrid } from '../devices/DeviceGrid';
import { SettingsPanel } from './SettingsPanel';
import { ProfileBar } from './ProfileBar';
import { useStore } from '../../hooks/useStore';

export function Sidebar() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<'agents' | 'devices' | 'settings'>('agents');
  const status = useStore((s) => s.status);
  const reconnectAttempts = useStore((s) => s.reconnectAttempts);
  const isReconnecting = (status === 'disconnected' || status === 'connecting') && reconnectAttempts > 0;
  const navigate = useNavigate();

  return (
    <>
      <div className="flex h-full flex-col">
        {/* Brand header */}
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-primary px-4">
          <img src="/logo.png" alt="Kraki" className="h-6 w-6 object-contain" />
          <span className="font-['JetBrains_Mono'] text-[15px] font-extrabold tracking-[0.15em] text-text-primary pt-[2px]">
            <span style={{ color: '#00c9a7' }}>K</span>
            <span style={{ color: '#00b4d8' }}>R</span>
            <span style={{ color: '#06b6d4' }}>A</span>
            <span style={{ color: '#ea6046' }}>K</span>
            <span style={{ color: '#0891b2' }}>I</span>
          </span>
          <span className="rounded-full bg-kraki-500/15 px-2 py-0.5 text-[10px] font-semibold text-kraki-600 dark:text-kraki-400">Preview</span>
          {isReconnecting && (
            <div className="flex items-center gap-1.5" title={`Reconnecting (attempt ${reconnectAttempts})`}>
              <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-amber-500 border-t-transparent" />
            </div>
          )}
          {/* Desktop only: settings icon */}
          <button
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Settings"
            className="group ml-auto hidden rounded-md p-1.5 text-text-muted transition-all hover:bg-surface-tertiary hover:text-text-primary active:scale-90 md:block"
          >
            <Settings
              className="h-4 w-4 transition-transform duration-300 group-hover:rotate-90"
              strokeWidth={1.5}
            />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="min-h-0 flex-1 flex flex-col">
          {/* Desktop: always show agents */}
          <div className="hidden min-h-0 flex-1 overflow-y-auto md:block">
            <DeviceList />
            <SessionList />
          </div>
          {/* Mobile: tab content */}
          <div className="min-h-0 flex-1 flex flex-col md:hidden">
            {mobileTab === 'agents' ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <SessionList />
              </div>
            ) : mobileTab === 'devices' ? (
              <DeviceGrid />
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <div className="-mx-4 -mt-4 mb-4">
                  <ProfileBar />
                </div>
                <SettingsPanel open={true} onClose={() => setMobileTab('agents')} inline />
              </div>
            )}
          </div>
        </div>

        {/* Profile bar — desktop only */}
        <div className="hidden md:block">
          <ProfileBar />
        </div>

        {/* Mobile bottom tab bar */}
        <nav className="flex shrink-0 border-t border-border-primary pb-[env(safe-area-inset-bottom)] md:hidden">
          <button
            onClick={() => setMobileTab('agents')}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 ${
              mobileTab === 'agents' ? 'text-kraki-500' : 'text-text-muted'
            }`}
          >
            <BotMessageSquare className="h-5 w-5" strokeWidth={1.5} />
            <span className="text-[10px] font-medium">Agents</span>
          </button>
          <button
            onClick={() => setMobileTab('devices')}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 ${
              mobileTab === 'devices' ? 'text-kraki-500' : 'text-text-muted'
            }`}
          >
            <MonitorCloud className="h-5 w-5" strokeWidth={1.5} />
            <span className="text-[10px] font-medium">Devices</span>
          </button>
          <button
            onClick={() => setMobileTab('settings')}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 ${
              mobileTab === 'settings' ? 'text-kraki-500' : 'text-text-muted'
            }`}
          >
            <UserCog className="h-5 w-5" strokeWidth={1.5} />
            <span className="text-[10px] font-medium">Settings</span>
          </button>
        </nav>
      </div>
      {/* Desktop settings panel (slide-over) */}
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} className="hidden md:block" />
    </>
  );
}
