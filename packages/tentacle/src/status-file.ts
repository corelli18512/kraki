/**
 * Daemon status file — written to ~/.kraki/status.json on every state change.
 * Read by the desktop toolbar to display connection status without a relay connection.
 * Deleted on daemon shutdown.
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { getKrakiHome } from './config.js';

export interface DaemonStatusFile {
  daemonRunning: boolean;
  relayState: 'disconnected' | 'connecting' | 'authenticating' | 'connected';
  relay: string;
  deviceName: string;
  region?: string;
  /** macOS Full Disk Access as observed by the daemon process itself. */
  fda?: 'granted' | 'denied' | 'missing';
  fdaCheckedAt?: number;
  /** Who supervises this daemon: the Mac app's launchd job or the CLI. */
  managedBy?: 'kraki-mac' | 'cli';
  version?: string;
  pid?: number;
  updatedAt: number;
}

function getStatusPath(): string {
  return join(getKrakiHome(), 'status.json');
}

let _current: DaemonStatusFile = {
  daemonRunning: true,
  relayState: 'disconnected',
  relay: '',
  deviceName: '',
  updatedAt: Date.now(),
};

export function initStatusFile(relay: string, deviceName: string): void {
  _current = { ..._current, relay, deviceName, updatedAt: Date.now() };
  writeStatus();
}

export function updateRelayState(state: DaemonStatusFile['relayState']): void {
  _current = { ..._current, relayState: state, updatedAt: Date.now() };
  writeStatus();
}

export function updateRegion(region: string): void {
  _current = { ..._current, region, updatedAt: Date.now() };
  writeStatus();
}

export function updateFdaStatus(fda: NonNullable<DaemonStatusFile['fda']>): void {
  const now = Date.now();
  _current = { ..._current, fda, fdaCheckedAt: now, updatedAt: now };
  writeStatus();
}

export function updateDaemonIdentity(identity: Pick<DaemonStatusFile, 'managedBy' | 'version' | 'pid'>): void {
  _current = { ..._current, ...identity, updatedAt: Date.now() };
  writeStatus();
}

export function clearStatusFile(): void {
  try { unlinkSync(getStatusPath()); } catch { /* file may not exist */ }
}

export function readStatusFile(): DaemonStatusFile | null {
  const path = getStatusPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DaemonStatusFile;
  } catch {
    return null;
  }
}

function writeStatus(): void {
  try {
    // tmp + rename: readers (`kraki status`, Kraki for Mac) never see a
    // half-written file and briefly report "not running".
    const path = getStatusPath();
    writeFileSync(`${path}.tmp`, JSON.stringify(_current, null, 2), 'utf8');
    renameSync(`${path}.tmp`, path);
  } catch { /* ignore write errors (e.g. disk full) */ }
}
