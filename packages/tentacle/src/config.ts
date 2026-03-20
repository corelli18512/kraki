/**
 * Configuration management for Kraki tentacle.
 *
 * Config is stored at ~/.kraki/config.json (no secrets).
 * Channel keys are stored separately at ~/.kraki/channel.key with 0o600 permissions.
 * Daemon PID is tracked at ~/.kraki/daemon.pid.
 */

import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ── Types ───────────────────────────────────────────────

export interface KrakiConfig {
  relay: string;
  authMethod: 'github' | 'channel-key' | 'open';
  device: { name: string; id?: string };
}

// ── Paths ───────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), '.kraki');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const CHANNEL_KEY_PATH = join(CONFIG_DIR, 'channel.key');
const DAEMON_PID_PATH = join(CONFIG_DIR, 'daemon.pid');
const DEVICE_ID_PATH = join(CONFIG_DIR, 'device-id');

export function getConfigDir(): string {
  mkdirSync(CONFIG_DIR, { recursive: true });
  return CONFIG_DIR;
}

// ── Device ID ───────────────────────────────────────────

/**
 * Get the stable device ID for this machine.
 * Generated once and persisted at ~/.kraki/device-id.
 * Sent to the head on auth so reconnections don't create ghost devices.
 */
export function getOrCreateDeviceId(): string {
  try {
    const existing = readFileSync(DEVICE_ID_PATH, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // File doesn't exist — generate one
  }
  const id = `dev_${randomUUID().slice(0, 12)}`;
  getConfigDir();
  writeFileSync(DEVICE_ID_PATH, id, 'utf8');
  return id;
}

// ── Config ──────────────────────────────────────────────

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function loadConfig(): KrakiConfig | null {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as KrakiConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: KrakiConfig): void {
  getConfigDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

// ── Channel key ─────────────────────────────────────────

export function getChannelKeyPath(): string {
  return CHANNEL_KEY_PATH;
}

export function saveChannelKey(key: string): void {
  getConfigDir();
  writeFileSync(CHANNEL_KEY_PATH, key, 'utf8');
  chmodSync(CHANNEL_KEY_PATH, 0o600);
}

export function loadChannelKey(): string | null {
  try {
    return readFileSync(CHANNEL_KEY_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

// ── Daemon PID ──────────────────────────────────────────

export function getDaemonPidPath(): string {
  return DAEMON_PID_PATH;
}

export function saveDaemonPid(pid: number): void {
  getConfigDir();
  writeFileSync(DAEMON_PID_PATH, String(pid), 'utf8');
}

export function loadDaemonPid(): number | null {
  try {
    const raw = readFileSync(DAEMON_PID_PATH, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function clearDaemonPid(): void {
  try {
    unlinkSync(DAEMON_PID_PATH);
  } catch {
    // File may not exist — that's fine
  }
}
