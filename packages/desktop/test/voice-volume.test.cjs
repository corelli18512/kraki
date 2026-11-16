const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  VOICE_VOLUME, duckTarget, VolumeJournal, processIsAlive, recoverVolume, VoiceVolumeDucker, launchWatchdogProcess, runWatchdog,
} = require('../src/voice-volume.cjs');

/** Timers the test advances by hand. */
class ManualTimers {
  constructor() { this.now = 0; this.queue = []; this.seq = 0; }
  setTimeout(fn, ms) { const t = { id: ++this.seq, at: this.now + ms, fn }; this.queue.push(t); return t.id; }
  clearTimeout(id) { this.queue = this.queue.filter((t) => t.id !== id); }
  advance(ms) {
    const end = this.now + ms;
    for (;;) {
      const next = this.queue.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.queue = this.queue.filter((t) => t !== next);
      this.now = next.at;
      next.fn();
    }
    this.now = end;
  }
}

/** One render endpoint; `quantum` rounds what the endpoint stores. */
class FakeEndpoint {
  constructor({ volume = 0.8, muted = false, writable = true, id = '{0.0.0.00000000}.{speakers}', quantum = 0 } = {}) {
    Object.assign(this, { level: volume, muted, writable, id, quantum, sets: [], failReads: 0, rejectSet: false });
  }
  defaultDevice() { return this.id; }
  supportsWritableVolume(id) { return this.writable && id === this.id; }
  volume(id) {
    if (id !== this.id) throw new Error('device gone');
    if (this.failReads > 0) { this.failReads--; throw new Error('device busy'); }
    return this.level;
  }
  setVolume(id, value) {
    if (id !== this.id) throw new Error('device gone');
    this.sets.push(value);
    if (!this.rejectSet) this.level = this.quantum ? Math.round(value / this.quantum) * this.quantum : value;
  }
  isMuted() { return this.muted; }
}

function setup(t, { endpoint = new FakeEndpoint(), enabled = true, launch } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kraki-voice-volume-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const journal = new VolumeJournal(path.join(dir, VOICE_VOLUME.journalName));
  const timers = new ManualTimers();
  const watchdogs = [];
  const logs = [];
  const env = { enabled };
  const ducker = new VoiceVolumeDucker({
    backend: endpoint,
    journal,
    timers,
    isEnabled: () => env.enabled,
    log: (line) => logs.push(line),
    newToken: () => `token-${watchdogs.length + 1}`,
    launchWatchdog: launch ?? ((file, state) => {
      const w = { file, state, stopped: false };
      watchdogs.push(w);
      return () => { w.stopped = true; };
    }),
  });
  return { dir, journal, timers, watchdogs, logs, env, ducker, endpoint };
}

/** Capture started and the 0.25 s cue delay elapsed. */
function record(env) {
  env.ducker.scheduleLowering();
  env.timers.advance(VOICE_VOLUME.cueDelayMs);
}

test('target is min(original, 20 %, 40 % × original); already quiet is left alone', () => {
  assert.equal(duckTarget(1), 0.2);
  assert.ok(Math.abs(duckTarget(0.3) - 0.12) < 1e-9);
  assert.ok(Math.abs(duckTarget(0.04) - 0.016) < 1e-9);
  assert.equal(duckTarget(0.03), null);
  assert.equal(duckTarget(0), null);
});

test('lowers after the cue delay, journals first, and restores when capture stops', (t) => {
  const env = setup(t);
  env.ducker.scheduleLowering();
  env.timers.advance(VOICE_VOLUME.cueDelayMs - 1);
  assert.equal(env.endpoint.level, 0.8, 'never sooner than the cue delay');
  env.timers.advance(1);
  assert.ok(Math.abs(env.endpoint.level - 0.2) < 1e-9);
  assert.equal(env.ducker.isLowered, true);
  const journaled = env.journal.read();
  assert.deepEqual({ ...journaled, startedAt: 0 }, { deviceId: env.endpoint.id, originalVolume: 0.8, duckedVolume: 0.2, ownerPid: process.pid, token: 'token-1', startedAt: 0 });
  assert.equal(env.watchdogs.length, 1);
  assert.equal(env.watchdogs[0].file, env.journal.file);
  env.ducker.restore('capture stopped');
  assert.equal(env.endpoint.level, 0.8);
  assert.equal(env.journal.read(), null);
  assert.equal(env.watchdogs[0].stopped, true);
  assert.equal(env.ducker.isLowered, false);
});

