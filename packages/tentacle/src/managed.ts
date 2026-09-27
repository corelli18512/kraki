/**
 * Ownership of the background daemon.
 *
 * Kraki's daemon can be supervised by exactly one owner at a time:
 *
 *   - the standalone CLI, which installs a per-user launchd job
 *     (`cloud.corelli.kraki`, see daemon.ts), or
 *   - Kraki for Mac, which embeds this same tentacle binary as a helper and
 *     registers it with SMAppService (`chat.kraki.mac.tentacle`).
 *
 * Two owners would mean two daemons sharing one device id, which makes the
 * relay drop roughly half of the traffic (last writer wins per device id). The
 * Mac app therefore records its ownership in `<KRAKI_HOME>/managed-by.json`,
 * and every lifecycle command in the CLI respects it instead of installing a
 * second launchd job.
 *
 * The marker is advisory state shared by two programs, not a lock: the Mac app
 * writes it before registering its job and removes it after unregistering.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getKrakiHome } from './config.js';

/** Value of `KRAKI_MANAGED_BY` injected by the Mac app's launchd job. */
export const MAC_APP_OWNER = 'kraki-mac';

/** launchd label of the SMAppService job registered by Kraki for Mac. */
export const MAC_APP_DAEMON_LABEL = 'chat.kraki.mac.tentacle';

export interface ManagedByMarker {
  by: typeof MAC_APP_OWNER;
  /** launchd label of the supervising job. */
  label: string;
  /** Absolute path of the owning app, informational only. */
  appPath?: string;
  /** Version of the owning app, informational only. */
  appVersion?: string;
  updatedAt: string;
}

export function getManagedByPath(): string {
  return join(getKrakiHome(), 'managed-by.json');
}

export function loadManagedBy(): ManagedByMarker | null {
  const path = getManagedByPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ManagedByMarker>;
    if (parsed.by !== MAC_APP_OWNER || typeof parsed.label !== 'string' || parsed.label.length === 0) {
      return null;
    }
    return {
      by: MAC_APP_OWNER,
      label: parsed.label,
      appPath: typeof parsed.appPath === 'string' ? parsed.appPath : undefined,
      appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : undefined,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return null;
  }
}

export function saveManagedBy(marker: Omit<ManagedByMarker, 'updatedAt'>): void {
  const value: ManagedByMarker = { ...marker, updatedAt: new Date().toISOString() };
  writeFileSync(getManagedByPath(), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export function clearManagedBy(): void {
  try { unlinkSync(getManagedByPath()); } catch { /* absent */ }
}

/** True inside the daemon worker launched by Kraki for Mac's launchd job. */
export function isMacAppManagedWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KRAKI_MANAGED_BY === MAC_APP_OWNER;
}

/**
 * Ask launchd to restart the Mac app's job in place.
 *
 * `kickstart -k` kills the running instance and starts a fresh one under the
 * same supervision, so KeepAlive stays in force and no duplicate is created.
 * Returns false when the job is not loaded (the Mac app has not registered it,
 * or the user turned it off in Login Items).
 */
export function kickstartManagedDaemon(
  label: string,
  uid: number | undefined = process.getuid?.(),
): boolean {
  if (process.platform !== 'darwin' || uid === undefined) return false;
  try {
    execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

export function isManagedDaemonLoaded(
  label: string,
  uid: number | undefined = process.getuid?.(),
): boolean {
  if (process.platform !== 'darwin' || uid === undefined) return false;
  try {
    execFileSync('/bin/launchctl', ['print', `gui/${uid}/${label}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}
