// Is this PC online? — Kraki for Mac's MacPresence for Windows.
//
// Kraki for Windows is three things: the window, the app (tray) and the
// built-in background service. Users only need to think about one: is this PC
// online, i.e. can my phone and my other computers use the agents here.
//
//   • Online ⇒ visible: while the service runs the tray octopus is there. The
//     app starts in the tray at sign-in; closing the window keeps it online.
//   • Quitting Kraki (tray › Quit…) takes this PC offline, confirmed once.
//     Opening Kraki brings it back online.
//   • Sign-out, restart, shutdown and app updates end the app without going
//     offline, so the PC comes back online by itself. That includes an update
//     started from another device: its installer closes the app.
//
// A standalone CLI install keeps its own daemon: quitting the app never stops it.

/** One user-facing status. */
function resolveStatus(s) {
  if (!s) return 'checking';
  if (!s.available) return 'controlsOthersOnly';
  if (!s.owned) return s.cliDaemon ? 'cli' : 'controlsOthersOnly';
  if (s.transition === 'starting') return 'goingOnline';
  if (s.transition === 'stopping') return 'goingOffline';
  if (s.running) return 'online';
  return 'offline';
}

const { readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const { t } = require('./i18n.cjs');

const STATUSES = ['checking', 'online', 'goingOnline', 'goingOffline', 'offline', 'cli', 'controlsOthersOnly'];
const DETAILED = ['online', 'offline', 'cli', 'controlsOthersOnly'];
/** Localized at read time, so a language switch only needs a tray refresh. */
const TITLE = new Proxy({}, { get: (_o, k) => (STATUSES.includes(k) ? t(`status.${k}`) : undefined) });
const DETAIL = new Proxy({}, { get: (_o, k) => (DETAILED.includes(k) ? t(`detail.${k}`) : undefined) });

/** The app owns whether this PC is online (built-in Kraki, runs agents). */
const managesPresence = (s) => !!(s && s.available && s.owned);
const canGoOffline = (status) => status === 'online' || status === 'goingOnline';
const canGoOnline = (status) => status === 'offline';

/** Which tray icon (MacPresence.image): dimmed offline, half-dimmed while
 *  going online/offline, a dot when sessions need you. */
function trayIcon(status, needsYou) {
  if (status === 'offline') return 'offline';
  if (status === 'goingOnline' || status === 'goingOffline') return 'transition';
  if (needsYou > 0) return 'attention';
  return 'online';
}

/**
 * The tray menu, as an Electron template. `act` holds the click handlers;
 * `needsYou` is [{ id, title, reason }].
 */
function trayMenu(status, managed, needsYou, act) {
  const items = [
    { label: TITLE[status] ?? TITLE.checking, click: act.settings },
  ];
  if (DETAIL[status]) items.push({ label: DETAIL[status], enabled: false });
  if (needsYou.length) {
    items.push({ type: 'separator' }, { label: t('tray.needsYou'), enabled: false });
    for (const s of needsYou.slice(0, 5)) items.push({ label: `${s.title} — ${s.reason}`, click: () => act.openSession(s.id) });
    if (needsYou.length > 5) items.push({ label: t('tray.more', { count: needsYou.length - 5 }), click: act.open });
  }
  items.push({ type: 'separator' }, { label: t('tray.open'), click: act.open }, { label: t('tray.usage'), click: act.usage });
  items.push({ type: 'separator' });
  if (managed && canGoOffline(status)) items.push({ label: t('tray.goOffline'), click: act.goOffline });
  else if (managed && canGoOnline(status)) items.push({ label: t('tray.goOnline'), click: act.goOnline });
  items.push({ label: t('tray.settings'), click: act.settings });
  items.push({ label: managed && canGoOffline(status) ? t('tray.quitOffline') : t('tray.quit'), click: act.quit });
  return items;
}

/**
 * An update started from another device (Update in a phone's device details)
 * runs the Kraki for Windows installer, which closes this app. The built-in
 * Kraki's plan (`remote-update/plan.json`) names a `windows-app` update, and
 * its applier keeps `remote-update/windows-installer-running` only while the
 * installer runs (remote-update.ts WINDOWS_INSTALLER_MARKER). Recent only: a
 * marker left by an updater that died never silences Quit.
 */
function remoteUpdateInstallerRunning(krakiHome, now = Date.now()) {
  const dir = path.join(krakiHome, 'remote-update');
  try {
    if (JSON.parse(readFileSync(path.join(dir, 'plan.json'), 'utf8')).method !== 'windows-app') return false;
    return now - statSync(path.join(dir, 'windows-installer-running')).mtimeMs < 3600_000;
  } catch {
    return false;
  }
}

module.exports = { resolveStatus, TITLE, DETAIL, managesPresence, canGoOffline, canGoOnline, trayIcon, trayMenu, remoteUpdateInstallerRunning };
