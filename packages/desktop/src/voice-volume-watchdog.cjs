'use strict';
// `Kraki.exe <this file> <journal> <token> <ownerPid> <maxSeconds>` with
// ELECTRON_RUN_AS_NODE=1, started by main.cjs when the volume is lowered:
// restores it if Kraki dies mid-recording (voice-volume.cjs runWatchdog).
const { runWatchdog } = require('./voice-volume.cjs');

const [journalFile, token, owner, max] = process.argv.slice(2);
const ownerPid = Number(owner);
const maxSeconds = Number(max);
if (!journalFile || !token || !Number.isInteger(ownerPid) || !Number.isFinite(maxSeconds)) process.exit(64);

let backend = null;
runWatchdog({
  journalFile, token, ownerPid, maxSeconds,
  backend: () => (backend ??= require('./windows-audio.cjs').createWindowsAudioBackend()),
}).then((code) => process.exit(code), () => process.exit(1));
