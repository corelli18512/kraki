/**
 * Settings → This PC in Kraki for Windows — Kraki for Mac's TentaclePane:
 * which Kraki runs here (built in or the command-line one), whether this PC
 * runs agents, the background service, the coding agents and the logs.
 */
import { useCallback, useEffect, useState } from 'react';
import { desktop, type BuiltInBridge, type BuiltInState, type DesktopSettingsState } from '../../lib/desktop';
import { SettingsRow, SettingsSection, SettingsSwitch } from '../layout/SettingsControls';
import { AgentsPanel, useAgentsCheck } from './AgentsPanel';
import { useDesktopSheet } from './useDesktopSheet';
import './desktop-setup.css';

const ROLE_KEY = 'kraki-desktop.role';
const OWNER_KEY = 'kraki-desktop.owner';

function AgentsSheet({ builtIn, onClose }: { builtIn: BuiltInBridge; onClose: () => void }) {
  const check = useAgentsCheck(builtIn);
  const sheet = useDesktopSheet(onClose);
  return (
    <div
      className="ds-sheet-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={sheet} tabIndex={-1} className="ds-sheet ds-local-agents-sheet" role="dialog" aria-modal="true" aria-label="Coding Agents on This PC">
        <div className="ds-local-agents-header">
          <div className="ds-sheet-title">Coding Agents on This PC</div>
          <p className="ds-local-agents-help">Kraki uses the agents installed and signed in on this PC. Install or sign in to an agent in its own app or in Terminal, then click Check Again.</p>
        </div>
        <div className="ds-local-agents-panel">
          <AgentsPanel check={check} />
        </div>
        <div className="ds-sheet-actions">
          <span className="ds-spacer" />
          <button type="button" className="ds-button ds-button-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

export function ThisPCSettings({ builtIn }: { builtIn: BuiltInBridge }) {
  const [state, setState] = useState<BuiltInState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const closeAgents = useCallback(() => setAgentsOpen(false), []);
  const [logsPath, setLogsPath] = useState<string | null>(null);
  const [os, setOs] = useState<DesktopSettingsState | null>(null);
  const settings = desktop?.settings;

  const refresh = useCallback(async () => {
    try {
      const next = await builtIn.state();
      setState((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      if (settings) setOs(await settings.state());
      if (builtIn.logsPath) setLogsPath(await builtIn.logsPath());
    } catch { setError('Couldn’t read this PC’s status.'); }
  }, [builtIn, settings]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      void refresh();
    }, 3000);
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
    } catch {
      setError('Couldn’t update this PC’s status.');
    } finally {
      setBusy(null);
    }
  };

  if (!state) return <p className="kp-foot" role={error ? 'alert' : 'status'}>{error ?? 'Checking…'}</p>;
  const external = !state.owned && (localStorage.getItem(OWNER_KEY) === 'external' || state.cliDaemon || state.cliLogin);
  const presence = (action: 'start' | 'stop' | 'restart') => {
    if (external) return builtIn.externalPresence?.(action)
      ?? Promise.resolve({ ok: false, error: 'External service control is unavailable.' });
    if (action === 'start') return settings?.goOnline?.() ?? builtIn.enable();
    if (action === 'stop') return settings?.goOffline?.() ?? builtIn.disable({ keepOwnership: true });
    return builtIn.restart();
  };
  const runsAgents = state.owned;
  const status =
    busy === 'online' || busy === 'on' || busy === 'switch'
      ? 'Going online…'
      : busy === 'offline' || busy === 'off'
        ? 'Going offline…'
        : busy === 'restart'
          ? 'Reconnecting…'
          : !state.running
            ? 'Offline'
            : state.relayState === 'connected'
              ? 'Online'
              : state.relayState
                ? `Connecting · ${state.relayState}`
                : 'Checking…';

  return (
    <div data-testid="settings-this-pc">
      <SettingsSection title="Agents">
        {external ? (
          <>
            <SettingsRow
              label="Kraki"
              detail="The command-line Kraki runs the agents on this PC. You update it from a terminal."
            >
              <button
                type="button"
                className="kp-button"
                disabled={!!busy}
                onClick={() => {
                  void act('switch', builtIn.enable, () => localStorage.setItem(OWNER_KEY, 'builtIn'));
                }}
              >
                {busy === 'switch' ? 'Switching…' : 'Use built-in Kraki'}
              </button>
            </SettingsRow>
            <p className="kp-foot">
              Switching stops the command-line Kraki's background service and keeps your sign-in and sessions.
            </p>
          </>
        ) : (
          <SettingsRow
            label="Run agents on this PC"
            detail={
              runsAgents
                ? 'Kraki runs in the background and starts when you sign in to Windows.'
                : 'When off, this PC only controls agents on your other computers.'
            }
          >
            <SettingsSwitch
              label="Run agents on this PC"
              on={runsAgents}
              disabled={!!busy}
              onChange={(on) => {
                if (on) void act('on', builtIn.enable, () => localStorage.setItem(ROLE_KEY, 'runsAgents'));
                else void act('off', builtIn.disable, () => localStorage.setItem(ROLE_KEY, 'remoteOnly'));
              }}
            />
          </SettingsRow>
        )}
        {!state.available && (
          <SettingsRow label="Kraki isn't installed" detail="Install Kraki, or locate an existing command-line installation.">
            <a className="kp-button" href="https://kraki.chat/docs" target="_blank" rel="noreferrer">
              Install Kraki…
            </a>
          </SettingsRow>
        )}
        <SettingsRow label="Coding agents">
          <button type="button" className="kp-button" onClick={() => setAgentsOpen(true)}>
            Check Coding Agents…
          </button>
        </SettingsRow>
        {(settings?.locateCli || settings?.recheckCli) && (
          <div className="kp-row">
            {settings.locateCli && (
              <button
                type="button"
                className="kp-button"
                disabled={!!busy}
                onClick={() => {
                  void act('locate', settings.locateCli!);
                }}
              >
                Locate Kraki…
              </button>
            )}
            {settings.recheckCli && (
              <button
                type="button"
                className="kp-button"
                disabled={!!busy}
                onClick={() => {
                  void act('check', settings.recheckCli!);
                }}
              >
                {busy === 'check' ? 'Checking…' : 'Re-check'}
              </button>
            )}
          </div>
        )}
      </SettingsSection>
      <SettingsSection title="Online">
        <SettingsRow label="Status">
          <span className="text-text-secondary">{status}</span>
        </SettingsRow>
        <div className="kp-row" style={{ justifyContent: 'flex-start' }}>
          {state.running ? (
            <>
              {(external || state.owned) && (
                <button
                  type="button"
                  className="kp-button"
                  disabled={!!busy}
                  onClick={() => {
                    void act('offline', () => presence('stop'));
                  }}
                >
                  Go Offline
                </button>
              )}
              <button
                type="button"
                className="kp-button"
                disabled={!!busy || (!state.owned && !external)}
                onClick={() => {
                  void act('restart', () => presence('restart'));
                }}
              >
                Reconnect
              </button>
            </>
          ) : (
              <button
                type="button"
                className="kp-button"
                disabled={!!busy || (!runsAgents && !external)}
                onClick={() => {
                  void act('online', () => presence('start'));
                }}
              >
                Go Online
              </button>
          )}
        </div>
        {settings?.setLaunchAtLogin && os && (
          <SettingsRow label="Start automatically at login">
            <SettingsSwitch
              label="Start automatically at login"
              on={os.launchAtLogin}
              disabled={!!busy}
              onChange={(on) => {
                void act('login', () => settings.setLaunchAtLogin!(on));
              }}
            />
          </SettingsRow>
        )}
      </SettingsSection>
      {settings?.setAllowRemoteUpdates && os && (
        <SettingsSection title="Updates">
          <SettingsRow label="Let my other devices update Kraki on this PC">
            <SettingsSwitch
              label="Let my other devices update Kraki on this PC"
              on={os.allowRemoteUpdates}
              disabled={!!busy}
              onChange={(on) => {
                void act('updates', () => settings.setAllowRemoteUpdates!(on));
              }}
            />
          </SettingsRow>
          <p className="kp-foot ds-updates-help">From your phone or another computer, you can update Kraki here when a new version is out. Kraki restarts for a few seconds; running sessions are only stopped if you choose to.</p>
        </SettingsSection>
      )}
      <SettingsSection title="Logs">
        {(logsPath ?? os?.logsPath) && (
          <SettingsRow label="Path">
            <span className="ds-logs-path text-text-secondary">{logsPath ?? os?.logsPath}</span>
          </SettingsRow>
        )}
        <div className="kp-row" style={{ justifyContent: 'flex-start' }}>
          {(settings?.showLogsInExplorer || builtIn.showLogsInExplorer) && (
            <button type="button" className="kp-button" onClick={settings?.showLogsInExplorer ?? builtIn.showLogsInExplorer}>
              Show in Explorer
            </button>
          )}
          <button type="button" className="kp-button" onClick={() => builtIn.openLogs()}>
            Open Logs Window
          </button>
        </div>
        <SettingsRow label="Background Service">
          <span className="text-text-secondary">{state.version ?? '—'}</span>
        </SettingsRow>
      </SettingsSection>
      {error && (
        <p role="alert" className="mt-2 text-xs text-orange-500">
          {error}
        </p>
      )}
      {agentsOpen && <AgentsSheet builtIn={builtIn} onClose={closeAgents} />}
    </div>
  );
}
