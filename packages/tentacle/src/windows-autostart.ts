/**
 * Start Kraki again when the user logs in to Windows — the counterpart of the
 * launchd job on macOS. A per-user Run entry (HKCU, no admin rights needed)
 * runs `kraki start --login` through `conhost --headless`, so no console window
 * appears at login. Starting Kraki adds it; stopping Kraki on purpose removes
 * it, like loading/unloading the launchd job.
 */

import { execFileSync } from 'node:child_process';
import { isSea } from 'node:sea';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE = 'Kraki';

export function loginCommand(execPath = process.execPath, script = process.argv[1], sea = isSea()): string {
  const target = sea ? `"${execPath}"` : `"${execPath}" "${script}"`;
  return `conhost.exe --headless ${target} start --login`;
}

function reg(args: string[]): boolean {
  try {
    execFileSync('reg', args, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function enableWindowsAutostart(command = loginCommand()): boolean {
  if (process.platform !== 'win32' || process.env.KRAKI_NO_AUTOSTART === '1') return false;
  return reg(['add', RUN_KEY, '/v', VALUE, '/t', 'REG_SZ', '/d', command, '/f']);
}

export function disableWindowsAutostart(): boolean {
  if (process.platform !== 'win32') return false;
  return reg(['delete', RUN_KEY, '/v', VALUE, '/f']);
}
