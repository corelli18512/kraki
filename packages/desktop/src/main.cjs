// Kraki desktop shell (Electron). Serves the bundled Web client from
// app://kraki and adds what a browser tab cannot: a tray presence that keeps
// the relay connection (so replies, questions and approvals notify natively),
// a taskbar badge, single-instance behaviour, and GitHub sign-in in a window of its own.
const {
  app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, globalShortcut, nativeImage, nativeTheme,
  net, protocol, screen, shell,
} = require('electron');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const os = require('node:os');
const { BuiltInKraki, readLocalLinkDiscovery } = require('./tentacle.cjs');
const presence = require('./presence.cjs');
const i18n = require('./i18n.cjs');
const permissions = require('./permissions.cjs');
const settings = require('./settings.cjs');
const windowsTitleBar = require('./windows-titlebar.cjs');
const { appOnlyIpc } = require('./ipc-guard.cjs');
const navigation = require('./navigation.cjs');
const buildInfo = require('./build-info.json');

const SCHEME = 'app';
const HOST = 'kraki';
const APP_ORIGIN = `${SCHEME}://${HOST}`;
/** Every channel below answers app pages only (ipc-guard.cjs). */
const appIpc = appOnlyIpc(ipcMain, APP_ORIGIN);
// Public, immutable build identity; never read from runtime env/renderer URLs.
appIpc.on('kraki:build-info', (event) => { event.returnValue = buildInfo; });
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
// Local testing only: a WAV file plays as the microphone (VMs have none).
if (process.env.KRAKI_DESKTOP_FAKE_MIC) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.KRAKI_DESKTOP_FAKE_MIC);
}

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
windowsTitleBar.registerTitleBarTheme(appIpc, () => win, process.platform);
/** @type {Tray | null} */
let tray = null;
let quitting = false;
let unread = 0;
/** @type {BuiltInKraki | null} */
let builtIn = null;
/** Started by the login entry: tray only, no window. */
const LAUNCHED_AT_LOGIN = process.argv.includes('--login') || process.argv.includes('--hidden');
/** Sessions waiting on a permission or an answer (from the Web). */
let needsYou = [];
/** 'starting' | 'stopping' while the service changes state. */
let transition = null;
let lastStatus = 'checking';

// ── Small persisted prefs ──
const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
function pref(key, value) {
  let all = {};
  try { all = JSON.parse(readFileSync(prefsFile(), 'utf8')); } catch { /* none */ }
  if (value === undefined) return all[key];
  all[key] = value;
  try { writeFileSync(prefsFile(), JSON.stringify(all)); } catch { /* ignore */ }
  return value;
}

