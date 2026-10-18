const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { windowOptions, registerTitleBarTheme } = require('../src/windows-titlebar.cjs');

test('only Windows opts into native caption overlay, without removing the native frame', () => {
  assert.deepEqual(windowOptions('win32', false), {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#596d84', height: 44 },
  });
  assert.equal(windowOptions('win32', true).titleBarOverlay.symbolColor, '#cbd5e1');
  for (const platform of ['linux', 'darwin']) assert.deepEqual(windowOptions(platform, false), {});
  assert.equal('frame' in windowOptions('win32', false), false);
});

test('theme IPC accepts only the app main frame, the owning window and a fixed theme enum', () => {
  let handler;
  const ipc = { on: (channel, listener) => { assert.equal(channel, 'kraki:titlebar-theme'); handler = listener; } };
  registerTitleBarTheme(ipc, () => null, 'linux');
  assert.equal(handler, undefined);
  const calls = [];
  const mainFrame = { url: 'app://kraki/session/s' };
  const win = { isDestroyed: () => false, webContents: { mainFrame }, setTitleBarOverlay: (v) => calls.push(v) };
  registerTitleBarTheme(ipc, () => win, 'win32');
  const event = { sender: win.webContents, senderFrame: mainFrame };
  handler(event, 'light');
  handler(event, 'dark');
  assert.deepEqual(calls.map((v) => v.symbolColor), ['#596d84', '#cbd5e1']);
  handler(event, { height: 999, theme: 'dark' });
  handler(event, 'maximize');
  handler({ ...event, sender: {} }, 'dark');
  handler({ ...event, senderFrame: { url: mainFrame.url } }, 'dark');
  handler({ ...event, senderFrame: null }, 'dark');
  for (const url of ['https://github.com/login', 'app://kraki.evil/', 'app://other/']) {
    mainFrame.url = url;
    handler(event, 'dark');
  }
  mainFrame.url = 'app://kraki/';
  win.isDestroyed = () => true;
  handler(event, 'dark');
  assert.equal(calls.length, 2);
  registerTitleBarTheme(ipc, () => null, 'win32');
  handler(event, 'dark');
  assert.equal(calls.length, 2);
});

test('preload capability is opt-in Windows only and exposes no caption command IPC', () => {
  function bridge(platform, enabled) {
    let exposed;
    const sent = [];
    vm.runInNewContext(readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8'), {
      process: { platform, argv: [`--kraki-titlebar-overlay=${enabled}`] },
      require: () => ({
        contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } },
        ipcRenderer: { send: (...args) => sent.push(args), sendSync: () => ({}) },
      }),
    });
    return { exposed, sent };
  }
  for (const [platform, enabled] of [['win32', '0'], ['linux', '1'], ['darwin', '1']]) {
    assert.equal(bridge(platform, enabled).exposed.titleBarOverlay, undefined);
  }
  const { exposed, sent } = bridge('win32', '1');
  assert.deepEqual(Object.keys(exposed.titleBarOverlay), ['setTheme']);
  exposed.titleBarOverlay.setTheme('dark');
  exposed.titleBarOverlay.setTheme('light');
  exposed.titleBarOverlay.setTheme('close');
  assert.deepEqual(sent, [['kraki:titlebar-theme', 'dark'], ['kraki:titlebar-theme', 'light']]);
});

test('main window consumes Windows overlay configuration; Linux retains its existing frame', () => {
  const mainPath = path.join(__dirname, '../src/main.cjs');
  const mainRequire = createRequire(mainPath);
  for (const platform of ['win32', 'linux']) {
    let options;
    let maximized = 0;
    const fakeWindow = {
      maximize: () => { maximized++; },
      once: () => {}, on: () => {}, loadURL: () => {},
      webContents: { setWindowOpenHandler: () => {}, on: () => {} },
    };
    const electron = {
      app: {
        getPath: () => '/nonexistent/kraki-titlebar-test', getVersion: () => 'test',
        setAppUserModelId: () => {}, requestSingleInstanceLock: () => true,
        on: () => {}, whenReady: () => ({ then: () => {} }),
      },
      BrowserWindow: function (value) { options = value; return fakeWindow; },
      Menu: { setApplicationMenu: () => {} },
      nativeTheme: { shouldUseDarkColors: false },
      protocol: { registerSchemesAsPrivileged: () => {} },
      ipcMain: { on: () => {}, handle: () => {} },
    };
    const context = vm.createContext({
      require: (name) => name === 'electron' ? electron : mainRequire(name),
      __dirname: path.dirname(mainPath),
      process: { platform, env: {}, argv: [] },
    });
    vm.runInContext(readFileSync(mainPath, 'utf8'), context);
    vm.runInContext('loadBounds = () => ({ width: 1240, height: 820, maximized: true }); createWindow()', context);
    assert.equal(maximized, 1);
    assert.equal(options.titleBarStyle, platform === 'win32' ? 'hidden' : undefined);
    assert.equal(options.titleBarOverlay?.height, platform === 'win32' ? 44 : undefined);
    assert.ok(options.webPreferences.additionalArguments.includes(`--kraki-titlebar-overlay=${platform === 'win32' ? '1' : '0'}`));
    assert.equal(options.webPreferences.contextIsolation, true);
    assert.equal(options.webPreferences.sandbox, true);
    assert.equal(options.webPreferences.nodeIntegration, false);
    assert.equal(options.frame, undefined);
    assert.equal(options.minWidth, 800);
  }
});
