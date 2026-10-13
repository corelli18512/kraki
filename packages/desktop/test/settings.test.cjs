const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { isKrakiExecutable, probeCli } = require('../src/settings.cjs');

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
  const ipcRenderer = { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); }, send: (...args) => calls.push(args) };
  vm.runInNewContext(readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer }),
    process: { platform: 'win32', argv: ['--kraki-builtin=1'] },
  });
  await bridge.settings.setUsageShortcut('Control+U', true);
  await bridge.settings.setLaunchAtLogin(false);
  await bridge.settings.setAllowRemoteUpdates(false);
  bridge.settings.openNotificationSettings();
  assert.deepEqual(calls, [['kraki:settings-shortcut', 'Control+U', true], ['kraki:settings-login', false], ['kraki:settings-remote-updates', false], ['kraki:settings-notifications']]);
  assert.equal(typeof bridge.settings.locateCli, 'function');
  assert.equal(typeof bridge.settings.recheckCli, 'function');
  assert.equal(typeof bridge.builtIn.showSignInWindow, 'function');
});
