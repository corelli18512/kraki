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
  const dialogs = [];
  const i18n = require('../src/i18n.cjs');
  const electron = {
    app: { setAppUserModelId: () => {}, requestSingleInstanceLock: () => true, on: () => {}, whenReady: () => new Promise(() => {}), getPath: () => dir, getLoginItemSettings: () => ({ openAtLogin: false }) },
    ipcMain: { on: () => {}, handle: (name, fn) => handlers.set(name, fn) },
    protocol: { registerSchemesAsPrivileged: () => {} },
    Notification: { isSupported: () => true },
    dialog: { showOpenDialog: async (_win, options) => { dialogs.push(options); return { canceled: true }; } },
  };
  const { createRequire } = require('node:module');
  const mainPath = path.join(__dirname, '../src/main.cjs');
  const mainRequire = createRequire(mainPath);
  const calls = [];
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : mainRequire(name),
    __dirname: path.dirname(mainPath),
    process: { platform: 'win32', env: {}, argv: [], execPath: 'C:\Kraki.exe' },
    __builtin: { marker: () => ({}), home: () => dir, launchAtLogin: async () => false, enable: async () => { calls.push('enable'); }, disable: async (opts) => { calls.push(opts); } },
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
    for (const [language, title, filter, managed, cancelled] of [
      ['en', 'Locate kraki manually', 'Kraki executable', 'The built-in Kraki manages this PC.', 'Selection cancelled.'],
      ['zh-Hans', '定位 kraki 可执行文件', 'Kraki 可执行文件', '内置 Kraki 正在管理这台电脑。', '已取消选择。'],
    ]) {
      i18n.setLanguage(language);
      const locate = await handlers.get('kraki:settings-locate-cli')();
      assert.equal(locate.ok, false);
      assert.equal(locate.error, cancelled);
      assert.equal(dialogs.at(-1).title, title);
      assert.equal(dialogs.at(-1).filters[0].name, filter);
      const presence = await handlers.get('kraki:builtin-external-presence')(undefined, 'start');
      assert.equal(presence.ok, false);
      assert.equal(presence.error, managed);
    }
  } finally { i18n.setLanguage('en'); rmSync(dir, { recursive: true }); }
});

test('external CLI version errors follow shell language without translating CLI output', { skip: process.platform === 'win32' }, async () => {
  const i18n = require('../src/i18n.cjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'kraki-settings-l10n-'));
  const file = path.join(dir, 'kraki');
  try {
    writeFileSync(file, '#!/bin/sh\necho "not a version"\n', { mode: 0o755 });
    await assert.rejects(probeCli(file), { message: 'The selected CLI did not report a Kraki version.' });
    i18n.setLanguage('zh-Hans');
    await assert.rejects(probeCli(file), { message: '所选 CLI 未报告 Kraki 版本。' });
  } finally { i18n.setLanguage('en'); rmSync(dir, { recursive: true }); }
});

test('CLI probe failures surface localized messages, never child_process output', async () => {
  const settings = require('../src/settings.cjs');
  const i18n = require('../src/i18n.cjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'kraki-probe-'));
  const broken = path.join(dir, process.platform === 'win32' ? 'kraki.exe' : 'kraki');
  writeFileSync(broken, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  try {
    for (const lang of ['en', 'zh-Hans']) {
      i18n.setLanguage(lang);
      await assert.rejects(settings.probeCli(broken), { message: i18n.t('error.cliVersion') });
      await assert.rejects(settings.probeCli(path.join(dir, 'missing', 'kraki')), { message: i18n.t('error.selectExecutable') });
    }
  } finally {
    i18n.setLanguage('en');
    rmSync(dir, { recursive: true, force: true });
  }
});