// ── Window state ──
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadBounds() {
  try {
    const b = JSON.parse(readFileSync(stateFile(), 'utf8'));
    // The display holding most of the window; none if the window is off-screen.
    const a = screen.getDisplayMatching(b)?.workArea;
    if (!a || !(b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y)) return null;
    const width = Math.min(b.width, a.width);
    const height = Math.min(b.height, a.height);
    return { ...b, width, height,
      x: Math.max(a.x, Math.min(b.x, a.x + a.width - width)),
      y: Math.max(a.y, Math.min(b.y, a.y + a.height - height)) };
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

/** GitHub redirects to the Web's registered callback; bring it home. */
function oauthCallbackToApp(u) {
  return navigation.webOAuthCallbackToApp(u, OAUTH_REDIRECT_ORIGIN, OAUTH_CALLBACK_PATH, APP_ORIGIN);
}

/** The Web client's GitHub sign-in: in the sign-in window, then back to the app's callback page. */
function signInFromMainWindow(url) {
  void openSignInWindow(url, oauthCallbackToApp).then((callback) => {
    if (callback && win && !win.isDestroyed()) void win.loadURL(callback);
  });
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
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: 'Kraki',
    icon: path.join(ASSETS, 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#020617' : '#ffffff',
    autoHideMenuBar: true,
    ...windowsTitleBar.windowOptions(process.platform, nativeTheme.shouldUseDarkColors),
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
        `--kraki-titlebar-overlay=${process.platform === 'win32' ? '1' : '0'}`,
        `--kraki-oauth-origin=${OAUTH_REDIRECT_ORIGIN}`,
        `--kraki-device-name=Kraki ${process.platform === 'win32' ? 'Windows' : 'Linux'}`,
        `--kraki-builtin=${builtIn?.available() ? '1' : '0'}`,
        `--kraki-host=${os.hostname()}`,
      ],
    },
  });
  if (bounds?.maximized) win.maximize();
  Menu.setApplicationMenu(null);

  win.once('ready-to-show', () => { if (!LAUNCHED_AT_LOGIN) win.show(); });
  win.on('close', (e) => {
    saveBounds();
    // Closing keeps Kraki running in the tray (replies still notify).
    if (!quitting) {
      e.preventDefault();
      if (pref('keepRunningInTray') === false) void quitFromTray();
      else { win.hide(); stillOnlineHintOnce(); }
    }
  });
  win.on('focus', () => win.flashFrame(false));

  const wc = win.webContents;
  // New windows (links, reports) open in the default browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (navigation.isWebUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Only app pages load here (they alone get the bridge, see preload.cjs).
  const guard = (event, url) => {
    const where = navigation.mainWindowNavigation(url, APP_ORIGIN);
    if (where === 'app') return;
    event.preventDefault();
    if (where === 'signin') signInFromMainWindow(url);
    else if (where === 'external') void shell.openExternal(url);
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 4)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
      if (items.length) items.push({ type: 'separator' });
    }
    if (p.isEditable) items.push(
      { role: 'cut', label: i18n.t('menu.cut') },
      { role: 'copy', label: i18n.t('menu.copy') },
      { role: 'paste', label: i18n.t('menu.paste') },
      { type: 'separator' },
      { role: 'selectAll', label: i18n.t('menu.selectAll') },
    );
    else if (p.selectionText) items.push({ role: 'copy', label: i18n.t('menu.copy') });
    if (p.linkURL && /^https?:/i.test(p.linkURL)) items.push({ label: i18n.t('menu.openLink'), click: () => shell.openExternal(p.linkURL) });
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

// ── Tray: is this PC online (presence.cjs) ──
const trayImages = {};
/** Monochrome glyph matching the taskbar (white on dark, black on light),
 *  like a macOS template image. build/tray/*.ico from make-tray-icons.py. */
function trayTheme() {
  return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? 'dark' : 'light';
}
function trayImage(name) {
  const key = `${name}-${trayTheme()}`;
  if (!trayImages[key]) {
    let img = nativeImage.createFromPath(path.join(ASSETS, 'tray', `tray-${key}.ico`));
    if (img.isEmpty()) img = nativeImage.createFromPath(path.join(ASSETS, `tray-${name === 'transition' ? 'offline' : name}.png`));
    trayImages[key] = img.isEmpty() ? nativeImage.createFromPath(path.join(ASSETS, 'tray.png')) : img;
  }
  return trayImages[key];
}
let shownIcon = '';
let shownMenu = '';
function currentState() {
  if (!builtIn) return null;
  return { ...builtIn.quickState(), transition };
}
function updateTray() {
  if (!tray) return;
  const s = currentState();
  const status = presence.resolveStatus(s);
  const managed = presence.managesPresence(s);
  lastStatus = status;
  const icon = presence.trayIcon(status, needsYou.length);
  const iconKey = `${icon}-${trayTheme()}`;
  if (iconKey !== shownIcon) { shownIcon = iconKey; tray.setImage(trayImage(icon)); }
  const tip = [presence.TITLE[status], unread > 0 ? i18n.t('tray.unread', { count: unread }) : null].filter(Boolean).join(' · ');
  tray.setToolTip(`Kraki — ${tip}`);
  const key = JSON.stringify([status, managed, needsYou]);
  if (key !== shownMenu) {
    shownMenu = key;
    tray.setContextMenu(Menu.buildFromTemplate(presence.trayMenu(status, managed, needsYou, {
      open: showWindow,
      openSession: (id) => { showWindow(); win?.webContents.send('kraki:open-session', id); },
      usage: () => { showWindow(); win?.webContents.send('kraki:open-usage'); },
      settings: () => { showWindow(); win?.webContents.send('kraki:open-settings'); },
      goOffline: () => { void goOffline(); },
      goOnline: () => { void goOnline(); },
      quit: () => { void quitFromTray(); },
    })));
  }
}

