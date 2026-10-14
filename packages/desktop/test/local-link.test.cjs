const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readLocalLinkDiscovery } = require('../src/tentacle.cjs');

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kraki-home-'));
  try { fn(home, path.join(home, 'local-link.json')); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}

const record = (pid = process.pid) => JSON.stringify({ v: 1, port: 51234, tentacleId: 'dev_x', pid, instance: 'live-instance' });

test('local-link discovery: live external records need no built-in ownership; missing/oversized/malformed records return null', () => {
  withHome((home, file) => {
    assert.equal(readLocalLinkDiscovery(home), null);
    const body = record();
    fs.writeFileSync(file, body);
    assert.equal(readLocalLinkDiscovery(home), body);
    for (const invalid of ['x'.repeat(5000), '{', 'null', record(0), record(-1), record(1.5), record('123'), JSON.stringify({ v: 1, port: 51234 })]) {
      fs.writeFileSync(file, invalid);
      assert.equal(readLocalLinkDiscovery(home), null, invalid);
    }
  });
});

test('local-link discovery: stopped remote-only daemon is hidden, then a fresh restart is discovered', () => {
  withHome((home, file) => {
    // An exited process is a real stale PID, without probing arbitrary system processes.
    const stopped = spawnSync(process.execPath, ['-e', '']);
    assert.equal(stopped.status, 0);
    fs.writeFileSync(file, record(stopped.pid));
    assert.equal(readLocalLinkDiscovery(home), null);
    fs.writeFileSync(file, record());
    assert.equal(readLocalLinkDiscovery(home), record());
  });
});

test('local-link discovery: pre-boot record is hidden even when its PID is now alive', () => {
  withHome((home, file) => {
    fs.writeFileSync(file, record());
    const beforeBoot = new Date(Date.now() - (os.uptime() + 60) * 1000);
    fs.utimesSync(file, beforeBoot, beforeBoot);
    assert.equal(readLocalLinkDiscovery(home), null);
  });
});
