// Kraki desktop shell (Electron). Serves the bundled Web client from
// app://kraki and adds what a browser tab cannot: a tray presence that keeps
// the relay connection (so replies, questions and approvals notify natively),
// a taskbar badge, single-instance behaviour, and in-window GitHub sign-in.
const {
  app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, nativeTheme,
  net, protocol, screen, shell,
} = require('electron');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const os = require('node:os');
const { BuiltInKraki } = require('./tentacle.cjs');

const SCHEME = 'app';
const HOST = 'kraki';
const APP_ORIGIN = `${SCHEME}://${HOST}`;
/** The Web's registered GitHub OAuth origin; its callback is intercepted. */
const OAUTH_REDIRECT_ORIGIN = process.env.KRAKI_OAUTH_ORIGIN || 'https://app.kraki.chat';
const OAUTH_CALLBACK_PATH = '/auth/callback';
const WEB_ROOT = path.join(__dirname, '..', 'app');
const ASSETS = path.join(__dirname, '..', 'build');

// Local testing only: remote debugging and a start query (relay / pairing).
if (process.env.KRAKI_DESKTOP_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.KRAKI_DESKTOP_DEBUG_PORT);
}
const START_QUERY = process.env.KRAKI_DESKTOP_QUERY || '';

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

if (process.platform === 'win32') app.setAppUserModelId('chat.kraki.desktop');
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;
let unread = 0;
/** @type {BuiltInKraki | null} */
let builtIn = null;

// ── Window state ──
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadBounds() {
  try {
    const b = JSON.parse(readFileSync(stateFile(), 'utf8'));
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
    });
    return visible ? b : null;
  } catch { return null; }
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch { /* ignore */ }
}

// ── app://kraki: the Web build, single-page-app fallback to index.html ──
function serveApp() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    let file = path.normalize(path.join(WEB_ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(WEB_ROOT) || !existsSync(file) || url.pathname === '/') {
      file = path.join(WEB_ROOT, 'index.html');
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

function isAppUrl(u) { return u.startsWith(`${APP_ORIGIN}/`) || u === APP_ORIGIN; }
function isGitHubAuth(u) {
  try {
    const h = new URL(u).hostname;
    return h === 'github.com' || h.endsWith('.github.com') || h === 'githubusercontent.com';
  } catch { return false; }
}

/** GitHub redirects to the Web's registered callback; bring it home. */
function oauthCallbackToApp(u) {
  if (!u.startsWith(OAUTH_REDIRECT_ORIGIN + OAUTH_CALLBACK_PATH)) return null;
  const parsed = new URL(u);
  return `${APP_ORIGIN}${OAUTH_CALLBACK_PATH}${parsed.search}`;
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  const bounds = loadBounds();
  win = new BrowserWindow({
    width: bounds?.width ?? 1240,
    height: bounds?.height ?? 820,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 400,
    minHeight: 560,
    show: false,
    title: 'Kraki',
    icon: path.join(ASSETS, 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#020617' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      // Local testing against a plain ws:// relay on the LAN only.
      allowRunningInsecureContent: process.env.KRAKI_DESKTOP_ALLOW_INSECURE === '1',
      additionalArguments: [
        `--kraki-version=${app.getVersion()}`,
        `--kraki-oauth-origin=${OAUTH_REDIRECT_ORIGIN}`,
        `--kraki-device-name=Kraki ${process.platform === 'win32' ? 'Windows' : 'Linux'}`,
        `--kraki-builtin=${builtIn?.available() ? '1' : '0'}`,
        `--kraki-host=${os.hostname()}`,
      ],
    },
  });
  if (bounds?.maximized) win.maximize();
  Menu.setApplicationMenu(null);

  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  win.on('close', (e) => {
    saveBounds();
    // Closing keeps Kraki running in the tray (replies still notify).
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.on('focus', () => win.flashFrame(false));

  const wc = win.webContents;
  // New windows (links, reports) open in the default browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const guard = (event, url) => {
    const callback = oauthCallbackToApp(url);
    if (callback) { event.preventDefault(); void win.loadURL(callback); return; }
    if (isAppUrl(url) || isGitHubAuth(url)) return; // sign-in stays in the window
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 4)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
      if (items.length) items.push({ type: 'separator' });
    }
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
    else if (p.selectionText) items.push({ role: 'copy' });
    if (p.linkURL && /^https?:/i.test(p.linkURL)) items.push({ label: 'Open Link in Browser', click: () => shell.openExternal(p.linkURL) });
    if (items.length) Menu.buildFromTemplate(items).popup();
  });
  // Keyboard: reload, dev tools (debug), zoom.
  wc.on('before-input-event', (event, input) => {
    const mod = input.control || input.meta;
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || (mod && input.key.toLowerCase() === 'r')) { wc.reload(); event.preventDefault(); }
    if (input.key === 'F12' || (mod && input.shift && input.key.toLowerCase() === 'i')) { wc.toggleDevTools(); event.preventDefault(); }
    if (mod && (input.key === '=' || input.key === '+')) { wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 3)); event.preventDefault(); }
    if (mod && input.key === '-') { wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3)); event.preventDefault(); }
    if (mod && input.key === '0') { wc.setZoomLevel(0); event.preventDefault(); }
  });

  void win.loadURL(`${APP_ORIGIN}/${START_QUERY ? `?${START_QUERY}` : ''}`);
}