async function changePresence(nextTransition, action) {
  transition = nextTransition; updateTray();
  try { await action(); } finally { transition = null; updateTray(); }
}
async function goOnline() {
  if (!builtIn) return;
  try { await changePresence('starting', () => builtIn.enable()); } catch { /* the status shows it */ }
}
async function goOffline() {
  if (!builtIn) return;
  // Keep ownership so opening Kraki can bring this PC online again.
  try { await changePresence('stopping', () => builtIn.disable({ keepOwnership: true })); } catch { /* the status shows it */ }
}

/** Tray › Quit: while this PC is online, quitting takes it offline (asked once). */
async function quitFromTray() {
  const s = currentState();
  const managed = presence.managesPresence(s);
  if (managed && presence.canGoOffline(presence.resolveStatus(s))) {
    if (!pref('quitConfirmSuppressed')) {
      const r = await dialog.showMessageBox(win && win.isVisible() ? win : undefined, {
        type: 'question',
        title: 'Kraki',
        message: i18n.t('quit.message'),
        detail: i18n.t('quit.detail'),
        buttons: [i18n.t('quit.confirm'), i18n.t('quit.cancel')],
        defaultId: 0,
        cancelId: 1,
        checkboxLabel: i18n.t('quit.dontAsk'),
        noLink: true,
      });
      if (r.response !== 0) return;
      if (r.checkboxChecked) pref('quitConfirmSuppressed', true);
    }
    await goOffline();
  }
  quitting = true;
  app.quit();
}

/** Pre-resampled toast image (build/toast.png); Windows does not smooth it. */
function toastIcon() {
  const small = path.join(ASSETS, 'toast.png');
  return existsSync(small) ? small : path.join(ASSETS, 'icon.png');
}

/** The first time the window closes while online, say Kraki is still there. */
function stillOnlineHintOnce() {
  if (pref('closeHintShown') || !Notification.isSupported()) return;
  if (!presence.managesPresence(currentState()) || lastStatus !== 'online') return;
  pref('closeHintShown', true);
  const n = new Notification({
    title: i18n.t('stillOnline.title'),
    body: i18n.t('stillOnline.body'),
    icon: toastIcon(),
  });
  n.on('click', showWindow);
  n.show();
}

// The Web client owns the language choice (Settings › Language) and reports
// the resolved language on load and on every change.
appIpc.on('kraki:language', (event, code) => {
  if (!win || event.sender !== win.webContents) return;
  pref('language', String(code));
  if (i18n.setLanguage(String(code))) { shownMenu = null; updateTray(); applyBadge(); }
});

appIpc.on('kraki:needs-you', (_e, list) => {
  needsYou = Array.isArray(list) ? list.map((s) => ({ id: String(s.id), title: String(s.title), reason: String(s.reason) })) : [];
  updateTray();
});

function createTray() {
  tray = new Tray(trayImage('online'));
  shownIcon = `online-${trayTheme()}`;
  tray.on('click', showWindow);
  // Taskbar light/dark switched: swap the glyph colour. Windows rebuilds the
  // taskbar buttons then, dropping the overlay badge, so set it again.
  nativeTheme.on('updated', () => { updateTray(); applyBadge(); });
  updateTray();
  setInterval(updateTray, 3000);
  if (process.env.KRAKI_DESKTOP_LOG_NOTIFY) {
    setTimeout(() => {
      try { require('node:fs').appendFileSync(path.join(app.getPath('userData'), 'notify.log'), `${new Date().toISOString()} tray bounds=${JSON.stringify(tray.getBounds())} empty=${tray.getImage?.()?.isEmpty?.() ?? 'n/a'}\n`); } catch { /* ignore */ }
    }, 3000);
  }
}

