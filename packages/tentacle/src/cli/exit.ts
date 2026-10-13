/** Exiting the CLI: on a double-clicked Windows kraki.exe, wait for a key so the output stays readable. */

import { launchedFromExplorer } from '../windows-console.js';

// Detect Node.js SEA (Single Executable Application)
export const _isSEA = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();

// Double-clicked kraki.exe gets its own console that closes on exit, hiding
// the output; pause there. Run from a terminal (cmd, PowerShell, Windows
// Terminal) it must not wait for a key.
export let _doubleClickCache: boolean | undefined;
export function _isWindowsDoubleClick(): boolean {
  if (_doubleClickCache === undefined) {
    _doubleClickCache = process.platform === 'win32' && _isSEA && !!process.stdin.isTTY
      && launchedFromExplorer(process.env, process.ppid);
  }
  return _doubleClickCache === true;
}

// Graceful exit: on Windows SEA, avoid process.exit() after async work.
// Instead, schedule exit and let libuv drain.
export function gracefulExit(code: number): void {
  if (_isWindowsDoubleClick()) {
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin });
    process.stdout.write('\nPress any key to exit...');
    process.stdin.setRawMode?.(true);
    process.stdin.once('data', () => process.exit(code));
    return;
  }
  process.exit(code);
}
