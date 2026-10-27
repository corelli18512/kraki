import { i18next, t as translate } from '../../i18n';
import { useTranslation } from 'react-i18next';
import { diag } from '../../lib/diag';
import { useEffect, useRef, useState } from 'react';
import { Check, CheckCircle, ChevronRight, Smartphone, X } from 'lucide-react';
import { KrakiLogo } from '../KrakiLogo';
import { VoiceSettings } from './VoiceSettings';
import { DeleteAccountSection } from './DeleteAccount';
import { SettingsAlert, SettingsRow, SettingsSection, SettingsSwitch } from './SettingsControls';
import { desktop, type DesktopSettingsState } from '../../lib/desktop';
import { ThisPCSettings } from '../desktop/ThisPCSettings';
import { useTheme } from '../../hooks/useTheme';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';
import {
  isPushSupported,
  isPushSubscribed,
  subscribeToPush,
  unsubscribeFromPush,
  getPushPermission,
} from '../../lib/push';
import { getCurrentChannel } from '../../lib/auth';
import { version } from '../../../package.json';
import { BuildProvenance } from './BuildProvenance';
import { ArchiveSettings } from '../sessions/ArchivedSessions';
import { CONNECT_PHONE_EVENT } from '../devices/ConnectPhoneCard';
import { DeviceUpdateBox } from '../devices/DeviceUpdateBox';
import { DeviceNameEditor } from '../devices/DeviceNameEditor';
import { signOut } from './ProfileBar';
import { setUsageShortcut, shortcutFromEvent, useUsageShortcut } from '../../lib/usage-shortcut';
import './settings.css';
import { LanguageSettingsRow } from './LanguageSettings';
import { SettingsTabIcon } from './SettingsTabIcon';
import { deviceLastOnline } from '../../lib/device-last-online';
import {
  notificationsEnabled as readNotificationsEnabled,
  setNotificationsEnabled as saveNotificationsEnabled,
} from '../../lib/notification-prefs';

const tabs = ['General', 'Account', 'Voice Input', 'Notifications', 'This PC', 'Devices', 'About'] as const;
const tabKeys = {
  General: 'general', Account: 'account', 'Voice Input': 'voice', Notifications: 'notifications',
  'This PC': 'thisPC', Devices: 'devices', About: 'about',
} as const;
type SettingsTab = typeof tabs[number];

/** Same section, copy and default (on) as Mac DiagSettingsSection. */
export function performanceDataFooter() { return translate('settings:performance.footer'); }

function PerformanceDataSection() {
  const { t } = useTranslation('settings');
  const [on, setOn] = useState(diag.enabled);
  return (
    <SettingsSection title={t('performance.privacy')} footer={performanceDataFooter()}>
      <SettingsRow label={t('performance.share')}>
        <SettingsSwitch label={t('performance.share')} on={on} onChange={(next) => { setOn(next); void diag.setEnabled(next); }} />
      </SettingsRow>
      <div className="kp-row">
        <a href="https://app.kraki.chat/privacy/" target="_blank" rel="noreferrer" className="text-kraki-500">{t('about.privacy')}</a>
      </div>
    </SettingsSection>
  );
}

/** Same labels as Mac AccountPane.providerLabel: GitHub by default, otherwise
 *  the provider id capitalized ("open" → "Open"). */