/** The unread count on the taskbar button, like the Mac Dock badge. */
function applyBadge() {
  if (process.platform === 'darwin') app.setBadgeCount(unread);
  if (process.platform === 'linux') app.setBadgeCount(unread);
  if (process.platform === 'win32' && win && !win.isDestroyed()) {
    let badge = null;
    if (unread > 0) {
      badge = nativeImage.createFromPath(path.join(ASSETS, 'tray', `badge-${unread > 9 ? '9plus' : unread}.ico`));
      if (badge.isEmpty()) badge = nativeImage.createFromPath(path.join(ASSETS, 'badge.png'));
    }
    win.setOverlayIcon(badge && !badge.isEmpty() ? badge : null, unread > 0 ? i18n.t('tray.unread', { count: unread }) : '');
  }
}
appIpc.on('kraki:badge', (_e, count) => {
  unread = Math.max(0, Number(count) || 0);
  applyBadge();
  updateTray();
});

// ── The built-in Kraki (see tentacle.cjs) ──

/** The open GitHub sign-in window, closed again when setup is cancelled. */
let signInWindow = null;

/**
 * GitHub sign-in in a window of our own. Resolves with `toCallback` of the
 * redirect that ends it (by default the built-in Kraki's kraki://auth/callback?…),
 * or null when the user closed it.
 */