test('a volume the user changed meanwhile is kept', (t) => {
  const env = setup(t);
  record(env);
  env.endpoint.level = 0.5;
  env.ducker.restore('capture stopped');
  assert.equal(env.endpoint.level, 0.5);
  assert.equal(env.journal.read(), null);
  assert.equal(env.watchdogs[0].stopped, true);
  // Within the tolerance it is still "our" level.
  const again = setup(t);
  record(again);
  again.endpoint.level = 0.2 + VOICE_VOLUME.tolerance / 2;
  again.ducker.restore('capture stopped');
  assert.equal(again.endpoint.level, 0.8);
});

test('mute is respected: muted when recording starts or muted meanwhile', (t) => {
  const muted = setup(t, { endpoint: new FakeEndpoint({ muted: true }) });
  record(muted);
  assert.equal(muted.ducker.isLowered, false);
  assert.deepEqual(muted.endpoint.sets, []);
  assert.equal(muted.watchdogs.length, 0);

  const later = setup(t);
  record(later);
  later.endpoint.muted = true;
  later.ducker.restore('capture stopped');
  assert.ok(Math.abs(later.endpoint.level - 0.2) < 1e-9, 'a mute the user chose is not undone');
  assert.equal(later.journal.read(), null);
});

test('quiet, unwritable and disabled endpoints are untouched', (t) => {
  for (const env of [
    setup(t, { endpoint: new FakeEndpoint({ volume: 0.03 }) }),
    setup(t, { endpoint: new FakeEndpoint({ writable: false }) }),
    setup(t, { enabled: false }),
  ]) {
    record(env);
    env.ducker.restore('capture stopped');
    assert.deepEqual(env.endpoint.sets, []);
    assert.equal(env.watchdogs.length, 0);
    assert.equal(env.journal.exists(), false);
  }
});

test('turning the setting off before the delay elapses keeps the volume', (t) => {
  const env = setup(t);
  env.ducker.scheduleLowering();
  env.env.enabled = false;
  env.timers.advance(VOICE_VOLUME.cueDelayMs);
  assert.deepEqual(env.endpoint.sets, []);
});

test('lowering waits for the start cue to finish', (t) => {
  const env = setup(t);
  env.ducker.cueStarted();
  record(env);
  env.timers.advance(500);
  assert.equal(env.endpoint.level, 0.8, 'the cue plays at full volume');
  env.ducker.cueFinished();
  assert.ok(Math.abs(env.endpoint.level - 0.2) < 1e-9);
});

test('a cue that never reports its end delays lowering by at most 2 s', (t) => {
  const env = setup(t);
  env.ducker.cueStarted();
  env.ducker.scheduleLowering();
  env.timers.advance(VOICE_VOLUME.cueFinishTimeoutMs - 1);
  assert.equal(env.endpoint.level, 0.8);
  env.timers.advance(1);
  assert.ok(Math.abs(env.endpoint.level - 0.2) < 1e-9);
});

test('a cue that finished before capture started does not delay lowering further', (t) => {
  const env = setup(t);
  env.ducker.cueStarted();
  env.ducker.cueFinished();
  record(env);
  assert.ok(Math.abs(env.endpoint.level - 0.2) < 1e-9);
});

test('released before lowering (during the delay or the cue): never lowered', (t) => {
  const delay = setup(t);
  delay.ducker.scheduleLowering();
  delay.timers.advance(100);
  delay.ducker.restore('capture stopped');
  delay.timers.advance(5000);
  assert.deepEqual(delay.endpoint.sets, []);

  const cue = setup(t);
  cue.ducker.cueStarted();
  record(cue);
  cue.ducker.restore('capture stopped');
  cue.ducker.cueFinished();
  cue.timers.advance(5000);
  assert.deepEqual(cue.endpoint.sets, []);
  assert.equal(cue.watchdogs.length, 0);
});

test('a second capture while lowered does not lower again or lose the original level', (t) => {
  const env = setup(t);
  record(env);
  record(env);
  assert.equal(env.watchdogs.length, 1);
  assert.equal(env.journal.read().originalVolume, 0.8);
  env.ducker.restore('capture stopped');
  assert.equal(env.endpoint.level, 0.8);
});

