/**
 * Daemon status file — written to ~/.kraki/status.json on every state change.
 * Read by the desktop toolbar to display connection status without a relay connection.
 * Deleted on daemon shutdown.
 */

import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getKrakiHome } from './config.js';

export interface DaemonStatusFile {
  daemonRunning: boolean;
  relayState: 'disconnected' | 'connecting' | 'authenticating' | 'connected';
  relay: string;
  deviceName: string;
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

export function clearStatusFile(): void {
  try { unlinkSync(getStatusPath()); } catch { /* file may not exist */ }
}

function writeStatus(): void {
  try {
    writeFileSync(getStatusPath(), JSON.stringify(_current, null, 2), 'utf8');
  } catch { /* ignore write errors (e.g. disk full) */ }
}