// ── Tray + badge ──
function updateTray() {
  // One fixed icon: swapping the image made Windows drop the icon from the
  // notification area. Unread shows as the taskbar badge and in the tooltip.
  tray?.setToolTip(unread > 0 ? `Kraki — ${unread} unread` : 'Kraki');
}
function createTray() {
  const icon = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createFromPath(path.join(ASSETS, 'icon.png')).resize({ width: 16 }) : icon);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Kraki', click: showWindow },
    { type: 'separator' },
    { label: 'Quit Kraki', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
  updateTray();
  if (process.env.KRAKI_DESKTOP_LOG_NOTIFY) {
    setTimeout(() => {
      try { require('node:fs').appendFileSync(path.join(app.getPath('userData'), 'notify.log'), `${new Date().toISOString()} tray bounds=${JSON.stringify(tray.getBounds())} empty=${icon.isEmpty()}\n`); } catch { /* ignore */ }
    }, 3000);
  }
}

ipcMain.on('kraki:badge', (_e, count) => {
  unread = Math.max(0, Number(count) || 0);
  if (process.platform === 'darwin') app.setBadgeCount(unread);
  if (process.platform === 'linux') app.setBadgeCount(unread);
  if (process.platform === 'win32' && win) {
    const badge = nativeImage.createFromPath(path.join(ASSETS, 'badge.png'));
    win.setOverlayIcon(unread > 0 && !badge.isEmpty() ? badge : null, unread > 0 ? `${unread} unread` : '');
  }
  updateTray();
});

// ── The built-in Kraki (see tentacle.cjs) ──

/** The open GitHub sign-in window, closed again when setup is cancelled. */
let signInWindow = null;

/** GitHub sign-in in a window of our own; resolves with kraki://auth/callback?… */
function openSignInWindow(url) {
  return new Promise((resolve) => {
    if (signInWindow && !signInWindow.isDestroyed()) signInWindow.close();
    const child = new BrowserWindow({
      parent: win ?? undefined,
      modal: !!win,
      width: 520,
      height: 720,
      title: 'Sign in with GitHub',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'persist:github-signin' },
    });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      if (!child.isDestroyed()) child.close();
    };
    const intercept = (event, target) => {
      let parsed;
      try { parsed = new URL(target); } catch { return; }
      const desktopCallback = parsed.pathname === '/auth/callback/desktop' || parsed.protocol === 'kraki:';
      if (!desktopCallback) return;
      event.preventDefault();
      finish(`kraki://auth/callback${parsed.search}`);
    };
    child.webContents.on('will-redirect', intercept);
    child.webContents.on('will-navigate', intercept);
    child.webContents.setWindowOpenHandler(({ url: u }) => { void shell.openExternal(u); return { action: 'deny' }; });
    child.on('closed', () => { if (signInWindow === child) signInWindow = null; finish(null); });
    signInWindow = child;
    void child.loadURL(url);
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const safely = (fn) => async (...args) => {
  try { return { ok: true, ...(await fn(...args)) }; } catch (err) { return { ok: false, error: String(err?.message ?? err) }; }
};

ipcMain.handle('kraki:builtin-state', () => builtIn?.state() ?? null);
ipcMain.handle('kraki:builtin-agents', async () => builtIn.checkAgents((e) => send('kraki:builtin-agent-event', e)));
ipcMain.handle('kraki:builtin-setup', async (_e, opts) => builtIn.setup({
  deviceName: opts?.deviceName,
  forceLogin: !!opts?.forceLogin,
  onEvent: (e) => send('kraki:builtin-setup-event', e),
  openSignIn: openSignInWindow,
}));
ipcMain.handle('kraki:builtin-connect', () => builtIn?.connectPhone() ?? { ok: false, error: 'not_available' });
ipcMain.on('kraki:builtin-cancel-setup', () => {
  builtIn?.cancelSetup();
  if (signInWindow && !signInWindow.isDestroyed()) signInWindow.close();
});
ipcMain.handle('kraki:builtin-enable', safely(() => builtIn.enable()));
ipcMain.handle('kraki:builtin-disable', safely(() => builtIn.disable()));
ipcMain.handle('kraki:builtin-restart', safely(() => builtIn.restart()));
ipcMain.on('kraki:builtin-credentials', (e) => { e.returnValue = builtIn?.credentials() ?? null; });
ipcMain.on('kraki:builtin-open-logs', () => { if (builtIn) void shell.openPath(path.join(builtIn.home(), 'logs')); });

ipcMain.on('kraki:notify', (_e, n) => {
  if (!Notification.isSupported() || !n || typeof n.title !== 'string') return;
  const note = new Notification({
    title: String(n.title).slice(0, 120),
    body: String(n.body ?? '').slice(0, 240),
    icon: path.join(ASSETS, 'icon.png'),
    silent: false,
  });
  note.on('click', () => {
    showWindow();
    if (n.sessionId) win?.webContents.send('kraki:open-session', String(n.sessionId));
  });
  note.show();
  if (win && !win.isFocused()) win.flashFrame(true);
  if (process.env.KRAKI_DESKTOP_LOG_NOTIFY) {
    try { require('node:fs').appendFileSync(path.join(app.getPath('userData'), 'notify.log'), `${new Date().toISOString()} ${JSON.stringify(n)} shown=${Notification.isSupported()}\n`); } catch { /* ignore */ }
  }
});

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('activate', showWindow);

app.whenReady().then(async () => {
  builtIn = new BuiltInKraki({ resourcesPath: process.resourcesPath, appPath: process.execPath, appVersion: app.getVersion() });
  // An owned daemon that is not running (a crash loop gave up, or it was
  // stopped by an update) starts again with the app.
  if (builtIn.available()) {
    builtIn.state().then((s) => { if (s.owned && !s.running) return builtIn.start(); }).catch(() => {});
  }
  serveApp();
  createWindow();
  createTray();
});