test('a quantizing endpoint is compared against what it actually holds', (t) => {
  const env = setup(t, { endpoint: new FakeEndpoint({ volume: 0.8, quantum: 0.03 }) });
  record(env);
  const held = env.endpoint.level;
  assert.ok(Math.abs(held - 0.21) < 1e-9);
  assert.equal(env.journal.read().duckedVolume, held);
  env.ducker.restore('capture stopped');
  assert.deepEqual(env.endpoint.sets, [0.2, 0.8]);
  assert.equal(env.journal.exists(), false);
});

test('an endpoint that ignores the new level is put back and nothing is left behind', (t) => {
  const endpoint = new FakeEndpoint();
  endpoint.rejectSet = true;
  const env = setup(t, { endpoint });
  record(env);
  assert.equal(env.ducker.isLowered, false);
  assert.equal(env.journal.exists(), false);
  assert.equal(env.watchdogs[0].stopped, true);
  assert.deepEqual(endpoint.sets, [0.2, 0.8]);
});

test('no watchdog, no lowering: the journal is removed and the volume untouched', (t) => {
  const env = setup(t, { launch: () => { throw new Error('spawn failed'); } });
  record(env);
  assert.deepEqual(env.endpoint.sets, []);
  assert.equal(env.journal.exists(), false);
  assert.match(env.logs.join('\n'), /not lowered: spawn failed/);
});

test('a restore that fails (endpoint busy) is retried, keeping the journal meanwhile', (t) => {
  const env = setup(t);
  record(env);
  env.endpoint.failReads = 3;
  env.ducker.restore('capture stopped');
  assert.ok(env.journal.read(), 'journal kept until restored');
  assert.equal(env.ducker.isLowered, true);
  env.timers.advance(VOICE_VOLUME.restoreRetryMs * 3);
  assert.equal(env.endpoint.level, 0.8);
  assert.equal(env.journal.read(), null);
  assert.equal(env.watchdogs[0].stopped, true);
});

test('a restore that keeps failing gives up after 30 s and leaves it to the watchdog / next launch', (t) => {
  const env = setup(t);
  record(env);
  env.endpoint.failReads = Infinity;
  env.ducker.restore('capture stopped');
  env.timers.advance(VOICE_VOLUME.restoreRetryMs * (VOICE_VOLUME.restoreRetryAttempts + 5));
  assert.equal(env.timers.queue.length, 0);
  assert.ok(env.journal.read());
  assert.equal(env.watchdogs[0].stopped, false, 'the watchdog keeps guarding the journal');
  record(env);
  assert.equal(env.watchdogs.length, 1, 'a new recording cannot overwrite the unrecovered level');
});

test('launch recovers a journal whose owner died, and leaves a live owner\'s alone', async (t) => {
  const dead = await deadPid();
  const env = setup(t, { endpoint: new FakeEndpoint({ volume: 0.2 }) });
  env.journal.write({ deviceId: env.endpoint.id, originalVolume: 0.7, duckedVolume: 0.2, ownerPid: dead, token: 'old', startedAt: 1 });
  env.ducker.recoverAbandonedState();
  assert.equal(env.endpoint.level, 0.7);
  assert.equal(env.journal.exists(), false);

  const alive = setup(t, { endpoint: new FakeEndpoint({ volume: 0.2 }) });
  alive.journal.write({ deviceId: alive.endpoint.id, originalVolume: 0.7, duckedVolume: 0.2, ownerPid: process.pid, token: 'other', startedAt: 1 });
  alive.ducker.recoverAbandonedState();
  assert.equal(alive.endpoint.level, 0.2);
  assert.ok(alive.journal.read());

  const changed = setup(t, { endpoint: new FakeEndpoint({ volume: 0.55 }) });
  changed.journal.write({ deviceId: changed.endpoint.id, originalVolume: 0.7, duckedVolume: 0.2, ownerPid: dead, token: 'old', startedAt: 1 });
  changed.ducker.recoverAbandonedState();
  assert.equal(changed.endpoint.level, 0.55, 'a level the user set since is kept');
  assert.equal(changed.journal.exists(), false);
});

test('an unrecovered journal blocks lowering (never journals the lowered level as original)', async (t) => {
  const env = setup(t, { endpoint: new FakeEndpoint({ volume: 0.2 }) });
  env.journal.write({ deviceId: env.endpoint.id, originalVolume: 0.7, duckedVolume: 0.2, ownerPid: process.pid, token: 'other', startedAt: 1 });
  record(env);
  assert.deepEqual(env.endpoint.sets, []);
  assert.equal(env.journal.read().originalVolume, 0.7);

  const dead = await deadPid();
  const stale = setup(t, { endpoint: new FakeEndpoint({ volume: 0.2 }) });
  stale.journal.write({ deviceId: stale.endpoint.id, originalVolume: 0.7, duckedVolume: 0.2, ownerPid: dead, token: 'old', startedAt: 1 });
  record(stale);
  assert.equal(stale.endpoint.level, 0.7, 'recovered, not lowered on top');
  assert.equal(stale.watchdogs.length, 0);
});

