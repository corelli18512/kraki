/**
 * Settings → This PC in Kraki for Windows — Kraki for Mac's TentaclePane:
 * which Kraki runs here (built in or the command-line one), whether this PC
 * runs agents, the background service, the coding agents and the logs.
 */
import { t as translate } from '../../i18n';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useState } from 'react';
import { desktop, type BuiltInBridge, type BuiltInState, type DesktopSettingsState } from '../../lib/desktop';
import { SettingsRow, SettingsSection, SettingsSwitch } from '../layout/SettingsControls';
import { AgentsPanel, useAgentsCheck } from './AgentsPanel';
import { useDesktopSheet } from './useDesktopSheet';
import './desktop-setup.css';

const ROLE_KEY = 'kraki-desktop.role';
const OWNER_KEY = 'kraki-desktop.owner';

function AgentsSheet({ builtIn, onClose }: { builtIn: BuiltInBridge; onClose: () => void }) {
  const { t } = useTranslation('desktop');
  const check = useAgentsCheck(builtIn);
  const sheet = useDesktopSheet(onClose);
  return (
    <div
      className="ds-sheet-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={sheet} tabIndex={-1} className="ds-sheet ds-local-agents-sheet" role="dialog" aria-modal="true" aria-label={t('thisPC.agentsTitle')}>
        <div className="ds-local-agents-header">
          <div className="ds-sheet-title">{t('thisPC.agentsTitle')}</div>
          <p className="ds-local-agents-help">{t('thisPC.agentsHelp')}</p>
        </div>
        <div className="ds-local-agents-panel">
          <AgentsPanel check={check} />
        </div>
        <div className="ds-sheet-actions">
          <span className="ds-spacer" />
          <button type="button" className="ds-button ds-button-primary ds-button-default" onClick={onClose}>
            {t('thisPC.done')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ThisPCSettings({ builtIn }: { builtIn: BuiltInBridge }) {
  const { t } = useTranslation('desktop');
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
    } catch { setError(translate('desktop:thisPC.readFailed')); }
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
      if (!r.ok) setError(r.error ?? translate('desktop:thisPC.failed'));
      else after?.();
      await refresh();
    } catch {
      setError(translate('desktop:thisPC.updateFailed'));
    } finally {
      setBusy(null);
    }
  };

  if (!state) return <p className="kp-foot" role={error ? 'alert' : 'status'}>{error ?? t('thisPC.checking')}</p>;
  const external = !state.owned && (localStorage.getItem(OWNER_KEY) === 'external' || state.cliDaemon || state.cliLogin);
  const presence = (action: 'start' | 'stop' | 'restart') => {
    if (external) return builtIn.externalPresence?.(action)
      ?? Promise.resolve({ ok: false, error: t('thisPC.externalUnavailable') });
    if (action === 'start') return settings?.goOnline?.() ?? builtIn.enable();
    if (action === 'stop') return settings?.goOffline?.() ?? builtIn.disable({ keepOwnership: true });
    return builtIn.restart();
  };
  const runsAgents = state.owned;
  const status =
    busy === 'online' || busy === 'on' || busy === 'switch'
      ? t('thisPC.goingOnline')
      : busy === 'offline' || busy === 'off'
        ? t('thisPC.goingOffline')
        : busy === 'restart'
          ? t('thisPC.reconnecting')
          : !state.running
            ? t('thisPC.offline')
            : state.relayState === 'connected'
              ? t('thisPC.online')
              : state.relayState
                ? t('thisPC.connecting', { state: state.relayState })
                : t('thisPC.checking');

  return (
    <div data-testid="settings-this-pc">
      <SettingsSection title={t('thisPC.agents')}>
        {external ? (
          <>
            <SettingsRow
              label="Kraki"
              detail={t('thisPC.cliDetail')}
            >
              <button
                type="button"
                className="kp-button"
                disabled={!!busy}
                onClick={() => {
                  void act('switch', builtIn.enable, () => localStorage.setItem(OWNER_KEY, 'builtIn'));
                }}
              >
                {busy === 'switch' ? t('thisPC.switching') : t('thisPC.useBuiltIn')}
              </button>
            </SettingsRow>
            <p className="kp-foot">
              {t('thisPC.switchDetail')}
            </p>
          </>
        ) : (
          <SettingsRow
            label={t('thisPC.runAgents')}
            detail={
              runsAgents
                ? t('thisPC.background')
                : t('thisPC.remoteOnly')
            }
          >
            <SettingsSwitch
              label={t('thisPC.runAgents')}
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
          <SettingsRow label={t('thisPC.notInstalled')} detail={t('thisPC.installDetail')}>
            <a className="kp-button" href="https://kraki.chat/docs" target="_blank" rel="noreferrer">
              {t('thisPC.install')}
            </a>
          </SettingsRow>
        )}
        <SettingsRow label={t('thisPC.codingAgents')}>
          <button type="button" className="kp-button" onClick={() => setAgentsOpen(true)}>
            {t('thisPC.checkAgents')}
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
                {t('thisPC.locate')}
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
                {busy === 'check' ? t('thisPC.checking') : t('thisPC.recheck')}
              </button>
            )}
          </div>
        )}
      </SettingsSection>
      <SettingsSection title={t('thisPC.online')}>
        <SettingsRow label={t('thisPC.status')}>
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
                  {t('thisPC.goOffline')}
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
                {t('thisPC.reconnect')}
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
                {t('thisPC.goOnline')}
              </button>
          )}
        </div>
        {settings?.setLaunchAtLogin && os && (
          <SettingsRow label={t('thisPC.launchAtLogin')}>
            <SettingsSwitch
              label={t('thisPC.launchAtLogin')}
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
        <SettingsSection title={t('thisPC.updates')}>
          <SettingsRow label={t('thisPC.remoteUpdates')}>
            <SettingsSwitch
              label={t('thisPC.remoteUpdates')}
              on={os.allowRemoteUpdates}
              disabled={!!busy}
              onChange={(on) => {
                void act('updates', () => settings.setAllowRemoteUpdates!(on));
              }}
            />
          </SettingsRow>
          <p className="kp-foot ds-updates-help">{t('thisPC.updatesHelp')}</p>
        </SettingsSection>
      )}
      <SettingsSection title={t('thisPC.logs')}>
        {(logsPath ?? os?.logsPath) && (
          <SettingsRow label={t('thisPC.path')}>
            <span className="ds-logs-path text-text-secondary">{logsPath ?? os?.logsPath}</span>
          </SettingsRow>
        )}
        <div className="kp-row" style={{ justifyContent: 'flex-start' }}>
          {(settings?.showLogsInExplorer || builtIn.showLogsInExplorer) && (
            <button type="button" className="kp-button" onClick={settings?.showLogsInExplorer ?? builtIn.showLogsInExplorer}>
              {t('thisPC.explorer')}
            </button>
          )}
          <button type="button" className="kp-button" onClick={() => builtIn.openLogs()}>
            {t('thisPC.logsWindow')}
          </button>
        </div>
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
