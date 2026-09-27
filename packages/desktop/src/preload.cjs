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
  setBadge: (count) => ipcRenderer.send('kraki:badge', Number(count) || 0),
  onOpenSession: (handler) => {
    const listener = (_e, sessionId) => handler(String(sessionId));
    ipcRenderer.on('kraki:open-session', listener);
    return () => ipcRenderer.removeListener('kraki:open-session', listener);
  },
});
