const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordedPid } = require('../src/tentacle.cjs');

// After a restart Windows reuses PIDs: a daemon PID recorded before the boot
// may now be another process, and the app then never started Kraki at login.
test('a PID recorded before this boot is ignored', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kraki-home-'));
  try {
    fs.writeFileSync(path.join(home, 'status.json'), JSON.stringify({ pid: 6376 }));
    const written = fs.statSync(path.join(home, 'status.json')).mtimeMs;
    assert.equal(recordedPid(home, written - 60_000), 6376, 'recorded after boot');
    assert.equal(recordedPid(home, written + 60_000), null, 'recorded before boot');
    fs.writeFileSync(path.join(home, 'daemon.pid'), '4242');
    assert.equal(recordedPid(home, written - 60_000), 4242);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
