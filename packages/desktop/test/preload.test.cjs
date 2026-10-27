const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runPreload(origin) {
  let exposed;
  const sync = [];
  const listeners = new Map();
  vm.runInNewContext(readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8'), {
    process: { platform: 'win32', argv: ['--kraki-builtin=1'] },
    location: origin === undefined ? undefined : { origin },
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, value) => { exposed = { name, value }; } },
      ipcRenderer: { send: () => {}, invoke: async () => {}, on: (channel, fn) => { listeners.set(channel, fn); }, removeListener: (channel) => { listeners.delete(channel); }, sendSync: (channel) => { sync.push(channel); return {}; } },
    }),
  });
  return { exposed, sync, listeners };
}

test('the bridge is exposed to app pages', () => {
  const { exposed } = runPreload('app://kraki');
  assert.equal(exposed.name, 'krakiDesktop');
  assert.equal(typeof exposed.value.builtIn.credentials, 'function');
});

test('the bridge is not exposed to any other origin', () => {
  for (const origin of ['https://github.com', 'https://gist.github.com', 'app://kraki.evil', 'null', 'file://', undefined]) {
    const { exposed, sync } = runPreload(origin);
    assert.equal(exposed, undefined, String(origin));
    assert.deepEqual(sync, [], String(origin));
  }
});

test('power events reach the page only as suspend or resume, and unsubscribe', () => {
  const { exposed, listeners } = runPreload('app://kraki');
  const got = [];
  const stop = exposed.value.onPower((event) => got.push(event));
  const listener = listeners.get('kraki:power');
  listener({}, 'suspend'); listener({}, { evil: true }); listener({}, 'lock-screen'); listener({}, 'resume');
  assert.deepEqual(got, ['suspend', 'resume']);
  stop();
  assert.equal(listeners.has('kraki:power'), false);
});
