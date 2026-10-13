/**
 * Desktop shell bridge (packages/desktop, Electron). The preload script
 * exposes `window.krakiDesktop`; in a normal browser it is undefined and every
 * helper here is a no-op, so the Web app runs unchanged in both.
 */
export interface BuiltInState {
  available: boolean;
  version: string | null;
  configured: boolean;
  signedIn: boolean;
  deviceName: string;
  /** This PC's id as a Kraki computer (its tentacle device id). */
  deviceId: string | null;
  relay: string | null;
  owned: boolean;
  running: boolean;
  relayState: string | null;
  cliDaemon: boolean;
  cliLogin: boolean;
}

export type AgentCheckEvent =
  | { event: 'checking'; id: string; name: string }
  | { event: 'agent'; id: string; name: string; status: 'ready' | 'needs_login' | 'not_installed' | 'error'; version?: string; models: number; sampleModels: string[]; hint?: string; installUrl: string }
  | { event: 'done'; ready: string[] };

export type SetupEvent =
  | { event: 'start'; version: string }
  | { event: 'oauth_url'; url: string }
  | { event: 'device_code'; userCode: string; verificationUri: string }
  | { event: 'authenticated'; username: string }
  | { event: 'relay'; relay: string }
  | { event: 'done'; username: string; deviceName: string; relay: string }
  | { event: 'error'; code: string; message: string };

/** The Kraki built into the desktop app (Windows), like Kraki for Mac's. */
export interface BuiltInBridge {
  state: () => Promise<BuiltInState>;
  checkAgents: (onEvent: (e: AgentCheckEvent) => void) => Promise<{ ok: boolean }>;
  setup: (opts: { deviceName?: string; forceLogin?: boolean; useCode?: boolean }, onEvent: (e: SetupEvent) => void) => Promise<{ ok: boolean; username?: string; code?: string }>;
  cancelSetup: () => void;
  showSignInWindow?: () => void;
  /** `kraki connect --json`: a pairing link for a phone (needs the daemon). */
  connectPhone: () => Promise<{ ok: boolean; url?: string; token?: string; expiresAt?: string; error?: string }>;
  enable: () => Promise<{ ok: boolean; error?: string }>;
  disable: (opts?: { keepOwnership?: boolean }) => Promise<{ ok: boolean; error?: string }>;
  externalPresence?: (action: 'start' | 'stop' | 'restart') => Promise<{ ok: boolean; error?: string }>;
  restart: () => Promise<{ ok: boolean; error?: string }>;
  /** The relay + GitHub token the app signs in with (same account). */
  credentials: () => { relay: string; token: string | null } | null;
  openLogs: () => void;
  logsPath?: () => Promise<string>;
  showLogsInExplorer?: () => void;
}

export interface DesktopSettingsState {
  usageShortcut: string;
  usageShortcutEnabled: boolean;
  launchAtLogin: boolean;
  keepRunningInTray: boolean;
  notificationPermission: 'granted' | 'denied' | 'default';
  logsPath: string | null;
  allowRemoteUpdates: boolean;
  externalCliPath?: string | null;
  externalCliVersion?: string | null;
}

export interface DesktopSettingsBridge {
  state: () => Promise<DesktopSettingsState>;
  setUsageShortcut?: (shortcut: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  setLaunchAtLogin?: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  setKeepRunningInTray?: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  openNotificationSettings?: () => void;
  showLogsInExplorer?: () => void;
  locateCli?: () => Promise<{ ok: boolean; error?: string }>;
  recheckCli?: () => Promise<{ ok: boolean; error?: string }>;
  setAllowRemoteUpdates?: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
}

export interface KrakiDesktopBridge {
  platform: string;
  /** Device name shown to other devices ("Kraki Windows"). */
  deviceName: string;
  builtIn?: BuiltInBridge;
  settings?: DesktopSettingsBridge;
  version: string;
  /** Origin GitHub redirects back to after OAuth (the shell intercepts it). */
  oauthRedirectOrigin: string;
  notify: (n: { title: string; body: string; sessionId?: string }) => void;
  setBadge: (count: number) => void;
  onOpenSession: (handler: (sessionId: string) => void) => () => void;
  /** Sessions waiting on you, for the tray menu (Kraki for Windows). */
  setNeedsYou?: (list: { id: string; title: string; reason: string }[]) => void;
  /** Tray › Account Usage / Settings… */
  onOpen?: (what: 'usage' | 'settings', handler: () => void) => () => void;
  /** Contents of `<KRAKI_HOME>/local-link.json` (the Tentacle on this
   *  machine), or null. Absent in shells without local-link support. */
  localLinkDiscovery?: () => Promise<string | null>;
}

declare global {
  interface Window { krakiDesktop?: KrakiDesktopBridge }
}

export const desktop: KrakiDesktopBridge | undefined =
  typeof window !== 'undefined' ? window.krakiDesktop : undefined;

export const isDesktop = !!desktop;

const SIGNED_OUT_KEY = 'kraki-desktop.signedOut';

/**
 * The account of the Kraki built into the desktop app, unless the user signed
 * the app out (then setup asks to sign in again, like Kraki for Mac).
 */
export function desktopCredentials(): { relay: string; token: string | null } | null {
  if (!desktop?.builtIn) return null;
  if (localStorage.getItem(SIGNED_OUT_KEY) === '1') return null;
  return desktop.builtIn.credentials();
}

export function setDesktopSignedOut(signedOut: boolean): void {
  if (signedOut) localStorage.setItem(SIGNED_OUT_KEY, '1');
  else localStorage.removeItem(SIGNED_OUT_KEY);
}

export function isDesktopSignedOut(): boolean {
  return localStorage.getItem(SIGNED_OUT_KEY) === '1';
}
