/**
 * Settings → This PC in Kraki for Windows — Kraki for Mac's TentaclePane:
 * which Kraki runs here (built in or the command-line one), whether this PC
 * runs agents, the background service, the coding agents and the logs.
 */
import { useCallback, useEffect, useState } from 'react';
import { desktop, type BuiltInBridge, type BuiltInState, type DesktopSettingsState } from '../../lib/desktop';
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
  const [preferences, setPreferences] = useState<DesktopSettingsState | null>(null);
  const [logsPath, setLogsPath] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await builtIn.state();
    if (desktop?.settings) setPreferences(await desktop.settings.state());
    if (builtIn.logsPath) setLogsPath(await builtIn.logsPath());
    setState((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [builtIn]);
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
    } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); }
    finally { setBusy(null); }
  };

  if (!state) return null;
  const external = !state.owned && (localStorage.getItem(OWNER_KEY) === 'external' || state.cliDaemon || state.cliLogin);
  const presence = (action: 'start' | 'stop' | 'restart') => external
    ? builtIn.externalPresence?.(action) ?? Promise.resolve({ ok: false, error: 'External service control is unavailable.' })
    : action === 'start' ? builtIn.enable() : action === 'stop' ? builtIn.disable({ keepOwnership: true }) : builtIn.restart();
  const runsAgents = state.owned;
  const status = busy === 'online' || busy === 'on' || busy === 'switch' ? 'Going online…'
    : busy === 'offline' || busy === 'off' ? 'Going offline…' : busy === 'reconnect' ? 'Reconnecting…'
      : state.running ? 'Online' : 'Offline';

  return (
    <section data-testid="settings-this-pc">
      <div className="space-y-4">
        <fieldset className="ds-settings-group"><legend>Agents on This PC</legend>
        {external ? (
          <>
            <Row title="Kraki" detail="The command-line Kraki runs the agents on this PC. You update it from a terminal.">
              <button type="button" className={button} disabled={!!busy} onClick={() => { void act('switch', builtIn.enable, () => localStorage.setItem(OWNER_KEY, 'builtIn')); }}>
                {busy === 'switch' ? 'Switching…' : 'Use built-in Kraki'}
              </button>
            </Row>
            <p className="text-[11px] text-text-muted">Switching stops the command-line Kraki's background service and keeps your sign-in and sessions.</p>
          </>
        ) : (
          <Row title="Run agents on this PC" detail={runsAgents ? 'Kraki runs in the background and starts when you sign in to Windows.' : 'When off, this PC only controls agents on your other computers.'}>
            <Switch
              label="Run agents on this PC"
              on={runsAgents}
              disabled={!!busy}
              onChange={(on) => {
                if (on) void act('on', builtIn.enable, () => localStorage.setItem(ROLE_KEY, 'runsAgents'));
                else void act('off', builtIn.disable, () => localStorage.setItem(ROLE_KEY, 'remoteOnly'));
              }}
            />
          </Row>
        )}
        <Row title="Coding agents" detail="Which agents are installed and signed in here.">
          <button type="button" className={button} onClick={() => setAgentsOpen(true)}>Check Coding Agents…</button>
        </Row>
        <Row title="Version" detail={`Kraki ${state.version ?? 'unknown'}${state.owned ? ' (built in)' : ''}`} />
        </fieldset>
        <fieldset className="ds-settings-group"><legend>Online</legend>
          <Row title={status}>
            {(runsAgents || external) && state.running ? <>
              <button type="button" className={button} disabled={!!busy} onClick={() => { void act('offline', () => presence('stop')); }}>Go Offline</button>
              <button type="button" className={button} disabled={!!busy} onClick={() => { void act('reconnect', () => presence('restart')); }}>Reconnect</button>
            </> : <button type="button" className={button} disabled={!!busy || (!runsAgents && !external)} onClick={() => { void act('online', () => presence('start')); }}>Go Online</button>}
          </Row>
          <p className="text-[11px] text-text-secondary">{external ? 'Managed by the command-line Kraki.' : 'While this PC is online, your phone and other computers can use its agents, even with the Kraki window closed. Quitting Kraki takes it offline; opening Kraki brings it back.'}</p>
          {error && <div role="alert" className="text-[11px] text-text-secondary">Error: {error}<button type="button" className={button} disabled={!!busy} onClick={() => { void act('online', () => presence('start')); }}>Retry</button></div>}
        </fieldset>
        {state.configured && <fieldset className="ds-settings-group"><legend>Updates</legend>
          {desktop?.settings?.setAllowRemoteUpdates && preferences ? <>
            <Row title="Let my other devices update Kraki on this PC">
              <Switch label="Let my other devices update Kraki on this PC" on={preferences.allowRemoteUpdates} disabled={!!busy} onChange={(on) => { void act('updates', () => desktop!.settings!.setAllowRemoteUpdates!(on)); }} />
            </Row>
            <p className="text-[11px] text-text-secondary">From your phone or another computer, you can update Kraki here when a new version is out. Kraki restarts for a few seconds; running sessions are only stopped if you choose to.</p>
          </> : <p className="text-[11px] text-text-secondary">Remote update controls are not available in this desktop shell.</p>}
        </fieldset>}
        <fieldset className="ds-settings-group"><legend>Logs</legend>
          <Row title="Path" detail={logsPath ?? preferences?.logsPath ?? 'Checking…'} />
          <div className="flex gap-2">
            {(builtIn.showLogsInExplorer || desktop?.settings?.showLogsInExplorer) && <button type="button" className={button} onClick={() => (builtIn.showLogsInExplorer ?? desktop?.settings?.showLogsInExplorer)?.()}>Show in Explorer</button>}
            <button type="button" className={button} onClick={() => builtIn.openLogs()}>Open Logs Window</button>
          </div>
        </fieldset>
      </div>
      {agentsOpen && <AgentsSheet builtIn={builtIn} onClose={() => setAgentsOpen(false)} />}
    </section>
  );
}
