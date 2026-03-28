import { useEffect, useState } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';
import { isDebugLoggingEnabled, setDebugLogging } from '../../lib/logger';
import { version } from '../../../package.json';

export function SettingsPanel({ open, onClose, inline, className }: { open: boolean; onClose: () => void; inline?: boolean; className?: string }) {
  const { isDark, toggleDark } = useTheme();
  const relayVersion = useStore((s) => s.relayVersion);
  const [debugLog, setDebugLog] = useState(isDebugLoggingEnabled);

  // Close on Escape (overlay mode only)
  useEffect(() => {
    if (!open || inline) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose, inline]);

  const wsUrl = wsClient.url;

  const content = (
    <div className="space-y-6">
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Appearance
        </h3>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-text-primary">Dark mode</p>
            <p className="text-[11px] text-text-muted">Toggle light and dark theme</p>
          </div>
          <button
            onClick={toggleDark}
            className={`relative h-6 w-11 rounded-full transition-colors ${
              isDark ? 'bg-kraki-500' : 'bg-slate-300'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                isDark ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Connection
        </h3>
        <div>
          <p className="text-sm text-text-primary">Relay server</p>
          <p className="mt-1 rounded-lg bg-surface-secondary px-3 py-2 font-mono text-xs text-text-secondary">
            {wsUrl}
          </p>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Developer
        </h3>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-text-primary">Debug logging</p>
            <p className="text-[11px] text-text-muted">Ship client logs to tentacle for remote debugging</p>
          </div>
          <button
            onClick={() => { const next = !debugLog; setDebugLog(next); setDebugLogging(next); }}
            className={`relative h-6 w-11 rounded-full transition-colors ${
              debugLog ? 'bg-kraki-500' : 'bg-slate-300'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                debugLog ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          About
        </h3>
        <div className="space-y-1 text-xs text-text-secondary">
          <p>Client version: {version}</p>
          {relayVersion && <p>Relay version: {relayVersion}</p>}
          <p>Agent-agnostic relay for AI coding agents</p>
        </div>
      </section>
    </div>
  );

  // Inline mode: render content directly, no overlay
  if (inline) {
    return open ? content : null;
  }

  // Overlay mode: slide-over panel
  return (
    <div className={className}>
      {open && <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />}
      <div className={`fixed inset-y-0 left-0 z-50 w-72 border-r border-border-primary bg-surface-primary shadow-xl transition-transform duration-300 sm:w-80 ${
        open ? 'translate-x-0' : '-translate-x-full'
      }`}>
        <div className="flex h-11 items-center justify-between border-b border-border-primary px-4">
          <h2 className="text-sm font-semibold text-text-primary">Settings</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-text-secondary hover:bg-surface-tertiary hover:text-text-primary"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          {content}
        </div>
      </div>
    </div>
  );
}
