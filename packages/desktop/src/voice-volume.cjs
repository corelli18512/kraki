'use strict';
// Lowers this PC's sound output while the user dictates, and puts it back:
// Kraki for Mac's MacOutputVolumeDucker (packages/arm/ios/Kraki/Core/Speech)
// for Kraki for Windows. The default render endpoint's master volume goes to
// min(original, 20 %, original × 40 %) while the microphone records and is
// restored when capture stops (released, cancelled, failed, window closed,
// app quitting), not after correction.
//
// Safety, because a volume left low is very visible:
//   • Restore only if the endpoint is still at the level we set: a change the
//     user made meanwhile (or mute) is never overwritten.
//   • The original level is journaled to disk before the volume is lowered.
//     A watchdog process (voice-volume-watchdog.cjs) restores it if Kraki
//     dies mid-recording; the next launch also recovers a journal whose owner
//     is gone.
//   • Endpoints without a writable volume, muted ones and already quiet ones
//     are left alone.
//   • Lowering waits for the start cue to be heard (it plays at full volume).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VOICE_VOLUME = Object.freeze({
  cap: 0.20,
  scale: 0.40,
  /** Smaller than this, lowering is not worth touching the endpoint. */
  minimumDrop: 0.02,
  /** "Still at the level we set" (endpoints quantize volume steps). */
  tolerance: 0.015,
  /** Lower no sooner than this after capture starts. */
  cueDelayMs: 250,
  /** Lowering waits for the start cue to finish, at most this long. */
  cueFinishTimeoutMs: 2000,
  /** Watchdog ceiling: give the volume back even if Kraki never says so. */
  watchdogMaxSeconds: 30 * 60,
  /** An endpoint switch can briefly fail a restore: retry for 30 s. */
  restoreRetryMs: 250,
  restoreRetryAttempts: 120,
  journalName: 'voice-output-volume.json',
});

/** null: don't touch the volume (already quiet enough). */
function duckTarget(original) {
  const target = Math.min(original, VOICE_VOLUME.cap, original * VOICE_VOLUME.scale);
  return original - target >= VOICE_VOLUME.minimumDrop ? target : null;
}

function isVolumeState(s) {
  return !!s && typeof s.deviceId === 'string' && Number.isFinite(s.originalVolume) && Number.isFinite(s.duckedVolume)
    && Number.isInteger(s.ownerPid) && typeof s.token === 'string';
}

/** The on-disk record of a lowered volume (crash recovery). */
class VolumeJournal {
  constructor(file) { this.file = file; }

