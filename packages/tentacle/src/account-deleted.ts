/**
 * What this computer does when its Kraki account was deleted (from an app,
 * App Store 5.1.1(v)): forget the sign-in and this computer's identity so it
 * neither reconnects nor signs up again, and stop starting at login. Sessions
 * stay on disk — they are the user's own files on their own computer; the
 * CLI's "Delete all Kraki data…" removes them.
 */

import { rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getChannelKeyPath, getConfigPath, getKrakiHome } from './config.js';
import { loadManagedBy } from './managed.js';
import { retireCliLaunchdJob } from './daemon.js';
import { disableWindowsAutostart } from './windows-autostart.js';

/** Credentials and identity files removed on account deletion. */
export function accountFiles(): string[] {
  const home = getKrakiHome();
  return [
    getConfigPath(),
    getChannelKeyPath(),
    join(home, 'github-token'),
    join(home, 'device-id'),
  ];
}

export function forgetDeletedAccount(): void {
  for (const path of accountFiles()) {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
  try { rmSync(join(getKrakiHome(), 'keys'), { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Stop starting at login. Kraki for Mac owns its own service and turns it off
 * when it learns about the deletion itself.
 */
export function retireAutostart(): void {
  if (loadManagedBy()) return;
  try {
    if (process.platform === 'darwin') retireCliLaunchdJob();
    if (process.platform === 'win32') disableWindowsAutostart();
  } catch { /* best effort */ }
}
