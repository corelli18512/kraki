import { useEffect, useState } from 'react';
import { Bell, CheckCircle, CircleUser, Info, Laptop, Mic, Monitor, Settings, Smartphone, X } from 'lucide-react';
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
import { CHANNEL_SWITCHING_ENABLED, getCurrentChannel, setChannel } from '../../lib/auth';
import { version } from '../../../package.json';
import { ArchiveSettings } from '../sessions/ArchivedSessions';
import { CONNECT_PHONE_EVENT } from '../devices/ConnectPhoneCard';
import { DeviceUpdateBox } from '../devices/DeviceUpdateBox';
import { signOut } from './ProfileBar';
import { setUsageShortcut, shortcutFromEvent, useUsageShortcut } from '../../lib/usage-shortcut';
import './settings.css';
import {
  notificationsEnabled as readNotificationsEnabled,
  setNotificationsEnabled as saveNotificationsEnabled,
} from '../../lib/notification-prefs';

const tabs = [
  ['General', Settings],
  ['Account', CircleUser],
  ['Voice Input', Mic],
  ['Notifications', Bell],
  ['This PC', Monitor],
  ['Devices', Laptop],
  ['About', Info],
] as const;

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
  const { theme, setTheme } = useTheme();
  const state = useStore();
  const [tab, setTab] = useState<string>('General');
  const [diagCopied, setDiagCopied] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [builtInId, setBuiltInId] = useState<string | null>(null);
  const [os, setOs] = useState<DesktopSettingsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(readNotificationsEnabled);
  const [permission, setPermission] = useState(getPushPermission());
  const shortcut = useUsageShortcut();
  const bridge = desktop?.settings;
  const isBeta = getCurrentChannel() === 'beta';

  useEffect(() => {
    if (!open) return;
    if (isPushSupported()) void isPushSubscribed().then(setPushEnabled);
    void desktop?.builtIn?.state().then((s) => setBuiltInId(s.deviceId));
    void bridge
      ?.state()
      .then((s) => {
        setOs(s);
        setUsageShortcut(s.usageShortcut, s.usageShortcutEnabled);
      })
      .catch(() => setError('Couldn’t read system preferences.'));
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
      useUsageShortcut.setState({ recording: false });
    };
  }, [open, onClose, inline]);

  async function updateOs(fn: (() => Promise<{ ok: boolean; error?: string }>) | undefined) {
    if (!fn) return;
    try {
      const result = await fn();
      setError(result.ok ? null : (result.error ?? 'Couldn’t save this preference.'));
      if (result.ok && bridge) setOs(await bridge.state());
    } catch {
      setError('Couldn’t save this preference.');
    }
  }
  async function updateShortcut(key: string, enabled: boolean) {
    if (bridge?.setUsageShortcut) {
      try {
        const result = await bridge.setUsageShortcut(key, enabled);
        if (!result.ok) {
          setError(result.error ?? 'Couldn’t register this shortcut.');
          return;
        }
      } catch {
        setError('Couldn’t register this shortcut.');
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
            setError('Couldn’t turn off push notifications.');
            return;
          }
          wsClient.unregisterPushToken({ provider: 'web_push' });
          setPushEnabled(false);
        } else if (state.vapidPublicKey) {
          const token = await subscribeToPush(state.vapidPublicKey);
          if (!token) {
            setError('Notifications are blocked. Turn them on in site Settings.');
            return;
          }
          wsClient.registerPushToken({ provider: 'web_push', token });
          setPushEnabled(true);
        }
      } catch {
        setError('Couldn’t update push notifications.');
        return;
      } finally {
        setPushLoading(false);
        setPermission(getPushPermission());
      }
    }
    saveNotificationsEnabled(on);
    setNotificationsEnabled(on);
  }
  const diagnostics = [
    ['Background Service', os ? (state.deviceVersions.get(builtInId ?? '') ?? '—') : '—'],
    [desktop ? 'Kraki Windows' : 'Kraki Web', `${desktop?.version ?? version}${isBeta ? '-beta' : ''}`],
    ...[...state.devices.values()]
      .filter((d) => d.role === 'tentacle')
      .map((d) => [d.name, `Kraki ${state.deviceVersions.get(d.id) ?? '—'}`]),
    ['Relay', `${new URL(wsClient.url || 'ws://localhost').hostname} · ${state.relayVersion ?? '—'}`],
  ];
  const general = (
    <>
      <SettingsSection title="Appearance">
        <SettingsRow label="Theme">
          <div className="kp-segment" role="radiogroup" aria-label="Theme">
            {(['system', 'light', 'dark'] as const).map((option) => (
              <button
                type="button"
                role="radio"
                aria-checked={theme === option}
                key={option}
                onClick={() => {
                  setTheme(option);
                  wsClient.updatePreferences({ theme: option });
                }}
              >
                {option[0].toUpperCase() + option.slice(1)}
              </button>
            ))}
          </div>
        </SettingsRow>
        <div className="kp-row kp-palette" style={{ justifyContent: 'flex-start', gap: 6 }}>
          {['#FBBF24', '#34D399', '#22D3EE', '#F4836E', '#6366F1'].map((color) => (
            <span key={color} style={{ width: 12, height: 12, borderRadius: '50%', background: color }} />
          ))}
          <span className="kp-foot" style={{ fontWeight: 500 }}>
            Brand palette preview
          </span>
        </div>
      </SettingsSection>
      <SettingsSection title="Account Usage">
        <SettingsRow label={`Hold ${shortcut.shortcut} to peek at account usage`}>
          <SettingsSwitch
            label="Peek at account usage"
            on={shortcut.enabled}
            onChange={(on) => {
              void updateShortcut(shortcut.shortcut, on);
            }}
          />
        </SettingsRow>
        <SettingsRow label="Shortcut">
          <button
            type="button"
            className="kp-button"
            style={{ width: 230, height: 26 }}
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
            {shortcut.recording ? 'Press a shortcut…' : shortcut.shortcut}
          </button>
        </SettingsRow>
        <p className="kp-foot">
          Click the shortcut to choose another key: F1–F20, or a combination with Ctrl, Alt or Win. With Kraki in front
          the panel opens inside its window{bridge?.setUsageShortcut ? '; over other apps it floats' : ''}. “Account
          Usage” {desktop ? 'in the tray' : 'in the sidebar'} opens it any time.
        </p>
      </SettingsSection>
      <section className="kp-section"><h3>Sessions</h3><ArchiveSettings /></section>
      {bridge && os && (
        <SettingsSection title="Behavior">
          {bridge.setKeepRunningInTray && (
            <SettingsRow label="Keep running in tray when window closes">
              <SettingsSwitch
                label="Keep running in tray when window closes"
                on={os.keepRunningInTray}
                onChange={(on) => {
                  void updateOs(() => bridge.setKeepRunningInTray!(on));
                }}
              />
            </SettingsRow>
          )}
          {bridge.setLaunchAtLogin && (
            <SettingsRow label="Open Kraki at login">
              <SettingsSwitch
                label="Open Kraki at login"
                on={os.launchAtLogin}
                onChange={(on) => {
                  void updateOs(() => bridge.setLaunchAtLogin!(on));
                }}
              />
            </SettingsRow>
          )}
        </SettingsSection>
      )}
    </>
  );
  const account = state.user ? (
    <>
      <SettingsSection>
        <div className="kp-row" style={{ gap: 14, justifyContent: 'flex-start', padding: '14px 0' }}>
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-kraki-500/15 text-base font-bold text-kraki-500">
            {(state.user.email ?? state.user.login).slice(0, 2).toUpperCase()}
          </div>
          <div>
            <p className="text-sm font-semibold">{state.user.email ?? state.user.login}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-secondary">
              <CheckCircle size={10} color="#34D399" />
              Signed in via{' '}
              {state.user.provider === 'github'
                ? 'GitHub'
                : state.user.provider === 'open'
                  ? 'Open authentication'
                  : state.user.provider}
            </p>
          </div>
        </div>
      </SettingsSection>
      <SettingsSection title="Identity">
        <SettingsRow label="Login">
          <span className="text-text-secondary">{state.user.login}</span>
        </SettingsRow>
        {state.user.email && (
          <SettingsRow label="Email">
            <span>{state.user.email}</span>
          </SettingsRow>
        )}
        <SettingsRow label="Device ID">
          <span title={state.deviceId ?? ''} className="text-text-secondary">
            {state.deviceId?.slice(0, 12)}…
          </span>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection>
        <div className="kp-row">
          <button type="button" className="kp-button text-red-600" onClick={() => setConfirmSignOut(true)}>
            Sign Out…
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
    <p className="text-center text-text-secondary">Not signed in.</p>
  );
  const notifications = (
    <>
      <SettingsSection title="System permission">
        <SettingsRow label="Status">
          <span className="text-text-secondary">
            {(os?.notificationPermission ?? permission) === 'granted'
              ? 'Granted'
              : (os?.notificationPermission ?? permission) === 'denied'
                ? `Off — turn on in ${desktop ? 'System' : 'site'} Settings`
                : 'Not asked yet'}
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
              Allow Notifications…
            </button>
          )}
          {bridge?.openNotificationSettings && (
            <button type="button" className="kp-button" onClick={bridge.openNotificationSettings}>
              Open System Settings…
            </button>
          )}
        </div>
      </SettingsSection>
      <SettingsSection title="In-app">
        <SettingsRow label="Notify me when an agent replies or needs me">
          <SettingsSwitch
            label="Notify me when an agent replies or needs me"
            on={notificationsEnabled}
            disabled={pushLoading}
            onChange={(on) => {
              void updateNotifications(on);
            }}
          />
        </SettingsRow>
        <p className="kp-foot">
          Shown while Kraki is running{desktop ? ' (also from the tray)' : ''}, except for the Session you are looking
          at.
        </p>
      </SettingsSection>
      {!desktop && (
        <SettingsSection title="Web Push">
          <p className="kp-foot" style={{ border: 0 }}>
            {state.vapidPublicKey && isPushSupported()
              ? pushEnabled
                ? 'Push notifications are on, including when this browser is closed.'
                : 'Turn notifications on to receive replies and requests when this browser is closed.'
              : 'Push notifications aren’t available with this relay.'}
          </p>
        </SettingsSection>
      )}
    </>
  );
  const devices = (
    <>
      <SettingsSection title="Paired devices">
        {[...state.devices.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((d) => (
            <div key={d.id}>
              <div className="kp-row" style={{ gap: 10 }}>
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: d.online ? '#34D399' : '#94a3b880' }}
                />
                <div className="flex-1">
                  <p className="font-medium">{d.name}</p>
                  <p className="text-[10px] font-semibold uppercase tracking-[.4px] text-text-muted">
                    {d.role === 'tentacle' ? 'Computer' : 'App'}{' '}
                    {d.role === 'tentacle' && state.deviceVersions.get(d.id)}
                  </p>
                </div>
                {!d.online && d.id !== state.deviceId && d.id !== builtInId ? (
                  <button type="button" className="kp-button" onClick={() => setRemoving(d)}>
                    Remove…
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
              <p>Use Kraki on your phone</p>
              <p className="kp-foot">Scan a code with your phone to see and run your sessions there.</p>
            </div>
            <button
              type="button"
              className="kp-button shrink-0"
              onClick={() => window.dispatchEvent(new Event(CONNECT_PHONE_EVENT))}
            >
              Show Code…
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
          Multi-device · Multi-agent · Coding
        </p>
      </div>
      <dl className="mt-1.5 space-y-[3px]">
        {diagnostics.map(([label, value]) => (
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
            .writeText(diagnostics.map(([label, value]) => `${label}: ${value}`).join('\n'))
            .then(() => setDiagCopied(true))
            .catch(() => setError('Couldn’t copy diagnostics.'));
        }}
      >
        {diagCopied ? 'Copied' : 'Copy Diagnostics'}
      </button>
      <hr className="my-1.5 w-[220px] border-border-primary" />
      <div className="flex gap-4 text-xs font-medium text-kraki-500">
        {[
          ['Website', 'https://kraki.chat'],
          ['Documentation', 'https://kraki.chat/docs'],
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
    <div className={className}>
      <div
        className={inline ? 'kp-inline' : 'kp-window'}
        role="dialog"
        aria-label="Settings"
        data-testid="settings-window"
      >
        <div className="kp-title">
          {tab}
          <button type="button" className="kp-close" aria-label="Close settings" onClick={onClose}>
            <X size={9} />
          </button>
        </div>
        <div className="kp-tabs" role="tablist" aria-label="Settings">
          {tabs.map(([name, Icon]) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab === name}
              aria-controls="settings-pane"
              key={name}
              onClick={() => setTab(name)}
            >
              <Icon />
              {name}
            </button>
          ))}
        </div>
        <div
          id="settings-pane"
          role="tabpanel"
          aria-label={tab}
          className="kp-pane"
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
                Run Kraki for Windows to run agents on this PC. The browser controls your other computers.
              </p>
            )
          ) : tab === 'Devices' ? (
            devices
          ) : (
            about
          )}
          {error && (
            <p role="alert" className="mt-2 text-xs text-red-500">
              {error}
            </p>
          )}
          {tab === 'General' && state.user?.preferences?.internal === true && CHANNEL_SWITCHING_ENABLED && (
            <SettingsSection title="Dogfood">
              <SettingsRow label="Beta channel">
                <SettingsSwitch
                  label="Beta channel"
                  on={isBeta}
                  onChange={() => {
                    const next = isBeta ? 'stable' : 'beta';
                    wsClient.updatePreferences({ channel: next });
                    setChannel(next);
                  }}
                />
              </SettingsRow>
            </SettingsSection>
          )}
        </div>
        {confirmSignOut && (
          <SettingsAlert
            title={`Sign out of Kraki on ${desktop ? 'this PC' : 'this browser'}?`}
            body={`Conversations cached ${desktop ? 'on this PC' : 'in this browser'} are removed. Your computers keep all sessions; sign in again to see them.`}
            confirm="Sign Out"
            onCancel={() => setConfirmSignOut(false)}
            onConfirm={() => {
              signOut();
              onClose();
            }}
          />
        )}
        {removing && (
          <SettingsAlert
            title={`Remove ${removing.name}?`}
            body="It's signed out of your account. To use it again, sign in or pair it again."
            confirm="Remove"
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
