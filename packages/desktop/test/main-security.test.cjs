const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const mainPath = path.join(__dirname, '../src/main.cjs');
const AUTHORIZE = 'https://github.com/login/oauth/authorize?client_id=c&redirect_uri=https%3A%2F%2Fapp.kraki.chat%2Fauth%2Fcallback&state=s';

/** main.cjs against a recording Electron fake. */
function loadMain({ userData = '/nonexistent/kraki-security-test', displays = [] } = {}) {
  const mainRequire = createRequire(mainPath);
  const handlers = new Map();
  const windows = [];
  const external = [];
  const opened = [];
  const notes = [];
  function BrowserWindow(options) {
    const listeners = {};
    const wcListeners = {};
    const w = {
      options,
      loaded: [],
      closed: false,
      once: () => {},
      on: (name, fn) => { (listeners[name] ??= []).push(fn); },
      loadURL: (u) => { w.loaded.push(u); return Promise.resolve(); },
      isDestroyed: () => w.closed,
      close: () => { if (w.closed) return; w.closed = true; for (const fn of listeners.closed ?? []) fn(); },
      maximize: () => {}, setTitle: () => {}, isFocused: () => true, flashFrame: () => {},
      webContents: {
        mainFrame: { url: 'app://kraki/' },
        on: (name, fn) => { (wcListeners[name] ??= []).push(fn); },
        setWindowOpenHandler: (fn) => { w.openHandler = fn; },
        send: () => {},
      },
      emit: (name, ...args) => { for (const fn of wcListeners[name] ?? []) fn(...args); },
    };
    windows.push(w);
    return w;
  }
  const electron = {
    app: {
      getPath: () => userData, getVersion: () => 'test',
      setAppUserModelId: () => {}, requestSingleInstanceLock: () => true,
      on: () => {}, whenReady: () => ({ then: () => {} }), commandLine: { appendSwitch: () => {} },
      setBadgeCount: () => {}, getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: () => {},
      quit: () => {},
    },
    BrowserWindow,
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({ popup: () => {} }) },
    Notification: Object.assign(function Notification(n) { notes.push(n); return { on: () => {}, show: () => {} }; }, { isSupported: () => true }),
    Tray: function Tray() {},
    dialog: { showOpenDialog: async () => { notes.push('dialog'); return { canceled: true }; } },
    globalShortcut: { register: () => { notes.push('shortcut'); return true; }, unregister: () => {} },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    nativeTheme: { shouldUseDarkColors: false },
    net: { fetch: async () => { notes.push('fetch'); return { status: 200, text: async () => '' }; } },
    protocol: { registerSchemesAsPrivileged: () => {} },
    screen: {
      getAllDisplays: () => displays,
      // Electron: the display with the largest overlap (nearest if none).
      getDisplayMatching: (r) => displays.map((d) => {
        const a = d.workArea;
        const w = Math.max(0, Math.min(r.x + r.width, a.x + a.width) - Math.max(r.x, a.x));
        const h = Math.max(0, Math.min(r.y + r.height, a.y + a.height) - Math.max(r.y, a.y));
        return { d, area: w * h };
      }).sort((p, q) => q.area - p.area)[0]?.d,
    },
    shell: {
      openExternal: (u) => { external.push(u); return Promise.resolve(); },
      openPath: (p) => { opened.push(p); return Promise.resolve(''); },
    },
    ipcMain: {
      on: (channel, fn) => handlers.set(channel, { kind: 'on', fn }),
      handle: (channel, fn) => handlers.set(channel, { kind: 'handle', fn }),
    },
  };
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : mainRequire(name),
    __dirname: path.dirname(mainPath),
    process: { platform: 'linux', env: {}, argv: [] },
    URL,
    console,
  });
  vm.runInContext(readFileSync(mainPath, 'utf8'), context);
  const loadBounds = vm.runInContext('loadBounds', context);
  vm.runInContext('loadBounds = () => null; createWindow()', context);
  return { loadBounds, context, handlers, windows, external, opened, notes, main: windows[0] };
}