test('recoverVolume: unreadable endpoint is a retry and keeps the journal', (t) => {
  const env = setup(t);
  const state = { deviceId: 'gone', originalVolume: 0.7, duckedVolume: 0.2, ownerPid: 1, token: 'x', startedAt: 1 };
  env.journal.write(state);
  assert.equal(recoverVolume(state, env.endpoint, env.journal), 'retry');
  assert.ok(env.journal.read());
});

test('journal: atomic JSON, malformed content reads as none', (t) => {
  const env = setup(t);
  writeFileSync(env.journal.file, '{"deviceId": 3');
  assert.equal(env.journal.read(), null);
  assert.equal(env.journal.exists(), true);
  env.journal.write({ deviceId: 'd', originalVolume: 0.5, duckedVolume: 0.2, ownerPid: 5, token: 't', startedAt: 1 });
  assert.equal(env.journal.read().token, 't');
  env.journal.remove();
  env.journal.remove();
  assert.equal(existsSync(env.journal.file), false);
});

/** A pid that existed and has exited. */
function deadPid() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', '0']);
    child.on('exit', () => resolve(child.pid));
  });
}

test('processIsAlive', async () => {
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(await deadPid()), false);
  assert.equal(processIsAlive(0), false);
  assert.equal(processIsAlive(1), false);
  assert.equal(processIsAlive(Number.NaN), false);
});

function watchdogEnv(t, endpoint = new FakeEndpoint({ volume: 0.2 })) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kraki-voice-watchdog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const journal = new VolumeJournal(path.join(dir, VOICE_VOLUME.journalName));
  journal.write({ deviceId: endpoint.id, originalVolume: 0.9, duckedVolume: 0.2, ownerPid: 4242, token: 'tok', startedAt: 1 });
  return { journal, endpoint };
}

