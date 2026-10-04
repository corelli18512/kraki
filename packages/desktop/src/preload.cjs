// Exposes a small, fixed bridge to the Web client (lib/desktop.ts). No Node
// or Electron objects reach the page.
const { contextBridge, ipcRenderer } = require('electron');

// Set by the main process (webPreferences.additionalArguments).
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? '').split('=').slice(1).join('=');

contextBridge.exposeInMainWorld('krakiDesktop', {
  platform: process.platform,
  version: arg('kraki-version'),
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
    connectPhone: () => ipcRenderer.invoke('kraki:builtin-connect'),
    enable: () => ipcRenderer.invoke('kraki:builtin-enable'),
    disable: () => ipcRenderer.invoke('kraki:builtin-disable'),
    restart: () => ipcRenderer.invoke('kraki:builtin-restart'),
    credentials: () => ipcRenderer.sendSync('kraki:builtin-credentials'),
    openLogs: () => ipcRenderer.send('kraki:builtin-open-logs'),
  } : undefined,
  onOpenSession: (handler) => {
    const listener = (_e, sessionId) => handler(String(sessionId));
    ipcRenderer.on('kraki:open-session', listener);
    return () => ipcRenderer.removeListener('kraki:open-session', listener);
  },
});
