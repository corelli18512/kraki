const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { join } = require('node:path');

test('preload exposes build identity through a fixed public IPC, not launch arguments', () => {
  let bridge;
  const info = { schemaVersion: 1, channel: 'release', runId: '123' };
  runInNewContext(readFileSync(join(__dirname, '../src/preload.cjs'), 'utf8'), {
    process: { argv: ['electron', '--kraki-run-id=forged'], platform: 'win32' },
    location: { origin: 'app://kraki' },
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'krakiDesktop'); bridge = value; } },
      ipcRenderer: { sendSync: (channel) => { assert.equal(channel, 'kraki:build-info'); return info; } },
    }),
  });
  assert.deepEqual(bridge.buildInfo, info);
});
