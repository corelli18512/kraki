'use strict';
// `Kraki.exe <this file> <journal> <token> <ownerPid> <maxSeconds>` with
// ELECTRON_RUN_AS_NODE=1, started by main.cjs when the volume is lowered:
// restores it if Kraki dies mid-recording (voice-volume.cjs runWatchdog).
const { runWatchdog, WATCHDOG_READY } = require('./voice-volume.cjs');

const [journalFile, token, owner, max] = process.argv.slice(2);
const ownerPid = Number(owner);
const maxSeconds = Number(max);
if (!journalFile || !token || !Number.isInteger(ownerPid) || !Number.isFinite(maxSeconds)) process.exit(64);

let backend = null;
// Armed: Kraki lowers the volume only after reading this line.
try { process.stdout.write(`${WATCHDOG_READY}\n`); } catch { /* Kraki stopped listening */ }
process.stdout.on?.('error', () => { /* Kraki's end is closed once armed */ });
runWatchdog({
  journalFile, token, ownerPid, maxSeconds,
  backend: () => (backend ??= require('./windows-audio.cjs').createWindowsAudioBackend()),
}).then((code) => process.exit(code), () => process.exit(1));
