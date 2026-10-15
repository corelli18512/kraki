// Exposes a small, fixed bridge to the Web client (lib/desktop.ts). No Node
// or Electron objects reach the page.
const { contextBridge, ipcRenderer } = require('electron');

// Set by the main process (webPreferences.additionalArguments).
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? '').split('=').slice(1).join('=');

contextBridge.exposeInMainWorld('krakiDesktop', {
  // Browser report copies are exported by the main process, not page paths.
  exportHtmlReport: (html, name) => ipcRenderer.invoke('kraki:export-html-report', html, name),
  platform: process.platform,
  version: arg('kraki-version'),
  buildInfo: ipcRenderer.sendSync('kraki:build-info'),
  oauthRedirectOrigin: arg('kraki-oauth-origin') || 'https://app.kraki.chat',
  notify: (n) => ipcRenderer.send('kraki:notify', {
    title: String(n?.title ?? ''), body: String(n?.body ?? ''), sessionId: n?.sessionId ? String(n.sessionId) : undefined,
  }),
  deviceName: arg('kraki-device-name') || 'Kraki Desktop',
  hostName: arg('kraki-host'),
  setBadge: (count) => ipcRenderer.send('kraki:badge', Number(count) || 0),
  builtIn: arg('kraki-builtin') === '1' ? {
    state: () => ipcRenderer.invoke('kraki:builtin-state'),
    checkAgents: async (onEvent) => {
      const listener = (_e, ev) => onEvent(ev);
      ipcRenderer.on('kraki:builtin-agent-event', listener);
      try { return await ipcRenderer.invoke('kraki:builtin-agents'); } finally { ipcRenderer.removeListener('kraki:builtin-agent-event', listener); }
    },
    setup: async (opts, onEvent) => {
      const listener = (_e, ev) => onEvent(ev);
      ipcRenderer.on('kraki:builtin-setup-event', listener);
      try { return await ipcRenderer.invoke('kraki:builtin-setup', opts ?? {}); } finally { ipcRenderer.removeListener('kraki:builtin-setup-event', listener); }
    },
    cancelSetup: () => ipcRenderer.send('kraki:builtin-cancel-setup'),
    showSignInWindow: () => ipcRenderer.send('kraki:builtin-show-signin'),
    connectPhone: () => ipcRenderer.invoke('kraki:builtin-connect'),
    enable: () => ipcRenderer.invoke('kraki:builtin-enable'),
    disable: (opts) => ipcRenderer.invoke('kraki:builtin-disable', opts),
    externalPresence: (action) => ipcRenderer.invoke('kraki:builtin-external-presence', action),
    restart: () => ipcRenderer.invoke('kraki:builtin-restart'),
    credentials: () => ipcRenderer.sendSync('kraki:builtin-credentials'),
    openLogs: () => ipcRenderer.send('kraki:builtin-open-logs'),
    logsPath: () => ipcRenderer.invoke('kraki:builtin-logs-path'),
    showLogsInExplorer: () => ipcRenderer.send('kraki:builtin-show-logs'),
  } : undefined,
  settings: {
    state: () => ipcRenderer.invoke('kraki:settings-state'),
    setUsageShortcut: (shortcut, enabled) => ipcRenderer.invoke('kraki:settings-shortcut', shortcut, enabled),
    setLaunchAtLogin: (enabled) => ipcRenderer.invoke('kraki:settings-login', enabled),
    setKeepRunningInTray: (enabled) => ipcRenderer.invoke('kraki:settings-tray', enabled),
    openNotificationSettings: () => ipcRenderer.send('kraki:settings-notifications'),
    showLogsInExplorer: () => ipcRenderer.send('kraki:builtin-show-logs'),
    locateCli: () => ipcRenderer.invoke('kraki:settings-locate-cli'),
    recheckCli: () => ipcRenderer.invoke('kraki:settings-recheck-cli'),
    goOnline: () => ipcRenderer.invoke('kraki:settings-go-online'),
    goOffline: () => ipcRenderer.invoke('kraki:settings-go-offline'),
    setAllowRemoteUpdates: (enabled) => ipcRenderer.invoke('kraki:settings-remote-updates', enabled),
  },
  setNeedsYou: (list) => ipcRenderer.send('kraki:needs-you', list),
  localLinkDiscovery: () => ipcRenderer.invoke('kraki:local-link-discovery'),
  /** Tray › Account Usage / Settings… */
  onOpen: (what, handler) => {
    const channel = what === 'usage' ? 'kraki:open-usage' : 'kraki:open-settings';
    const listener = () => handler();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onOpenSession: (handler) => {
    const listener = (_e, sessionId) => handler(String(sessionId));
    ipcRenderer.on('kraki:open-session', listener);
    return () => ipcRenderer.removeListener('kraki:open-session', listener);
  },
});