  /** The journaled state, or null (missing or unreadable). */
  read() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return isVolumeState(s) ? s : null;
    } catch { return null; }
  }

  exists() { return fs.existsSync(this.file); }

  write(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    // Windows refuses to replace a file another process (the watchdog) has
    // open for its brief read: try again a few times.
    for (let attempt = 1; ; attempt++) {
      try { fs.renameSync(tmp, this.file); return; }
      catch (error) {
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) { fs.rmSync(tmp, { force: true }); throw error; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  }

  remove() { try { fs.rmSync(this.file, { force: true }); } catch { /* gone */ } }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/**
 * Restore only if the endpoint is still at the level Kraki applied.
 * @returns {'restored' | 'userChanged' | 'retry'}
 */
function recoverVolume(state, backend, journal) {
  let current;
  try { current = backend.volume(state.deviceId); } catch { return 'retry'; }
  if (backend.isMuted(state.deviceId) || Math.abs(current - state.duckedVolume) > VOICE_VOLUME.tolerance) {
    journal.remove();
    return 'userChanged';
  }
  try {
    backend.setVolume(state.deviceId, state.originalVolume);
    journal.remove();
    return 'restored';
  } catch { return 'retry'; }
}

const percent = (v) => `${Math.round(v * 100)}%`;

/**
 * backend: { defaultDevice(): string, supportsWritableVolume(id): boolean,
 *   volume(id): number, setVolume(id, v), isMuted(id): boolean } (Core Audio
 *   in the app, windows-audio.cjs; a fake in tests).
 * launchWatchdog(journalFile, state): returns stop().
 */
class VoiceVolumeDucker {
  constructor({ backend, journal, launchWatchdog, isEnabled, pid = process.pid, log = () => {}, timers = globalThis, newToken = () => crypto.randomUUID() }) {
    Object.assign(this, { backend, journal, launchWatchdog, isEnabled, pid, log, timers, newToken });
    this.state = null;
    this.stopWatchdog = null;
    this.pendingLower = null;
    /** The start cue is still being heard: lowering waits for it. */
    this.cuePlaying = false;
    this.cueTimeout = null;
    /** Lowering is due but waits for the cue to finish. */
    this.lowerAfterCue = false;
    this.restoreRetry = null;
  }

  get isLowered() { return this.state !== null; }

  /** Launch: a journal left by a Kraki that died mid-recording. */
  recoverAbandonedState() {
    const stale = this.journal.read();
    if (this.state || !stale || processIsAlive(stale.ownerPid)) return;
    this.log(`output volume recovery after abnormal exit: ${recoverVolume(stale, this.backend, this.journal)}`);
  }

  /** The start cue began playing: lowering must not cut into it. */
  cueStarted(timeoutMs = VOICE_VOLUME.cueFinishTimeoutMs) {
    this.cuePlaying = true;
    this.clear('cueTimeout');
    this.cueTimeout = this.timers.setTimeout(() => this.endCue(), timeoutMs);
  }

  /** The start cue finished (or could not play). */
  cueFinished() { this.endCue(); }

  endCue() {
    this.clear('cueTimeout');
    this.cuePlaying = false;
    if (this.lowerAfterCue) {
      this.lowerAfterCue = false;
      this.lower();
    }
  }

  /** Capture started: lower the volume once the start cue has been heard. */
  scheduleLowering(delayMs = VOICE_VOLUME.cueDelayMs) {
    this.clear('pendingLower');
    this.lowerAfterCue = false;
    if (!this.isEnabled() || this.state) return;
    this.pendingLower = this.timers.setTimeout(() => {
      this.pendingLower = null;
      if (this.cuePlaying) this.lowerAfterCue = true;
      else this.lower();
    }, delayMs);
  }

  /** Capture stopped (released, cancelled, failed, window closed, app quitting). */
  restore(reason) {
    this.clear('pendingLower');
    this.lowerAfterCue = false;
    const current = this.state;
    if (!current) return;
    const result = recoverVolume(current, this.backend, this.journal);
    if (result === 'retry') { this.scheduleRetry(current, 1); return; }
    this.log(`output volume released reason=${reason} result=${result}`);
    this.finish();
  }

  lower() {
    this.pendingLower = null;
    if (!this.isEnabled() || this.state) return;
    this.clear('restoreRetry');
    let device;
    let original;
    try {
      device = this.backend.defaultDevice();
      if (!this.backend.supportsWritableVolume(device) || this.backend.isMuted(device)) {
        this.log('output volume left alone: no writable volume or muted');
        return;
      }
      original = this.backend.volume(device);
    } catch (error) {
      this.log(`output volume not lowered: ${error?.message ?? error}`);
      return;
    }
    // A journal left by a Kraki that died (its recovery couldn't run yet)
    // holds the user's real level: never overwrite it with the still-lowered
    // one. Leave the volume alone until it is recovered.
    const stale = this.journal.read();
    if (stale) {
      this.log('output volume left alone: an unrecovered level is pending');
      if (!processIsAlive(stale.ownerPid)) this.log(`pending output volume recovery: ${recoverVolume(stale, this.backend, this.journal)}`);
      return;
    }
    const target = duckTarget(original);
    if (target === null) return;
    const state = { deviceId: device, originalVolume: original, duckedVolume: target, ownerPid: this.pid, token: this.newToken(), startedAt: Date.now() };
    let stop;
    try {
      this.journal.write(state);
      try { stop = this.launchWatchdog(this.journal.file, state); }
      catch (error) { this.journal.remove(); throw error; }
    } catch (error) {
      this.log(`output volume not lowered: ${error?.message ?? error}`);
      return;
    }
    let applied = state;
    try {
      this.backend.setVolume(device, target);
      const observed = this.backend.volume(device);
      if (Math.abs(observed - target) > VOICE_VOLUME.tolerance) throw new Error('endpoint rejected the volume');
      // Compare later against what the endpoint actually holds (quantized),
      // so a one-step change by the user is noticed.
      if (observed !== target) {
        applied = { ...state, duckedVolume: observed };
        this.journal.write(applied);
      }
    } catch (error) {
      // Put back whatever we may have changed before giving up.
      try { this.backend.setVolume(device, original); } catch { /* best effort */ }
      this.journal.remove();
      stop();
      this.log(`output volume not lowered: ${error?.message ?? error}`);
      return;
    }
    this.state = applied;
    this.stopWatchdog = stop;
    this.log(`output volume ${percent(original)} → ${percent(applied.duckedVolume)}`);
  }

  /** Retry for 30 s, then leave it to the watchdog / next launch (keeping the
   *  journal, so a new recording can't overwrite the unrecovered level). */
  scheduleRetry(target, attempt) {
    this.clear('restoreRetry');
    this.restoreRetry = this.timers.setTimeout(() => {
      this.restoreRetry = null;
      if (this.state?.token !== target.token) return;
      const result = recoverVolume(target, this.backend, this.journal);
      if (result !== 'retry') { this.log(`output volume released after retry result=${result}`); this.finish(); }
      else if (attempt < VOICE_VOLUME.restoreRetryAttempts) this.scheduleRetry(target, attempt + 1);
      else this.log('output volume restore gave up; the watchdog or next launch restores it');
    }, VOICE_VOLUME.restoreRetryMs);
  }

  finish() {
    this.clear('restoreRetry');
    const stop = this.stopWatchdog;
    this.stopWatchdog = null;
    this.state = null;
    stop?.();
  }

  clear(name) {
    if (this[name]) this.timers.clearTimeout(this[name]);
    this[name] = null;
  }
}

/**
 * The watchdog: waits for the owner to exit (or the ceiling), then restores
 * the volume. Exits once Kraki restored it itself (journal gone or replaced).
 * @returns {Promise<number>} the exit code
 */
async function runWatchdog({ journalFile, token, ownerPid, maxSeconds, backend, isAlive = processIsAlive, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const journal = new VolumeJournal(journalFile);
  const deadline = now() + maxSeconds * 1000;
  for (;;) {
    const state = journal.read();
    // An unreadable journal that still exists may be mid-replace: keep waiting.
    if (!state && !journal.exists()) return 0;
    if (state && state.token !== token) return 0;
    if (state && (!isAlive(ownerPid) || now() >= deadline)) {
      for (let i = 0; i < VOICE_VOLUME.restoreRetryAttempts; i++) {
        if (recoverVolume(state, backend(), journal) !== 'retry') return 0;
        await sleep(VOICE_VOLUME.restoreRetryMs);
      }
      return 1; // the next launch retries from the journal
    }
    if (!state && now() >= deadline) return 1;
    await sleep(100);
  }
}

module.exports = { VOICE_VOLUME, duckTarget, VolumeJournal, processIsAlive, recoverVolume, VoiceVolumeDucker, runWatchdog };
