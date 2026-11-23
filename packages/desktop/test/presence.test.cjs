const test = require('node:test');
const assert = require('node:assert');
const p = require('../src/presence.cjs');

const base = { available: true, owned: true, running: true, cliDaemon: false };
test('status follows the built-in service', () => {
  assert.equal(p.resolveStatus(null), 'checking');
  assert.equal(p.resolveStatus(base), 'online');
  assert.equal(p.resolveStatus({ ...base, running: false }), 'offline');
  assert.equal(p.resolveStatus({ ...base, transition: 'stopping' }), 'goingOffline');
  assert.equal(p.resolveStatus({ ...base, owned: false, running: true, cliDaemon: true }), 'cli');
  assert.equal(p.resolveStatus({ ...base, owned: false, running: false }), 'controlsOthersOnly');
});
test('quit takes this PC offline only when the app owns it and it is online', () => {
  const quit = (s) => p.trayMenu(p.resolveStatus(s), p.managesPresence(s), [], {}).find((i) => /^Quit/.test(i.label)).label;
  assert.equal(quit(base), 'Quit Kraki and Go Offline…');
  assert.equal(quit({ ...base, running: false }), 'Quit Kraki');
  assert.equal(quit({ ...base, owned: false, cliDaemon: true }), 'Quit Kraki');
});
test('online/offline toggle and needs-you items', () => {
  const labels = (s, n = []) => p.trayMenu(p.resolveStatus(s), p.managesPresence(s), n, {}).map((i) => i.label).filter(Boolean);
  assert.ok(labels(base).includes('Take This PC Offline'));
  assert.ok(labels({ ...base, running: false }).includes('Bring This PC Online'));
  assert.ok(labels(base, [{ id: 'a', title: 'Fix', reason: 'Needs approval' }]).includes('Fix — Needs approval'));
  assert.equal(p.trayIcon('online', 1), 'attention');
  assert.equal(p.trayIcon('offline', 1), 'offline');
  // MacPresence: half-dimmed while going online/offline.
  assert.equal(p.trayIcon('goingOnline', 0), 'transition');
  assert.equal(p.trayIcon('goingOffline', 1), 'transition');
});
test('status opens settings and Needs You limits entries without losing overflow count', () => {
  let opened = false;
  const list = Array.from({ length: 25 }, (_, i) => ({ id: String(i), title: 'New Session', reason: 'Asked you a question' }));
  const menu = p.trayMenu('online', true, list, { settings: () => { opened = true; } });
  menu[0].click();
  assert.equal(opened, true);
  assert.equal(menu.filter((item) => item.label === 'New Session — Asked you a question').length, 5);
  assert.ok(menu.some((item) => item.label === '20 more…'));
});
test('a remote update\'s installer running: a windows-app plan and the applier\'s marker, recent only', () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
  const path = require('node:path');
  const home = mkdtempSync(path.join(require('node:os').tmpdir(), 'kraki-presence-'));
  const dir = path.join(home, 'remote-update');
  try {
    assert.equal(p.remoteUpdateInstallerRunning(home), false);
    mkdirSync(dir);
    // The plan alone: staged, or verifying after the installer finished.
    writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ method: 'windows-app' }));
    assert.equal(p.remoteUpdateInstallerRunning(home), false);
    writeFileSync(path.join(dir, 'windows-installer-running'), '{}');
    assert.equal(p.remoteUpdateInstallerRunning(home), true);
    assert.equal(p.remoteUpdateInstallerRunning(home, Date.now() + 2 * 3600_000), false, 'a marker left by an updater that died');
    // Another install's update in the same Kraki home (a standalone CLI).
    writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ method: 'binary' }));
    assert.equal(p.remoteUpdateInstallerRunning(home), false);
    rmSync(path.join(dir, 'plan.json'));
    assert.equal(p.remoteUpdateInstallerRunning(home), false);
  } finally { rmSync(home, { recursive: true }); }
});
