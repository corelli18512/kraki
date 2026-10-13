/**
 * Settings → This PC in Kraki for Windows — Kraki for Mac's TentaclePane:
 * which Kraki runs here (built in or the command-line one), whether this PC
 * runs agents, the background service, the coding agents and the logs.
 */
import { useCallback, useEffect, useState } from 'react';
import { desktop, type BuiltInBridge, type BuiltInState, type DesktopSettingsState } from '../../lib/desktop';
import { SettingsRow, SettingsSection } from '../layout/SettingsControls';
import { AgentsPanel, useAgentsCheck } from './AgentsPanel';
import './desktop-setup.css';

const ROLE_KEY = 'kraki-desktop.role';
const OWNER_KEY = 'kraki-desktop.owner';

function AgentsSheet({ builtIn, onClose }: { builtIn: BuiltInBridge; onClose: () => void }) {
  const check = useAgentsCheck(builtIn);
  return (
    <div className="ds-sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ds-sheet" role="dialog" aria-modal="true" aria-label="Coding agents on this PC">
        <div className="ds-sheet-title">Coding agents on this PC</div>
        <div className="ds-section-body"><AgentsPanel check={check} /></div>
        <div className="ds-sheet-actions">
          <span className="ds-spacer" />
          <button type="button" className="ds-button ds-button-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function Row({ title, detail, children }: { title: string; detail?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="min-w-0">
        <p className="text-sm text-text-primary">{title}</p>
        {detail && <p className="text-[11px] text-text-muted">{detail}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

function Switch({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-kraki-500' : 'bg-slate-300 dark:bg-slate-600'}`}
    >
      <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  );
}

const button = 'rounded-md bg-black/[0.085] px-2.5 py-1 text-xs text-text-primary hover:bg-black/[0.12] disabled:opacity-50 dark:bg-white/[0.14] dark:hover:bg-white/[0.2]';

export function ThisPCSettings({ builtIn }: { builtIn: BuiltInBridge }) {
  const [state, setState] = useState<BuiltInState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [os, setOs] = useState<DesktopSettingsState | null>(null);
  const settings = desktop?.settings;

  const refresh = useCallback(async () => {
    const next = await builtIn.state();
    if (settings) setOs(await settings.state());
    setState((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [builtIn, settings]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (name: string, fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    setBusy(name);
    setError(null);
    try {
      const r = await fn();
      if (!r.ok) setError(r.error ?? 'Something went wrong.');
      else after?.();
      await refresh();
    } catch { setError('Couldn’t update this PC.'); }
    finally { setBusy(null); }
  };

  if (!state) return null;
  const external = !state.owned && (state.cliDaemon || state.cliLogin);
  const runsAgents = state.owned;
  const status = busy === 'online' ? 'Going online…' : busy === 'offline' ? 'Going offline…' : busy === 'restart' ? 'Reconnecting…' : !state.running ? 'Offline'
    : state.relayState === 'connected' ? 'Online'
      : state.relayState ? `Connecting · ${state.relayState}` : 'Checking…';

  return (
    <div data-testid="settings-this-pc">
      <SettingsSection title="Agents">
        {external ? <><Row title="Kraki" detail="The command-line Kraki runs the agents on this PC. You update it from a terminal."><button type="button" className={button} disabled={!!busy} onClick={() => { void act('switch', builtIn.enable, () => localStorage.setItem(OWNER_KEY, 'builtIn')); }}>{busy === 'switch' ? 'Switching…' : 'Use built-in Kraki'}</button></Row><p className="kp-foot">Switching stops the command-line Kraki's background service and keeps your sign-in and sessions.</p></> : <Row title="Run agents on this PC" detail={runsAgents ? 'Kraki runs in the background and starts when you sign in to Windows.' : 'When off, this PC only controls agents on your other computers.'}><Switch label="Run agents on this PC" on={runsAgents} disabled={!!busy} onChange={(on) => { if (on) void act('on', builtIn.enable, () => localStorage.setItem(ROLE_KEY, 'runsAgents')); else void act('off', builtIn.disable, () => localStorage.setItem(ROLE_KEY, 'remoteOnly')); }} /></Row>}
        {!state.available && <Row title="Kraki isn't installed" detail="Install Kraki, or locate an existing command-line installation."><a className={button} href="https://kraki.chat/docs" target="_blank" rel="noreferrer">Install Kraki…</a></Row>}
        <SettingsRow label="Coding agents"><button type="button" className={button} onClick={() => setAgentsOpen(true)}>Check Coding Agents…</button></SettingsRow>
        {(settings?.locateCli || settings?.recheckCli) && <div className="kp-row">{settings.locateCli && <button type="button" className={button} disabled={!!busy} onClick={() => { void act('locate', settings.locateCli!); }}>Locate Kraki…</button>}{settings.recheckCli && <button type="button" className={button} disabled={!!busy} onClick={() => { void act('check', settings.recheckCli!); }}>{busy === 'check' ? 'Checking…' : 'Re-check'}</button>}</div>}
      </SettingsSection>
      <SettingsSection title="Online"><SettingsRow label="Status"><span className="text-text-secondary">{status}</span></SettingsRow><div className="kp-row" style={{ justifyContent: 'flex-start' }}>{state.running ? <>{settings?.goOffline && <button type="button" className={button} disabled={!!busy} onClick={() => { void act('offline', settings.goOffline!); }}>Go Offline</button>}<button type="button" className={button} disabled={!!busy || !state.owned} onClick={() => { void act('restart', builtIn.restart); }}>Reconnect</button></> : settings?.goOnline && <button type="button" className={button} disabled={!!busy} onClick={() => { void act('online', settings.goOnline!); }}>Go Online</button>}</div>{settings?.setLaunchAtLogin && os && <SettingsRow label="Start automatically at login"><Switch label="Start automatically at login" on={os.launchAtLogin} disabled={!!busy} onChange={(on) => { void act('login', () => settings.setLaunchAtLogin!(on)); }} /></SettingsRow>}</SettingsSection>
      {settings?.setAllowRemoteUpdates && os && <SettingsSection title="Updates"><SettingsRow label="Allow remote updates"><Switch label="Allow remote updates" on={os.allowRemoteUpdates} disabled={!!busy} onChange={(on) => { void act('updates', () => settings.setAllowRemoteUpdates!(on)); }} /></SettingsRow><p className="kp-foot">Allow your other devices to update Kraki on this PC.</p></SettingsSection>}
      <SettingsSection title="Logs">{os?.logsPath && <p className="kp-foot py-2 break-all font-mono">{os.logsPath}</p>}<div className="kp-row" style={{ justifyContent: 'flex-start' }}>{settings?.showLogsInExplorer && <button type="button" className={button} onClick={settings.showLogsInExplorer}>Show in Explorer</button>}<button type="button" className={button} onClick={() => builtIn.openLogs()}>Open Logs Window</button></div><SettingsRow label="Background Service"><span className="text-text-secondary">{state.version ?? '—'}</span></SettingsRow></SettingsSection>
      {error && <p role="alert" className="mt-2 text-xs text-orange-500">{error}</p>}
      {agentsOpen && <AgentsSheet builtIn={builtIn} onClose={() => setAgentsOpen(false)} />}
    </div>
  );
}