export function providerLabel(provider: string | null | undefined): string {
  if (!provider || provider === 'github') return 'GitHub';
  return provider.split(/(\s+)/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
}

/** Own errors keep their key so the text follows a language switch; shell
 *  errors arrive as text. */
type SettingsErrorKey = 'identifyPC' | 'readPreferences' | 'savePreference' | 'shortcut' | 'disablePush' | 'blockedNotifications' | 'updatePush' | 'copyDiagnostics';
type SettingsError = { key: SettingsErrorKey } | { message: string };

export function SettingsPanel({
  open,
  onClose,
  inline,
  className,
}: {
  open: boolean;
  onClose: () => void;
  inline?: boolean;
  className?: string;
}) {
  const { t } = useTranslation('settings');
  const tabLabel = (name: SettingsTab) => t(`tabs.${tabKeys[name]}`);
  const { theme, setTheme } = useTheme();
  const state = useStore();
  const [tab, setTab] = useState<SettingsTab>('General');
  const [diagCopied, setDiagCopied] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [builtInId, setBuiltInId] = useState<string | null>(null);
  const [builtInKnown, setBuiltInKnown] = useState(!desktop?.builtIn);
  const [os, setOs] = useState<DesktopSettingsState | null>(null);
  const [error, setError] = useState<SettingsError | null>(null);
  const errorText = error && ('key' in error ? t(`errors.${error.key}`) : error.message);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(readNotificationsEnabled);
  const [permission, setPermission] = useState(getPushPermission());
  const shortcut = useUsageShortcut();
  const bridge = desktop?.settings;
  const isBeta = getCurrentChannel() === 'beta';
  const isWindows = desktop?.platform === 'win32';
  const windowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || inline || !isWindows) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = windowRef.current;
    panel?.querySelector<HTMLButtonElement>('[role=tab][aria-selected=true]')?.focus();
    const key = (event: KeyboardEvent) => {
      // Foreground confirmation/agent sheets own their keyboard handling.
      if (event.key !== 'Tab' || event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest('[role=dialog], [role=alertdialog]') !== panel)) return;
      const controls = [...(panel?.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]') ?? [])]
        .filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[hidden], fieldset:disabled'));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [open, inline, isWindows]);

  useEffect(() => {
    if (!open) return;
    if (isPushSupported()) void isPushSubscribed().then(setPushEnabled);
    void desktop?.builtIn?.state().then((s) => { setBuiltInId(s.deviceId); setBuiltInKnown(true); }).catch(() => setError({ key: 'identifyPC' }));
    void bridge
      ?.state()
      .then((s) => {
        setOs(s);
        setUsageShortcut(s.usageShortcut, s.usageShortcutEnabled);
      })
      .catch(() => setError({ key: 'readPreferences' }));
  }, [open, bridge]);
  useEffect(() => {
    if (!open || inline) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (useUsageShortcut.getState().recording) useUsageShortcut.setState({ recording: false });
        else onClose();
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
    };
  }, [open, onClose, inline]);

  useEffect(() => {
    if (!open) useUsageShortcut.setState({ recording: false });
  }, [open]);

  async function updateOs(fn: (() => Promise<{ ok: boolean; error?: string }>) | undefined) {
    if (!fn) return;
    try {
      const result = await fn();
      setError(result.ok ? null : result.error != null ? { message: result.error } : { key: 'savePreference' });
      if (result.ok && bridge) setOs(await bridge.state());
    } catch {
      setError({ key: 'savePreference' });
    }
  }
  async function updateShortcut(key: string, enabled: boolean) {
    if (bridge?.setUsageShortcut) {
      try {
        const result = await bridge.setUsageShortcut(key, enabled);
        if (!result.ok) {
          setError(result.error != null ? { message: result.error } : { key: 'shortcut' });
          return;
        }
      } catch {
        setError({ key: 'shortcut' });
        return;
      }
    }
    setError(null);
    setUsageShortcut(key, enabled);
  }
  async function updateNotifications(on: boolean) {
    setError(null);
    if (!desktop && isPushSupported() && (state.vapidPublicKey || pushEnabled)) {
      setPushLoading(true);
      try {
        if (!on) {
          if (pushEnabled && !(await unsubscribeFromPush())) {
            setError({ key: 'disablePush' });
            return;
          }
          wsClient.unregisterPushToken({ provider: 'web_push' });
          setPushEnabled(false);
        } else if (state.vapidPublicKey) {
          const token = await subscribeToPush(state.vapidPublicKey);
          if (!token) {
            setError({ key: 'blockedNotifications' });
            return;
          }
          wsClient.registerPushToken({ provider: 'web_push', token });
          setPushEnabled(true);
        }
      } catch {
        setError({ key: 'updatePush' });
        return;
      } finally {
        setPushLoading(false);
        setPermission(getPushPermission());
      }
    }
    saveNotificationsEnabled(on);
    setNotificationsEnabled(on);
  }
  const diagnostics = (english = false) => {
    const labels = english ? i18next.getFixedT('en', 'settings') : t;
    return [
      [labels('about.backgroundService'), os ? (state.deviceVersions.get(builtInId ?? '') ?? '—') : '—'],
      [desktop ? 'Kraki Windows' : 'Kraki Web', `${desktop?.version ?? version}${isBeta ? '-beta' : ''}`],
      ...[...state.devices.values()]
        .filter((d) => d.role === 'tentacle')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => [d.name, `Kraki ${state.deviceVersions.get(d.id) ?? '—'}${d.online ? '' : labels('about.offlineSuffix')}`]),
      [labels('about.relay'), `${new URL(wsClient.url || 'ws://localhost').hostname} · ${state.relayVersion ?? '—'}`],
      ...(state.deviceId ? [[labels('about.deviceId'), state.deviceId]] : []),
    ];
  };
  const general = (
    <>
      <SettingsSection title={t('general.appearance')}>
        <SettingsRow label={t('general.theme')}>
          <div className={isWindows ? 'kp-theme-grid' : 'kp-segment'} role="radiogroup" aria-label={t('general.theme')}>
            {(isWindows ? ['light', 'dark', 'system'] as const : ['system', 'light', 'dark'] as const).map((option) => (
              <button
                type="button"
                role="radio"
                aria-checked={theme === option}
                tabIndex={isWindows && theme !== option ? -1 : 0}
                onKeyDown={isWindows ? (e) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                  e.preventDefault();
                  const buttons = [...e.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role=radio]')];
                  const index = buttons.indexOf(e.currentTarget);
                  const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
                    : (index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
                  buttons[next].focus();
                  buttons[next].click();
                } : undefined}
                key={option}
                onClick={() => {
                  setTheme(option);
                  wsClient.updatePreferences({ theme: option });
                }}
              >
                {isWindows && <span className={`kp-theme-preview kp-theme-preview-${option}`} aria-hidden="true"><span /><span><i /><i /><i /></span></span>}
                <span>{isWindows && option === 'system' ? t('general.useSystem') : t(`general.themes.${option}`)}</span>
                {isWindows && <Check size={15} aria-hidden="true" />}
              </button>
            ))}
          </div>
        </SettingsRow>
        {import.meta.env.DEV && (
          <div className="kp-row kp-palette" style={{ justifyContent: 'flex-start', gap: 6 }}>
            {['#FBBF24', '#34D399', '#22D3EE', '#F4836E', '#6366F1'].map((color) => (
              <span key={color} style={{ width: 12, height: 12, borderRadius: '50%', background: color }} />
            ))}
            <span className="kp-foot" style={{ fontWeight: 500 }}>
              Brand palette preview
            </span>
          </div>
        )}
      </SettingsSection>
      <LanguageSettingsRow />
      <SettingsSection title={t('general.accountUsage')}>
        <SettingsRow label={t('general.holdUsage', { shortcut: shortcut.shortcut })}>
          <SettingsSwitch
            label={t('general.peekUsage')}
            on={shortcut.enabled}
            onChange={(on) => {
              void updateShortcut(shortcut.shortcut, on);
            }}
          />
        </SettingsRow>
        <SettingsRow label={t('general.shortcut')}>
          <button
            type="button"
            className={`kp-button kp-shortcut${shortcut.recording ? ' is-recording' : ''}`}
            style={isWindows ? undefined : { width: 230, height: 26 }}
            onClick={() => useUsageShortcut.setState({ recording: true })}
            onBlur={() => useUsageShortcut.setState({ recording: false })}
            onKeyDown={(e) => {
              if (!shortcut.recording) return;
              e.preventDefault();
              e.stopPropagation();
              if (e.key === 'Escape') {
                useUsageShortcut.setState({ recording: false });
                return;
              }
              const key = shortcutFromEvent(e.nativeEvent);
              if (key) {
                useUsageShortcut.setState({ recording: false });
                void updateShortcut(key, shortcut.enabled);
              }
            }}
          >
            {shortcut.recording ? t('general.recordShortcut') : shortcut.shortcut}
          </button>
        </SettingsRow>
        <p className="kp-foot">
          {t(bridge?.setUsageShortcut ? 'general.shortcutFooterFloating' : desktop ? 'general.shortcutFooterTray' : 'general.shortcutFooterSidebar')}
        </p>
      </SettingsSection>
      {state.archiveInfo.size > 0 && <section className="kp-section">
        <h3>{t('tabs.sessions')}</h3>
        <ArchiveSettings />
      </section>}
      {bridge && os && (
        <SettingsSection title={t('general.behavior')}>
          {bridge.setKeepRunningInTray && (
            <SettingsRow label={t('general.keepRunning')}>
              <SettingsSwitch
                label={t('general.keepRunning')}
                on={os.keepRunningInTray}
                onChange={(on) => {
                  void updateOs(() => bridge.setKeepRunningInTray!(on));
                }}
              />
            </SettingsRow>
          )}
          {bridge.setLaunchAtLogin && (
            <SettingsRow label={t('general.launchAtLogin')}>
              <SettingsSwitch
                label={t('general.launchAtLogin')}
                on={os.launchAtLogin}
                onChange={(on) => {
                  void updateOs(() => bridge.setLaunchAtLogin!(on));
                }}
              />
            </SettingsRow>
          )}
        </SettingsSection>
      )}
      {diag.active && <PerformanceDataSection />}
    </>
  );
  const account = state.user ? (
    <>
      <SettingsSection>
        <div className="kp-row" style={{ gap: 14, justifyContent: 'flex-start', padding: '14px 0' }}>
          <div className="kp-avatar flex h-12 w-12 items-center justify-center rounded-full bg-kraki-500/15 text-base font-bold text-kraki-500">
            {(state.user.email ?? state.user.login).slice(0, 2).toUpperCase()}
          </div>
          <div>
            <p className="kp-account-name text-sm font-semibold">{state.user.email ?? state.user.login}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-secondary">
              <CheckCircle size={10} color="#34D399" />
              {t('account.signedInVia', { provider: providerLabel(state.user.provider) })}
            </p>
          </div>
        </div>
      </SettingsSection>
      <SettingsSection title={t('account.identity')}>
        <SettingsRow label={t('account.login')}>
          <span className="text-text-secondary">{state.user.login}</span>
        </SettingsRow>
        {state.user.email && (
          <SettingsRow label={t('account.email')}>
            <span>{state.user.email}</span>
          </SettingsRow>
        )}
      </SettingsSection>
      <SettingsSection>
        <div className="kp-row">
          <button type="button" className="kp-button text-red-600" onClick={() => setConfirmSignOut(true)}>
            {t('signOut.action')}
          </button>
        </div>
      </SettingsSection>
      {state.status === 'connected' && (
        <div className="kp-section kp-section-untitled">
          <DeleteAccountSection />
        </div>
      )}
    </>
  ) : (
    <p className="text-center text-text-secondary">{t('account.notSignedIn')}</p>
  );
  const notifications = (
    <>
      <SettingsSection title={t('notifications.systemPermission')}>
        <SettingsRow label={t('notifications.status')}>
          <span className="text-text-secondary">
            {(os?.notificationPermission ?? permission) === 'granted'
              ? t('notifications.granted')
              : (os?.notificationPermission ?? permission) === 'denied'
                ? desktop ? t('notifications.deniedSystem') : t('notifications.deniedSite')
                : t('notifications.notAsked')}
          </span>
        </SettingsRow>
        <div className="kp-row" style={{ justifyContent: 'flex-start' }}>
          {!desktop && isPushSupported() && permission === 'default' && (
            <button
              type="button"
              className="kp-button"
              onClick={() => {
                void Notification.requestPermission().then(setPermission);
              }}
            >
              {t('notifications.allow')}
            </button>
          )}
          {bridge?.openNotificationSettings && (
            <button type="button" className="kp-button" onClick={bridge.openNotificationSettings}>
              {t('notifications.openSettings')}
            </button>
          )}
        </div>
      </SettingsSection>
      <SettingsSection title={t('notifications.inApp')}>
        <SettingsRow label={t('notifications.notify')}>
          <SettingsSwitch
            label={t('notifications.notify')}
            on={notificationsEnabled}
            disabled={pushLoading}
            onChange={(on) => {
              void updateNotifications(on);
            }}
          />
        </SettingsRow>
        <p className="kp-foot">
          {t(desktop ? 'notifications.footerDesktop' : 'notifications.footerWeb')}
        </p>
      </SettingsSection>
      {!desktop && (
        <SettingsSection title={t('notifications.webPush')}>
          <p className="kp-foot" style={{ border: 0 }}>
            {state.vapidPublicKey && isPushSupported()
              ? pushEnabled
                ? t('notifications.pushOn')
                : t('notifications.pushOff')
              : t('notifications.unavailable')}
          </p>
        </SettingsSection>
      )}
    </>
  );
  const devices = (
    <>
      <SettingsSection title={t('tabs.devices')}>
        {[...state.devices.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((d) => (
            <div key={d.id} className="kp-device">
              <div className="kp-row" style={{ gap: 10 }}>
                <span
                  className={`h-2 w-2 shrink-0 rounded-full${d.online ? '' : ' kp-offline-dot'}`}
                  style={d.online ? { background: '#34D399' } : undefined}
                />
                <div className="min-w-0 flex-1">
                  <div className="kp-device-name flex font-medium"><DeviceNameEditor device={d} /></div>
                  <div className="kp-device-meta">
                    <span className="text-[10px] font-semibold uppercase tracking-[.4px]">{d.role === 'tentacle' ? t('devices.computer') : t('devices.app')}</span>
                    {d.role === 'tentacle' && <span>{state.deviceVersions.get(d.id)}</span>}
                    {!d.online && deviceLastOnline(d.lastSeen) && <span>{t('devices.lastOnline', { time: deviceLastOnline(d.lastSeen) })}</span>}
                  </div>
                </div>
                {builtInKnown && !d.online && d.id !== state.deviceId && d.id !== builtInId ? (
                  <button type="button" className="kp-button" onClick={() => setRemoving(d)}>
                    {t('devices.removeAction')}
                  </button>
                ) : (
                  <span className="font-mono text-[10px] text-text-muted" title={d.id}>
                    {d.id.slice(0, 10)}…
                  </span>
                )}
              </div>
              <DeviceUpdateBox device={d} />
            </div>
          ))}
      </SettingsSection>
      {desktop?.builtIn?.connectPhone && (
        <SettingsSection>
          <div className="kp-row">
            <Smartphone size={20} className="text-kraki-500" />
            <div>
              <p>{t('devices.phone')}</p>
              <p className="kp-foot">{t('devices.phoneHint')}</p>
            </div>
            <button
              type="button"
              className="kp-button shrink-0"
              onClick={() => window.dispatchEvent(new Event(CONNECT_PHONE_EVENT))}
            >
              {t('devices.showCode')}
            </button>
          </div>
        </SettingsSection>
      )}
    </>
  );
  const about = (
    <div className="kp-about">
      <img src="/settings-logo-light.png" alt="Kraki" className="kp-about-logo dark:hidden" />
      <img src="/settings-logo-dark.png" alt="" className="kp-about-logo hidden dark:block" />
      <div className="text-center">
        <p className="kp-brand-title font-mono text-[18px] font-black tracking-[3.5px]">KRAKI</p>
        <p className="mt-1 text-[10px] font-medium uppercase tracking-[.3px] text-text-muted">
          {t('about.tagline')}
        </p>
      </div>
      <dl className="mt-1.5 space-y-[3px]">
        {diagnostics().map(([label, value]) => (
          <div className="kp-diagnostic" key={label}>
            <dt>{label.toUpperCase()}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <button
        type="button"
        className="kp-button"
        onClick={() => {
          void navigator.clipboard
            .writeText(diagnostics(true).map(([label, value]) => `${label}: ${value}`).join('\n'))
            .then(() => setDiagCopied(true))
            .catch(() => setError({ key: 'copyDiagnostics' }));
        }}
      >
        {diagCopied ? t('about.copied') : t('about.copyDiagnostics')}
      </button>
      {desktop && <BuildProvenance info={desktop.buildInfo} />}
      <hr className="my-1.5 w-[220px] border-border-primary" />
      <div className="flex flex-wrap justify-center gap-4 text-xs font-medium text-kraki-500">
        {[
          [t('about.privacy'), 'https://app.kraki.chat/privacy/'],
          [t('about.website'), 'https://kraki.chat'],
          [t('about.documentation'), 'https://kraki.chat/docs'],
          ['GitHub', 'https://github.com/corelli18512/kraki'],
        ].map(([label, href]) => (
          <a key={label} href={href} target="_blank" rel="noreferrer">
            {label}
          </a>
        ))}
      </div>
      <p className="mt-auto text-[10px] text-text-muted">© 2026 Kraki</p>
    </div>
  );
  if (!open) return null;
  return (
    <div className={className} style={isWindows && inline ? { height: '100%', minHeight: 0 } : undefined}>
      {isWindows && !inline && <div className="kp-windows-backdrop" aria-hidden="true" />}
      <div
        ref={windowRef}
        className={`${inline ? 'kp-inline' : 'kp-window'}${isWindows ? ' kp-windows' : ''}`}
        role="dialog"
        aria-modal={isWindows && !inline ? true : undefined}
        aria-label={t('title')}
        data-testid="settings-window"
      >
        <div className="kp-title">
          {isWindows ? <><h2>{tabLabel(tab)}</h2><p className="kp-page-description">{t(`tabDescriptions.${tabKeys[tab]}`)}</p></> : tabLabel(tab)}
          <button type="button" className="kp-close" aria-label={t('close')} onClick={onClose}>
            <X size={isWindows ? 16 : 14} strokeWidth={1.6} />
          </button>
        </div>
        <div className={isWindows ? 'kp-navigation' : undefined} style={isWindows ? undefined : { display: 'contents' }}>
          {isWindows && <><div className="kp-nav-brand"><KrakiLogo className="kp-nav-logo" /><span>Kraki</span></div><p className="kp-nav-label">{t('title')}</p></>}
          <div className="kp-tabs" role="tablist" aria-label={t('title')} aria-orientation={isWindows ? 'vertical' : undefined}>
            {tabs.map((name) => (
              <button
                type="button"
                role="tab"
                aria-selected={tab === name}
                tabIndex={tab === name ? 0 : -1}
                onKeyDown={(e) => {
                  const previousKey = isWindows ? 'ArrowUp' : 'ArrowLeft';
                  const nextKey = isWindows ? 'ArrowDown' : 'ArrowRight';
                  if (![previousKey, nextKey, 'Home', 'End'].includes(e.key)) return;
                  e.preventDefault();
                  const buttons = [...e.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role=tab]')];
                  const index = buttons.indexOf(e.currentTarget);
                  const next =
                    e.key === 'Home'
                      ? 0
                      : e.key === 'End'
                        ? buttons.length - 1
                        : (index + (e.key === nextKey ? 1 : -1) + buttons.length) % buttons.length;
                  setTab(tabs[next]);
                  buttons[next].focus();
                }}
                aria-controls="settings-pane"
                aria-label={isWindows ? tabLabel(name) : undefined}
                title={isWindows ? tabLabel(name) : undefined}
                key={name}
                onClick={() => setTab(name)}
              >
                <SettingsTabIcon name={name} windows={isWindows} />
                <span>{tabLabel(name)}</span>
              </button>
            ))}
          </div>
          {isWindows && <button type="button" className="kp-nav-profile" aria-label={t('account.details')} onClick={() => setTab('Account')}>
            <span className="kp-nav-avatar" aria-hidden="true">{(state.user?.email ?? state.user?.login ?? '?').slice(0, 2).toUpperCase()}</span>
            <span className="kp-nav-identity"><strong>{state.user?.email ?? state.user?.login ?? t('account.notSignedInLabel')}</strong><small>{state.status === 'connected' ? t('account.connected') : t('account.disconnected')}</small></span>
            <ChevronRight size={14} aria-hidden="true" />
          </button>}
        </div>
        <div
          id="settings-pane"
          role="tabpanel"
          tabIndex={isWindows ? 0 : undefined}
          aria-label={tabLabel(tab)}
          className={`kp-pane${tab === 'About' ? ' kp-pane-about' : ''}`}
          data-testid="settings-scroll"
          key={tab}
        >
          {tab === 'General' ? (
            general
          ) : tab === 'Account' ? (
            account
          ) : tab === 'Voice Input' ? (
            <VoiceSettings />
          ) : tab === 'Notifications' ? (
            notifications
          ) : tab === 'This PC' ? (
            desktop?.builtIn ? (
              <ThisPCSettings builtIn={desktop.builtIn} />
            ) : (
              <p className="kp-foot">
                {t('thisPC.browserHint')}
              </p>
            )
          ) : tab === 'Devices' ? (
            devices
          ) : (
            about
          )}
          {errorText && (
            <p role="alert" className="mt-2 text-xs text-red-500">
              {errorText}
            </p>
          )}
          {tab === 'General' && !desktop && state.user?.preferences?.internal === true && (
            <SettingsSection title="Dogfood">
              <SettingsRow label="Builds" detail="Internal account: you get every new build first.">
                <span data-testid="release-channel">{isBeta ? 'Dogfood' : 'Switching…'}</span>
              </SettingsRow>
            </SettingsSection>
          )}
        </div>
        {confirmSignOut && (
          <SettingsAlert
            title={t(desktop ? 'signOut.titlePC' : 'signOut.titleBrowser')}
            body={t(desktop ? 'signOut.bodyPC' : 'signOut.bodyBrowser')}
            confirm={t('signOut.confirm')}
            onCancel={() => setConfirmSignOut(false)}
            onConfirm={() => {
              signOut();
              onClose();
            }}
          />
        )}
        {removing && (
          <SettingsAlert
            title={t('devices.removeTitle', { name: removing.name })}
            body={t('devices.removeBody')}
            confirm={t('devices.remove')}
            onCancel={() => setRemoving(null)}
            onConfirm={() => {
              wsClient.removeDevice(removing.id);
              setRemoving(null);
            }}
          />
        )}
      </div>
    </div>
  );
}