test('watchdog restores when the owner dies (a real process killed)', async (t) => {
  const { journal, endpoint } = watchdogEnv(t);
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  journal.write({ ...journal.read(), ownerPid: owner.pid });
  const done = runWatchdog({ journalFile: journal.file, token: 'tok', ownerPid: owner.pid, maxSeconds: 60, backend: () => endpoint, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(endpoint.level, 0.2, 'nothing happens while the owner lives');
  owner.kill('SIGKILL');
  assert.equal(await done, 0);
  assert.equal(endpoint.level, 0.9);
  assert.equal(journal.exists(), false);
});

test('watchdog exits untouched once Kraki restored the volume itself or a newer recording owns the journal', async (t) => {
  const removed = watchdogEnv(t);
  const sleep = async () => { removed.journal.remove(); };
  assert.equal(await runWatchdog({ journalFile: removed.journal.file, token: 'tok', ownerPid: process.pid, maxSeconds: 60, backend: () => removed.endpoint, sleep }), 0);
  assert.deepEqual(removed.endpoint.sets, []);

  const replaced = watchdogEnv(t);
  assert.equal(await runWatchdog({ journalFile: replaced.journal.file, token: 'older', ownerPid: 99999999, maxSeconds: 60, backend: () => replaced.endpoint, sleep: async () => {} }), 0);
  assert.deepEqual(replaced.endpoint.sets, []);
});

test('watchdog restores at its ceiling even if the owner lives, and keeps a level the user changed', async (t) => {
  const ceiling = watchdogEnv(t);
  let clock = 0;
  const code = await runWatchdog({ journalFile: ceiling.journal.file, token: 'tok', ownerPid: process.pid, maxSeconds: 1, backend: () => ceiling.endpoint, isAlive: () => true, now: () => clock, sleep: async (ms) => { clock += ms; } });
  assert.equal(code, 0);
  assert.equal(ceiling.endpoint.level, 0.9);
  assert.ok(clock >= 1000);

  const changed = watchdogEnv(t, new FakeEndpoint({ volume: 0.6 }));
  assert.equal(await runWatchdog({ journalFile: changed.journal.file, token: 'tok', ownerPid: 1, maxSeconds: 60, backend: () => changed.endpoint, isAlive: () => false, sleep: async () => {} }), 0);
  assert.equal(changed.endpoint.level, 0.6);
  assert.equal(changed.journal.exists(), false);
});

test('watchdog that cannot reach the endpoint leaves the journal for the next launch', async (t) => {
  const { journal, endpoint } = watchdogEnv(t);
  endpoint.failReads = Infinity;
  assert.equal(await runWatchdog({ journalFile: journal.file, token: 'tok', ownerPid: 1, maxSeconds: 60, backend: () => endpoint, isAlive: () => false, sleep: async () => {} }), 1);
  assert.ok(journal.read());
});

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('the watchdog process (voice-volume-watchdog.cjs) reports ready, exits once the journal is gone, and stop() ends it', async (t) => {
  const { journal } = watchdogEnv(t);
  const state = { ...journal.read(), ownerPid: process.pid };
  journal.write(state);
  // Node stands in for Kraki.exe (ELECTRON_RUN_AS_NODE is set either way).
  const first = await launchWatchdogProcess(journal.file, state, { execPath: process.execPath });
  assert.equal(processIsAlive(first.pid), true, 'armed and waiting while the owner lives');
  journal.remove();
  await until(() => !processIsAlive(first.pid));
  journal.write(state);
  const second = await launchWatchdogProcess(journal.file, state, { execPath: process.execPath });
  second();
  await until(() => !processIsAlive(second.pid));
});

test('watchdog handshake: no `ready` in time (e.g. RunAsNode off: a GUI instance), an early exit or a failed spawn is "not launched", and the child is killed', async (t) => {
  const { journal } = watchdogEnv(t);
  const state = journal.read();
  const dir = path.dirname(journal.file);
  const silent = path.join(dir, 'silent.cjs');
  writeFileSync(silent, `require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, 'silent.pid'))}, String(process.pid)); setInterval(() => {}, 1000);`);
  const started = Date.now();
  await assert.rejects(launchWatchdogProcess(journal.file, state, { execPath: process.execPath, script: silent, readyTimeoutMs: 400 }), /did not report ready/);
  assert.ok(Date.now() - started < 3000);
  await until(() => existsSync(path.join(dir, 'silent.pid')));
  const silentPid = Number(require('node:fs').readFileSync(path.join(dir, 'silent.pid'), 'utf8'));
  await until(() => !processIsAlive(silentPid));

  const quits = path.join(dir, 'quits.cjs');
  writeFileSync(quits, 'process.exit(3)');
  await assert.rejects(launchWatchdogProcess(journal.file, state, { execPath: process.execPath, script: quits }), /exited before it was ready \(code 3\)/);

  const early = path.join(dir, 'not-ready.cjs');
  writeFileSync(early, "process.stdout.write('starting\\n'); setTimeout(() => process.exit(0), 50)");
  await assert.rejects(launchWatchdogProcess(journal.file, state, { execPath: process.execPath, script: early }), /exited before it was ready/);

  await assert.rejects(launchWatchdogProcess(journal.file, state, { execPath: path.join(dir, 'missing.exe') }), /did not start|ENOENT/);
});

/** A watchdog that reports ready when the test says so. */
function deferredWatchdog() {
  const w = { stopped: false };
  w.promise = new Promise((resolve, reject) => { w.ready = () => resolve(() => { w.stopped = true; }); w.fail = reject; });
  return w;
}
const flush = () => new Promise((r) => setImmediate(r));

test('lowering waits for the watchdog to be armed', async (t) => {
  const w = deferredWatchdog();
  const env = setup(t, { launch: () => w.promise });
  record(env);
  assert.equal(env.endpoint.level, 0.8, 'not lowered before `ready`');
  assert.ok(env.journal.read(), 'journaled before the watchdog starts');
  w.ready();
  await flush();
  assert.ok(Math.abs(env.endpoint.level - 0.2) < 1e-9);
  env.ducker.restore('capture stopped');
  assert.equal(env.endpoint.level, 0.8);
  assert.equal(w.stopped, true);
});

test('a watchdog that is not launched (no ready / early exit): nothing lowered, journal removed', async (t) => {
  const w = deferredWatchdog();
  const env = setup(t, { launch: () => w.promise });
  record(env);
  w.fail(new Error('the volume watchdog did not report ready'));
  await flush();
  assert.deepEqual(env.endpoint.sets, []);
  assert.equal(env.journal.exists(), false);
  assert.equal(env.ducker.isLowered, false);
  assert.match(env.logs.join('\n'), /not lowered: the volume watchdog did not report ready/);
  record(env);
  assert.ok(env.journal.read(), 'the next recording tries again');
});

test('released, or the level changed, while the watchdog was starting: never lowered, watchdog stopped', async (t) => {
  const released = deferredWatchdog();
  const a = setup(t, { launch: () => released.promise });
  record(a);
  a.ducker.restore('capture stopped');
  released.ready();
  await flush();
  assert.deepEqual(a.endpoint.sets, []);
  assert.equal(released.stopped, true);
  assert.equal(a.journal.exists(), false);

  const changed = deferredWatchdog();
  const b = setup(t, { launch: () => changed.promise });
  record(b);
  b.endpoint.level = 0.6;
  changed.ready();
  await flush();
  assert.deepEqual(b.endpoint.sets, []);
  assert.equal(b.endpoint.level, 0.6);
  assert.equal(changed.stopped, true);
  assert.equal(b.journal.exists(), false);
});

/** A live process that is not Kraki (a pid Windows reused). */
function livePid(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.after(() => child.kill('SIGKILL'));
  return child.pid;
}

test('a journal whose owner pid now belongs to another live process is still recovered (single-instance: it is not Kraki)', (t) => {
  const reused = livePid(t);
  const env = setup(t, { endpoint: new FakeEndpoint({ volume: 0.2 }) });
  env.journal.write({ deviceId: env.endpoint.id, originalVolume: 0.7, duckedVolume: 0.2, ownerPid: reused, token: 'old', startedAt: 1 });
  env.ducker.recoverAbandonedState();
  assert.equal(env.endpoint.level, 0.7);
  assert.equal(env.journal.exists(), false);

  const pending = setup(t, { endpoint: new FakeEndpoint({ volume: 0.2 }) });
  pending.journal.write({ deviceId: pending.endpoint.id, originalVolume: 0.7, duckedVolume: 0.2, ownerPid: reused, token: 'old', startedAt: 1 });
  record(pending);
  assert.equal(pending.endpoint.level, 0.7, 'recovered when the next recording starts, not left pending');
  assert.equal(pending.watchdogs.length, 0);

  // The old watchdog restoring at the same time is harmless: the second restore sees the user level.
  const race = setup(t, { endpoint: new FakeEndpoint({ volume: 0.2 }) });
  const stale = { deviceId: race.endpoint.id, originalVolume: 0.7, duckedVolume: 0.2, ownerPid: reused, token: 'old', startedAt: 1 };
  race.journal.write(stale);
  race.ducker.recoverAbandonedState();
  race.journal.write(stale);
  assert.equal(recoverVolume(stale, race.endpoint, race.journal), 'userChanged');
  assert.equal(race.endpoint.level, 0.7);
});

test('launch recovery of an endpoint that is not back yet is retried every 250 ms for 30 s, and again on resume/unlock', (t) => {
  const endpoint = new FakeEndpoint({ volume: 0.2 });
  const env = setup(t, { endpoint });
  env.journal.write({ deviceId: endpoint.id, originalVolume: 0.7, duckedVolume: 0.2, ownerPid: 99999999, token: 'old', startedAt: 1 });
  endpoint.failReads = 5;
  env.ducker.recoverAbandonedState();
  assert.equal(endpoint.level, 0.2);
  env.timers.advance(VOICE_VOLUME.restoreRetryMs * 5);
  assert.equal(endpoint.level, 0.7);
  assert.equal(env.journal.exists(), false);

  const away = setup(t, { endpoint: new FakeEndpoint({ volume: 0.2 }) });
  away.journal.write({ deviceId: away.endpoint.id, originalVolume: 0.7, duckedVolume: 0.2, ownerPid: 99999999, token: 'old', startedAt: 1 });
  away.endpoint.failReads = Infinity;
  away.ducker.recoverAbandonedState();
  away.timers.advance(VOICE_VOLUME.restoreRetryMs * (VOICE_VOLUME.restoreRetryAttempts + 5));
  assert.equal(away.timers.queue.length, 0, 'gives up after 120 attempts');
  assert.ok(away.journal.read(), 'journal kept');
  away.endpoint.failReads = 0;
  away.ducker.recoverAbandonedState(); // powerMonitor resume / unlock-screen
  assert.equal(away.endpoint.level, 0.7);
  assert.equal(away.journal.exists(), false);
});