function openSignInWindow(url, toCallback = navigation.builtInOAuthCallback) {
  return new Promise((resolve) => {
    if (signInWindow && !signInWindow.isDestroyed()) signInWindow.close();
    const child = new BrowserWindow({
      parent: win ?? undefined,
      modal: !!win,
      width: 520,
      height: 720,
      title: i18n.t('window.signIn'),
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
      const callback = toCallback(target);
      if (!callback) return;
      event.preventDefault();
      finish(callback);
    };
    child.on('page-title-updated', (event) => {
      event.preventDefault();
      child.setTitle(i18n.t('window.signIn'));
    });
    child.webContents.on('will-redirect', intercept);
    child.webContents.on('will-navigate', intercept);
    child.webContents.setWindowOpenHandler(({ url: u }) => {
      if (navigation.isHttpsUrl(u)) void shell.openExternal(u);
      return { action: 'deny' };
    });
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

appIpc.handle('kraki:local-link-discovery', () => readLocalLinkDiscovery());
// Performance data (Settings › Share Performance Data): fixed collector
// paths only; main-window callers only.
const diagHttp = require('./diag-http.cjs');
appIpc.handle('kraki:diag-request', (event, req) => {
  if (!win || event.sender !== win.webContents) return { status: 0, body: '' };
  return diagHttp.request((url, init) => net.fetch(url, init), req);
});
appIpc.handle('kraki:builtin-state', () => builtIn?.state() ?? null);
appIpc.handle('kraki:builtin-agents', async () => builtIn.checkAgents((e) => send('kraki:builtin-agent-event', e)));
appIpc.handle('kraki:builtin-setup', async (_e, opts) => builtIn.setup({
  deviceName: opts?.deviceName,
  forceLogin: !!opts?.forceLogin,
  useCode: !!opts?.useCode,
  onEvent: (e) => send('kraki:builtin-setup-event', e),
  openSignIn: openSignInWindow,
}));
appIpc.handle('kraki:builtin-connect', () => builtIn?.connectPhone() ?? { ok: false, error: 'not_available' });
appIpc.on('kraki:builtin-cancel-setup', () => {
  builtIn?.cancelSetup();
  if (signInWindow && !signInWindow.isDestroyed()) signInWindow.close();
});
appIpc.handle('kraki:builtin-enable', safely(() => builtIn.enable()));
appIpc.handle('kraki:builtin-disable', safely((_e, opts) => builtIn.disable({ keepOwnership: !!opts?.keepOwnership })));
appIpc.on('kraki:builtin-show-signin', () => {
  if (signInWindow && !signInWindow.isDestroyed()) { signInWindow.restore(); signInWindow.show(); signInWindow.focus(); }
});
appIpc.handle('kraki:builtin-logs-path', () => path.join(builtIn.home(), 'logs'));
appIpc.on('kraki:builtin-show-logs', () => { if (builtIn) void shell.openPath(path.join(builtIn.home(), 'logs')); });
appIpc.handle('kraki:builtin-external-presence', safely(async (_e, action) => {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Invalid service action.');
  if (builtIn.marker()) throw new Error(i18n.t('error.builtInManagesPC'));
  // Never Node's "Command failed: <path> …"; like the Mac, our sentence plus
  // the last line the CLI printed (e.g. "kraki: daemon is not installed").
  try { await settings.exec(pref('externalCliPath') || builtIn.bin, [action]); }
  catch (error) { throw new Error(settings.withCliDetail(i18n.t(`error.external.${action}`), error)); }
}));
appIpc.handle('kraki:builtin-restart', safely(() => builtIn.restart()));
appIpc.on('kraki:builtin-credentials', (e) => { e.returnValue = builtIn?.credentials() ?? null; });
appIpc.on('kraki:builtin-open-logs', () => {
  if (!builtIn) return;
  const logs = path.join(builtIn.home(), 'logs');
  const viewer = new BrowserWindow({ width: 900, height: 600, title: i18n.t('window.logs'), autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const files = require('node:fs').existsSync(logs) ? require('node:fs').readdirSync(logs).filter((name) => /\.log$/.test(name)) : [];
  const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const text = files.map((name) => { try { return name + '\n' + readFileSync(path.join(logs, name), 'utf8').slice(-100000); } catch { return ''; } }).join('\n\n');
  void viewer.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<title>' + escape(i18n.t('window.logs')) + '</title><pre style="white-space:pre-wrap;font:12px monospace">' + escape(text || i18n.t('logs.empty', { path: logs })) + '</pre>'));
});

// ── Device OS preferences (Settings bridge) ──
let registeredUsageShortcut = null;
function registerUsageShortcut(shortcut, enabled) {
  if (enabled && shortcut !== registeredUsageShortcut) {
    if (!globalShortcut.register(shortcut, () => { showWindow(); send('kraki:open-usage'); })) {
      throw new Error(i18n.t('error.shortcutInUse'));
    }
  }
  if (registeredUsageShortcut && (!enabled || registeredUsageShortcut !== shortcut)) globalShortcut.unregister(registeredUsageShortcut);
  registeredUsageShortcut = enabled ? shortcut : null;
}
function readConfig() { try { return JSON.parse(readFileSync(path.join(builtIn.home(), 'config.json'), 'utf8')); } catch { return null; } }
appIpc.handle('kraki:settings-state', async () => ({
  usageShortcut: pref('usageShortcut') ?? 'F6',
  usageShortcutEnabled: !!registeredUsageShortcut,
  launchAtLogin: process.platform === 'win32' ? await builtIn.launchAtLogin() : app.getLoginItemSettings().openAtLogin,
  keepRunningInTray: pref('keepRunningInTray') !== false,
  // Electron cannot query per-app Windows notification permission.
  notificationPermission: Notification.isSupported() ? 'default' : 'denied',
  logsPath: builtIn ? path.join(builtIn.home(), 'logs') : null,
  allowRemoteUpdates: readConfig()?.remoteUpdate !== false,
  externalCliPath: pref('externalCliPath') ?? null,
  externalCliVersion: pref('externalCliVersion') ?? null,
}));
appIpc.handle('kraki:settings-shortcut', safely((_e, shortcut, enabled) => {
  if (!settings.isSafeUsageShortcut(shortcut)) throw new Error(i18n.t('error.shortcutUnsafe'));
  registerUsageShortcut(shortcut, !!enabled);
  pref('usageShortcut', shortcut); pref('usageShortcutEnabled', !!enabled);
}));
appIpc.handle('kraki:settings-login', safely(async (_e, enabled) => {
  if (process.platform === 'win32') {
    await builtIn.setLoginItem(!!enabled);
    if (await builtIn.launchAtLogin() !== !!enabled) throw new Error(i18n.t('error.loginItem'));
    return;
  }
  app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath, args: ['--login'] });
  if (app.getLoginItemSettings().openAtLogin !== !!enabled) throw new Error(i18n.t('error.loginItem'));
}));
appIpc.handle('kraki:settings-go-online', safely(() => changePresence('starting', () => builtIn.enable())));
appIpc.handle('kraki:settings-go-offline', safely(() => changePresence('stopping', () => builtIn.disable({ keepOwnership: true }))));
appIpc.handle('kraki:settings-tray', safely((_e, enabled) => { pref('keepRunningInTray', !!enabled); }));
appIpc.on('kraki:settings-notifications', () => { if (process.platform === 'win32') void shell.openExternal('ms-settings:notifications'); });
appIpc.handle('kraki:settings-locate-cli', safely(async () => {
  const result = await dialog.showOpenDialog(win, { title: i18n.t('dialog.locateTitle'), properties: ['openFile'], filters: [{ name: i18n.t('dialog.executable'), extensions: process.platform === 'win32' ? ['exe'] : ['*'] }] });
  if (result.canceled) throw new Error(i18n.t('error.selectionCancelled'));
  const cli = await settings.probeCli(result.filePaths[0]);
  pref('externalCliPath', cli.externalCliPath); pref('externalCliVersion', cli.externalCliVersion);
}));
appIpc.handle('kraki:settings-recheck-cli', safely(async () => {
  const cli = await settings.probeCli(pref('externalCliPath'));
  pref('externalCliPath', cli.externalCliPath); pref('externalCliVersion', cli.externalCliVersion);
}));
appIpc.handle('kraki:settings-remote-updates', safely(async (_e, enabled) => {
  if (!readConfig()) throw new Error(i18n.t('error.setupFirst'));
  try { await settings.exec(builtIn.bin, ['config', 'remote-update', enabled ? 'on' : 'off']); }
  catch (error) { throw new Error(settings.withCliDetail(i18n.t('error.updatePolicy'), error)); }
  if ((readConfig()?.remoteUpdate !== false) !== !!enabled) throw new Error(i18n.t('error.updatePolicy'));
}));

appIpc.on('kraki:notify', (_e, n) => {
  if (!Notification.isSupported() || !n || typeof n.title !== 'string') return;
  const note = new Notification({
    title: String(n.title),
    body: String(n.body ?? ''),
    icon: toastIcon(),
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
app.on('will-quit', () => globalShortcut.unregisterAll());

app.whenReady().then(async () => {
  // Last language the Web client reported; before that, the OS languages.
  const saved = pref('language');
  i18n.setLanguage(i18n.isLanguage(saved) ? saved : i18n.resolveLanguage(app.getPreferredSystemLanguages()));
  // The microphone (voice input) and clipboard writes (Copy buttons) for the
  // app itself only; nothing else (permissions.cjs).
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(permissions.allowRequest(permission, details, details.requestingUrl ?? wc.getURL(), APP_ORIGIN));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permissions.allowCheck(permission, origin, APP_ORIGIN));
  builtIn = new BuiltInKraki({ resourcesPath: process.resourcesPath, appPath: process.execPath, appVersion: app.getVersion() });
  // An owned daemon that is not running (a crash loop gave up, or it was
  // stopped by an update) starts again with the app.
  // Opening Kraki (or the sign-in launch) brings this PC back online when it
  // went offline at the last quit. enable() also restores the login item.
  if (builtIn.available()) {
    const q = builtIn.quickState();
    if (q.owned && q.configured && !q.running) void goOnline();
  }
  serveApp();
  createWindow();
  createTray();
  if (pref('usageShortcutEnabled') === true) {
    try { registerUsageShortcut(pref('usageShortcut') ?? 'F6', true); } catch { /* state reports unavailable */ }
  }
});

// Explicit report export: the page supplies HTML, never a filesystem path.
appIpc.handle('kraki:export-html-report', async (event, html, name) => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
    return { ok: false, error: 'Report export is only available from the main window.' };
  }
  const { exportHtmlReport } = require('./report-export.cjs');
  return exportHtmlReport(app.getPath('temp'), (file) => shell.openPath(file), html, name);
});
