import { useState } from 'react';
import { useNavigate } from 'react-router';
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
            <svg
              className="h-4 w-4 transition-transform duration-300 group-hover:rotate-90"
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
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
        <nav className="flex shrink-0 border-t border-border-primary md:hidden">
          <button
            onClick={() => setMobileTab('agents')}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 ${
              mobileTab === 'agents' ? 'text-kraki-500' : 'text-text-muted'
            }`}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
            <span className="text-[10px] font-medium">Agents</span>
          </button>
          <button
            onClick={() => setMobileTab('devices')}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 ${
              mobileTab === 'devices' ? 'text-kraki-500' : 'text-text-muted'
            }`}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />
            </svg>
            <span className="text-[10px] font-medium">Devices</span>
          </button>
          <button
            onClick={() => setMobileTab('settings')}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 ${
              mobileTab === 'settings' ? 'text-kraki-500' : 'text-text-muted'
            }`}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="text-[10px] font-medium">Settings</span>
          </button>
        </nav>
      </div>
      {/* Desktop settings panel (slide-over) */}
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} className="hidden md:block" />
    </>
  );
}
