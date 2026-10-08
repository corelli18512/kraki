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
});