/** A built-in Kraki that records every use. */
function recordingBuiltIn(calls) {
  return new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'then') return undefined;
      if (prop === 'bin') { calls.push('bin'); return '/bin/false'; }
      return (...args) => { calls.push(String(prop)); return prop === 'credentials' ? { relay: 'wss://r', token: 'gho_secret' } : prop === 'home' ? '/nonexistent' : Promise.resolve({}); };
    },
  });
}

test('every IPC channel refuses a frame that is not an app page', async () => {
  const env = loadMain();
  const calls = [];
  env.context.__builtIn = recordingBuiltIn(calls);
  vm.runInContext('builtIn = __builtIn', env.context);
  assert.ok(env.handlers.size >= 30, `expected all channels, got ${env.handlers.size}`);
  for (const url of ['https://github.com/login', 'https://gist.github.com/x', 'app://kraki.evil/', 'about:blank', undefined]) {
    for (const [channel, { fn }] of env.handlers) {
      const event = { sender: env.main.webContents, senderFrame: url === undefined ? null : { url } };
      try {
        await fn(event, channel === 'kraki:builtin-external-presence' ? 'start' : { title: 't', body: 'b' }, true);
        assert.equal(event.returnValue ?? null, null, `${channel} answered ${url}`);
      } catch { /* refused */ }
    }
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(env.external, []);
  assert.deepEqual(env.opened, []);
  assert.deepEqual(env.notes, []);
  assert.equal(vm.runInContext('unread', env.context), 0);
  assert.equal(vm.runInContext('JSON.stringify(needsYou)', env.context), '[]');
});

test('app pages keep the bridge: credentials, build info and invoke channels answer', async () => {
  const env = loadMain();
  const calls = [];
  env.context.__builtIn = recordingBuiltIn(calls);
  vm.runInContext('builtIn = __builtIn', env.context);
  const event = { sender: env.main.webContents, senderFrame: env.main.webContents.mainFrame };
  env.handlers.get('kraki:builtin-credentials').fn(event);
  assert.deepEqual(event.returnValue, { relay: 'wss://r', token: 'gho_secret' });
  const info = { sender: env.main.webContents, senderFrame: { url: 'app://kraki/session/1?x=1' } };
  env.handlers.get('kraki:build-info').fn(info);
  assert.equal(typeof info.returnValue, 'object');
  assert.ok(info.returnValue);
  await env.handlers.get('kraki:builtin-connect').fn(event);
  env.handlers.get('kraki:badge').fn(event, 3);
  assert.equal(vm.runInContext('unread', env.context), 3);
  assert.deepEqual(calls, ['credentials', 'connectPhone']);
});

test('GitHub sign-in from the main window runs in the sign-in window and returns to the app', async () => {
  const env = loadMain();
  const navigate = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  env.main.emit('will-navigate', navigate, AUTHORIZE);
  assert.equal(navigate.defaultPrevented, true, 'GitHub must not load in the main window');
  const signIn = env.windows[1];
  assert.ok(signIn, 'sign-in window opened');
  assert.equal(signIn.options.webPreferences.preload, undefined);
  assert.equal(signIn.options.webPreferences.partition, 'persist:github-signin');
  assert.deepEqual(signIn.loaded, [AUTHORIZE]);
  const redirect = { preventDefault() { this.defaultPrevented = true; } };
  signIn.emit('will-redirect', redirect, 'https://app.kraki.chat/auth/callback?code=abc&state=s');
  await new Promise((r) => setImmediate(r));
  assert.equal(redirect.defaultPrevented, true);
  assert.equal(signIn.closed, true);
  assert.deepEqual(env.main.loaded, ['app://kraki/', 'app://kraki/auth/callback?code=abc&state=s']);
});

test('main window: other GitHub pages and links leave for the browser; app pages stay', () => {
  const env = loadMain();
  for (const [url, prevented, ext] of [
    ['https://github.com/settings/tokens', true, true],
    ['https://gist.github.com/x', true, true],
    ['http://example.com/', true, true],
    ['file:///etc/passwd', true, false],
    ['app://kraki/session/1', false, false],
  ]) {
    env.external.length = 0;
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    env.main.emit('will-navigate', event, url);
    assert.equal(event.defaultPrevented, prevented, url);
    assert.deepEqual(env.external, ext ? [url] : [], url);
  }
  assert.equal(env.windows.length, 1);
});

test('sign-in window opens https links only; built-in sign-in callback is unchanged', async () => {
  const env = loadMain();
  const result = vm.runInContext("openSignInWindow('https://github.com/login/oauth/authorize?client_id=x')", env.context);
  const signIn = env.windows[1];
  for (const url of ['file:///C:/Windows/System32/calc.exe', 'ms-settings:privacy', 'smb://host/share', 'http://example.com/', 'javascript:alert(1)']) {
    assert.equal(signIn.openHandler({ url }).action, 'deny');
  }
  assert.deepEqual(env.external, []);
  signIn.openHandler({ url: 'https://docs.github.com/terms' });
  assert.deepEqual(env.external, ['https://docs.github.com/terms']);
  signIn.emit('will-navigate', { preventDefault() {} }, 'https://github.com/login/oauth/authorize?step=2');
  assert.equal(signIn.closed, false);
  signIn.emit('will-redirect', { preventDefault() {} }, 'https://app.kraki.chat/auth/callback/desktop?code=1&state=2');
  assert.equal(await result, 'kraki://auth/callback?code=1&state=2');
});

test('This PC: a failing CLI command shows localized copy plus the CLI\'s last line (Mac parity), never the raw child_process error', { skip: process.platform === 'win32' }, async () => {
  const env = loadMain();
  const home = mkdtempSync(path.join(tmpdir(), 'kraki-main-'));
  try {
    writeFileSync(path.join(home, 'config.json'), '{}');
    const bin = path.join(home, 'kraki');
    writeFileSync(bin, '#!/bin/sh\necho "kraki: daemon is not installed" >&2\nexit 1\n', { mode: 0o755 });
    env.context.__builtIn = { bin, marker: () => null, home: () => home };
    vm.runInContext('builtIn = __builtIn', env.context);
    const event = { sender: env.main.webContents, senderFrame: env.main.webContents.mainFrame };
    const detail = ' kraki: daemon is not installed';
    for (const [action, error] of [['start', "Couldn't start the command-line Kraki."], ['stop', "Couldn't stop the command-line Kraki."], ['restart', "Couldn't restart the command-line Kraki."]]) {
      const result = { ...await env.handlers.get('kraki:builtin-external-presence').fn(event, action) };
      assert.deepEqual(result, { ok: false, error: error + detail });
      assert.doesNotMatch(result.error, /Command failed|\//);
    }
    assert.deepEqual({ ...await env.handlers.get('kraki:settings-remote-updates').fn(event, false) }, { ok: false, error: 'Kraki could not change its update policy.' + detail });
  } finally { rmSync(home, { recursive: true }); }
});

test('restored window bounds go to the display holding most of the window and fit its work area', () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'kraki-bounds-'));
  const left = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const right = { workArea: { x: 1920, y: 0, width: 1920, height: 1040 } };
  const restore = (saved, displays) => {
    writeFileSync(path.join(userData, 'window-state.json'), JSON.stringify(saved));
    const bounds = loadMain({ userData, displays }).loadBounds();
    return bounds && { ...bounds };
  };
  try {
    // 120 px on the left display, 1080 px on the right one: stays on the right.
    assert.deepEqual(restore({ x: 1800, y: 100, width: 1200, height: 800 }, [left, right]), { x: 1920, y: 100, width: 1200, height: 800 });
    assert.deepEqual(restore({ x: 1800, y: 100, width: 1200, height: 800 }, [right, left]), { x: 1920, y: 100, width: 1200, height: 800 });
    // Scaling went from 100% to 150%: the work area shrank under the window.
    assert.deepEqual(restore({ x: 400, y: 200, width: 1600, height: 1000, maximized: false }, [{ workArea: { x: 0, y: 0, width: 1280, height: 680 } }]),
      { x: 0, y: 0, width: 1280, height: 680, maximized: false });
    // Its display is gone: Electron's default placement.
    assert.equal(restore({ x: 5000, y: 100, width: 1200, height: 800 }, [left, right]), null);
  } finally { rmSync(userData, { recursive: true }); }
});
