// Keep the OS caption buttons (including Windows Snap and accessibility).
// Electron 38's Window Controls Overlay exposes its live bounds as CSS env vars.
const HEIGHT = 44;

function overlayStyle(dark) {
  return { color: dark ? '#020617' : '#ffffff', symbolColor: dark ? '#cbd5e1' : '#596d84', height: HEIGHT };
}

function windowOptions(platform, dark) {
  return platform === 'win32'
    ? { titleBarStyle: 'hidden', titleBarOverlay: overlayStyle(dark) }
    : {};
}

function registerTitleBarTheme(ipcMain, getWindow, platform) {
  if (platform !== 'win32') return;
  // Only theme, never arbitrary BrowserWindow methods or caption commands.
  ipcMain.on('kraki:titlebar-theme', (event, theme) => {
    const win = getWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents
        || event.senderFrame !== win.webContents.mainFrame
        || !/^app:\/\/kraki\//.test(event.senderFrame.url)
        || (theme !== 'light' && theme !== 'dark')) return;
    win.setTitleBarOverlay(overlayStyle(theme === 'dark'));
  });
}

module.exports = { windowOptions, registerTitleBarTheme };
