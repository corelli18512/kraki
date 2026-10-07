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
//     offline, so the PC comes back online by itself.
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

const TITLE = {
  checking: 'Checking this PC…',
  online: 'This PC is online',
  goingOnline: 'This PC is going online…',
  goingOffline: 'This PC is going offline…',
  offline: 'This PC is offline',
  cli: 'This PC is online (command-line Kraki)',
  controlsOthersOnly: 'This PC controls other computers',
};
const DETAIL = {
  online: 'Your phone and other computers can use its agents',
  offline: "Your phone can't use the agents on this PC",
  cli: 'Managed by the command-line Kraki',
  controlsOthersOnly: 'No agents run on this PC',
};

/** The app owns whether this PC is online (built-in Kraki, runs agents). */
const managesPresence = (s) => !!(s && s.available && s.owned);
const canGoOffline = (status) => status === 'online' || status === 'goingOnline';
const canGoOnline = (status) => status === 'offline';

/** Which tray icon: dimmed while offline, a dot when sessions need you. */
function trayIcon(status, needsYou) {
  if (status === 'offline' || status === 'goingOnline' || status === 'goingOffline') return 'offline';
  if (needsYou > 0) return 'attention';
  return 'online';
}

/**
 * The tray menu, as an Electron template. `act` holds the click handlers;
 * `needsYou` is [{ id, title, reason }].
 */
function trayMenu(status, managed, needsYou, act) {
  const items = [
    { label: TITLE[status] ?? TITLE.checking, enabled: false },
  ];
  if (DETAIL[status]) items.push({ label: DETAIL[status], enabled: false });
  if (needsYou.length) {
    items.push({ type: 'separator' }, { label: 'Needs You', enabled: false });
    for (const s of needsYou.slice(0, 5)) items.push({ label: `${s.title} — ${s.reason}`, click: () => act.openSession(s.id) });
    if (needsYou.length > 5) items.push({ label: `${needsYou.length - 5} more…`, click: act.open });
  }
  items.push({ type: 'separator' }, { label: 'Open Kraki', click: act.open }, { label: 'Account Usage', click: act.usage });
  items.push({ type: 'separator' });
  if (managed && canGoOffline(status)) items.push({ label: 'Take This PC Offline', click: act.goOffline });
  else if (managed && canGoOnline(status)) items.push({ label: 'Bring This PC Online', click: act.goOnline });
  items.push({ label: 'Settings…', click: act.settings });
  items.push({ label: managed && canGoOffline(status) ? 'Quit Kraki and Go Offline…' : 'Quit Kraki', click: act.quit });
  return items;
}

module.exports = { resolveStatus, TITLE, DETAIL, managesPresence, canGoOffline, canGoOnline, trayIcon, trayMenu };
