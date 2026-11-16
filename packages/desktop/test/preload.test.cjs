const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runPreload(origin, platform = 'win32') {
  let exposed;
  const sync = [];
  const sent = [];
  const invoked = [];
  const listeners = new Map();
  vm.runInNewContext(readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8'), {
    process: { platform, argv: ['--kraki-builtin=1'] },
    location: origin === undefined ? undefined : { origin },
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, value) => { exposed = { name, value }; } },
      ipcRenderer: { send: (...args) => { sent.push(args); }, invoke: async (...args) => { invoked.push(args); }, on: (channel, fn) => { listeners.set(channel, fn); }, removeListener: (channel) => { listeners.delete(channel); }, sendSync: (channel) => { sync.push(channel); return {}; } },
    }),
  });
  return { exposed, sync, listeners, sent, invoked };
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

test('voice volume (lower other sounds while recording) is a Windows-only bridge of fixed messages', async () => {
  const { exposed, sent, invoked } = runPreload('app://kraki');
  const v = exposed.value.voiceVolume;
  v.cueStarted(); v.cueFinished(); v.captureStarted(); v.captureStopped();
  assert.deepEqual(sent, ['cue-started', 'cue-finished', 'capture-started', 'capture-stopped'].map((m) => ['kraki:voice-volume', m]));
  await v.state();
  await v.setEnabled('yes');
  assert.deepEqual(invoked, [['kraki:voice-volume-state'], ['kraki:voice-volume-enabled', true]]);
  assert.equal(runPreload('app://kraki', 'linux').exposed.value.voiceVolume, undefined);
  assert.equal(runPreload('app://kraki', 'darwin').exposed.value.voiceVolume, undefined);
});
