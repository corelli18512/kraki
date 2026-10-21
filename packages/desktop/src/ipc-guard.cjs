'use strict';
// Every IPC channel of the shell serves the app's own pages (app://kraki)
// only. A sender is judged by the frame that sent the message, so a page of
// another origin in any window of ours gets nothing back.

/** True for the app origin itself or any path under it (not app://kraki.evil). */
function isAppUrl(url, appOrigin) {
  return typeof url === 'string' && (url === appOrigin || url.startsWith(`${appOrigin}/`));
}

/** The frame that sent `event` shows an app page. */
function senderIsApp(event, appOrigin) {
  try {
    return isAppUrl(event?.senderFrame?.url, appOrigin);
  } catch {
    // A disposed frame throws on access: no longer an app page.
    return false;
  }
}

/**
 * `ipcMain` with the same `handle` / `on` signatures, refusing every sender
 * that is not an app page: `handle` rejects, `on` drops the message and
 * answers a synchronous one with `null` (the renderer would block otherwise).
 */
function appOnlyIpc(ipcMain, appOrigin) {
  return {
    handle(channel, listener) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!senderIsApp(event, appOrigin)) throw new Error('Not available to this page.');
        return listener(event, ...args);
      });
    },
    on(channel, listener) {
      ipcMain.on(channel, (event, ...args) => {
        if (!senderIsApp(event, appOrigin)) {
          event.returnValue = null;
          return;
        }
        listener(event, ...args);
      });
    },
  };
}

module.exports = { isAppUrl, senderIsApp, appOnlyIpc };
