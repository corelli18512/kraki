const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { isKrakiExecutable, probeCli, isSafeUsageShortcut } = require('../src/settings.cjs');

test('external CLI validation rejects directories, arbitrary names and missing files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kraki-settings-'));
  try {
    const file = path.join(dir, 'other.exe'); writeFileSync(file, '');
    assert.equal(isKrakiExecutable(file), false);
    assert.equal(isKrakiExecutable(dir), false);
    assert.equal(isKrakiExecutable(path.join(dir, 'kraki.exe')), false);
  } finally { rmSync(dir, { recursive: true }); }
});
test('external CLI only probes --version without daemon commands', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kraki-settings-'));
  const file = path.join(dir, 'kraki');
  try {
    writeFileSync(file, '#!/bin/sh\n[ "$1" = "--version" ] || exit 1\necho "Kraki 0.38.7"\n', { mode: 0o755 });
    assert.deepEqual(await probeCli(file), { externalCliPath: file, externalCliVersion: '0.38.7' });
  } finally { rmSync(dir, { recursive: true }); }
});
test('settings preload exposes the agreed capability names and forwards fixed IPC', async () => {
  let bridge;
  const calls = [];
  const ipcRenderer = { sendSync: (channel) => { assert.equal(channel, 'kraki:build-info'); return { schemaVersion: 1, channel: 'local' }; }, invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); }, send: (...args) => { calls.push(args); } };
  vm.runInNewContext(readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer }),
    process: { platform: 'win32', argv: ['--kraki-builtin=1'] },
  });
  await bridge.settings.setUsageShortcut('Control+U', true);
  await bridge.settings.setLaunchAtLogin(false);
  await bridge.settings.setAllowRemoteUpdates(false);
  bridge.settings.openNotificationSettings();
  assert.deepEqual(calls, [['kraki:settings-shortcut', 'Control+U', true], ['kraki:settings-login', false], ['kraki:settings-remote-updates', false], ['kraki:settings-notifications']]);
  const bridgeTypes = readFileSync(path.join(__dirname, '../../arm/web/src/lib/desktop.ts'), 'utf8');
  const settingsInterface = bridgeTypes.split('export interface DesktopSettingsBridge {')[1].split('\n}')[0];
  const methods = [...settingsInterface.matchAll(/^  (\w+)\??:/gm)].map((match) => match[1]);
  assert.deepEqual(Object.keys(bridge.settings).sort(), methods.sort());
  const main = readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  const ui = ['components/layout/SettingsPanel.tsx', 'components/desktop/ThisPCSettings.tsx']
    .map((file) => readFileSync(path.join(__dirname, '../../arm/web/src', file), 'utf8')).join('\n');
  const uiMethods = new Set([...ui.matchAll(/\b(?:bridge|settings)(?:\?\.|\.)(\w+)(?=[?!]?\s|[(!])/g)].map((match) => match[1]));
  for (const method of uiMethods) assert.equal(typeof bridge.settings[method], 'function', `UI settings.${method} must be exposed`);
  calls.length = 0;
  for (const method of methods) {
    const result = bridge.settings[method]();
    if (!['openNotificationSettings', 'showLogsInExplorer'].includes(method)) assert.deepEqual(await result, { ok: true });
    else assert.equal(result, undefined);
    const channel = calls.at(-1)[0];
    assert.ok(main.includes(`'${channel}'`), `main must handle ${channel}`);
  }
  await bridge.exportHtmlReport('<html>Report</html>', 'report');
  assert.deepEqual(calls.at(-1), ['kraki:export-html-report', '<html>Report</html>', 'report']);
  assert.ok(main.includes("ipcMain.handle('kraki:export-html-report'"));
  assert.equal(typeof bridge.settings.locateCli, 'function');
  assert.equal(typeof bridge.settings.recheckCli, 'function');
  assert.equal(typeof bridge.builtIn.showSignInWindow, 'function');
});

test('global usage shortcut never captures plain typing keys or Escape', () => {
  for (const key of ['F6', 'Control+U', 'Alt+Space', 'CommandOrControl+Shift+U']) assert.equal(isSafeUsageShortcut(key), true);
  for (const key of ['A', 'Shift+A', 'Escape', 'Control+Escape', '']) assert.equal(isSafeUsageShortcut(key), false);
});

test('settings presence IPC keeps ownership and returns errors instead of claiming success', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kraki-settings-ipc-'));
  const handlers = new Map();
  const electron = {
    app: { setAppUserModelId: () => {}, requestSingleInstanceLock: () => true, on: () => {}, whenReady: () => new Promise(() => {}), getPath: () => dir, getLoginItemSettings: () => ({ openAtLogin: false }) },
    ipcMain: { on: () => {}, handle: (name, fn) => handlers.set(name, fn) },
    protocol: { registerSchemesAsPrivileged: () => {} },
    Notification: { isSupported: () => true },
  };
  const { createRequire } = require('node:module');
  const mainPath = path.join(__dirname, '../src/main.cjs');
  const mainRequire = createRequire(mainPath);
  const calls = [];
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : mainRequire(name),
    __dirname: path.dirname(mainPath),
    process: { platform: 'win32', env: {}, argv: [], execPath: 'C:\Kraki.exe' },
    __builtin: { home: () => dir, launchAtLogin: async () => false, enable: async () => { calls.push('enable'); }, disable: async (opts) => { calls.push(opts); } },
  });
  try {
    vm.runInContext(readFileSync(mainPath, 'utf8'), context);
    vm.runInContext('builtIn = __builtin;', context);
    assert.equal((await handlers.get('kraki:settings-go-online')()).ok, true);
    assert.equal((await handlers.get('kraki:settings-go-offline')()).ok, true);
    assert.equal(calls[0], 'enable');
    assert.equal(calls[1].keepOwnership, true);
    context.__builtin.disable = async () => { throw new Error('Cannot stop service'); };
    const result = await handlers.get('kraki:settings-go-offline')();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Cannot stop service');
    assert.equal(vm.runInContext('transition', context), null);
    const state = await handlers.get('kraki:settings-state')();
    assert.equal(state.keepRunningInTray, true);
    assert.equal(state.usageShortcut, 'F6');
    assert.equal(state.usageShortcutEnabled, false);
    assert.equal(state.logsPath, path.join(dir, 'logs'));
    assert.equal(state.notificationPermission, 'default');
    assert.equal((await handlers.get('kraki:settings-tray')(undefined, false)).ok, true);
    assert.equal((await handlers.get('kraki:settings-state')()).keepRunningInTray, false);
    assert.ok(readFileSync(mainPath, 'utf8').includes("if (pref('keepRunningInTray') === false) void quitFromTray();"));
  } finally { rmSync(dir, { recursive: true }); }
});
