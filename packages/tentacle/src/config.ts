/**
 * Configuration management for Kraki tentacle.
 *
 * By default Kraki stores state under ~/.kraki. For local development and tests,
 * the root can be overridden with KRAKI_HOME.
 */

import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AuthMethod } from '@kraki/protocol';

// ── Types ───────────────────────────────────────────────

export type KrakiLogVerbosity = 'normal' | 'verbose';

export interface KrakiConfig {
  relay: string;
  authMethod: AuthMethod['method'];
  device: { name: string; id?: string };
  logging?: {
    verbosity?: KrakiLogVerbosity;
  };
}

export const DEFAULT_LOG_VERBOSITY: KrakiLogVerbosity = 'normal';

// ── Paths ───────────────────────────────────────────────

export function getKrakiHome(): string {
  const override = process.env.KRAKI_HOME?.trim();
  return override ? join(override) : join(homedir(), '.kraki');
}

export function getConfigDir(): string {
  const dir = getKrakiHome();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getConfigPath(): string {
  return join(getKrakiHome(), 'config.json');
}

export function getLogsDir(): string {
  const dir = join(getKrakiHome(), 'logs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getDeviceIdPath(): string {
  return join(getKrakiHome(), 'device-id');
}

// ── Device ID ───────────────────────────────────────────

/**
 * Get the stable device ID for this machine.
 * Generated once and persisted under the current Kraki home.
 * Sent to the head on auth so reconnections don't create ghost devices.
 */
export function getOrCreateDeviceId(): string {
  const deviceIdPath = getDeviceIdPath();
  try {
    const existing = readFileSync(deviceIdPath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // File doesn't exist — generate one
  }
  const id = `dev_${randomUUID().slice(0, 12)}`;
  getConfigDir();
  writeFileSync(deviceIdPath, id, 'utf8');
  return id;
}

// ── Config ──────────────────────────────────────────────

export function configExists(): boolean {
  return existsSync(getConfigPath());
}

export function getLogVerbosity(config: Pick<KrakiConfig, 'logging'> | null | undefined): KrakiLogVerbosity {
  return config?.logging?.verbosity === 'verbose' ? 'verbose' : DEFAULT_LOG_VERBOSITY;
}

function normalizeConfig(config: KrakiConfig): KrakiConfig {
  return {
    ...config,
    device: { ...config.device },
    logging: { verbosity: getLogVerbosity(config) },
  };
}

export function loadConfig(): KrakiConfig | null {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    return normalizeConfig(JSON.parse(raw) as KrakiConfig);
  } catch {
    return null;
  }
}

export function saveConfig(config: KrakiConfig): void {
  getConfigDir();
  writeFileSync(getConfigPath(), JSON.stringify(normalizeConfig(config), null, 2) + '\n', 'utf8');
}

// ── Channel key ─────────────────────────────────────────

export function getChannelKeyPath(): string {
  return join(getKrakiHome(), 'channel.key');
}

export function saveChannelKey(key: string): void {
  getConfigDir();
  const keyPath = getChannelKeyPath();
  writeFileSync(keyPath, key, 'utf8');
  chmodSync(keyPath, 0o600);
}

export function loadChannelKey(): string | null {
  try {
    return readFileSync(getChannelKeyPath(), 'utf8').trim();
  } catch {
    return null;
  }
}

// ── GitHub Token (device flow) ──────────────────────────

function getGitHubTokenPath(): string {
  return join(getKrakiHome(), 'github-token');
}

export function saveGitHubToken(token: string): void {
  getConfigDir();
  const tokenPath = getGitHubTokenPath();
  writeFileSync(tokenPath, token, 'utf8');
  chmodSync(tokenPath, 0o600);
}

export function loadGitHubToken(): string | null {
  try {
    return readFileSync(getGitHubTokenPath(), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// ── Daemon PID ──────────────────────────────────────────

export function getDaemonPidPath(): string {
  return join(getKrakiHome(), 'daemon.pid');
}

export function saveDaemonPid(pid: number): void {
  getConfigDir();
  writeFileSync(getDaemonPidPath(), String(pid), 'utf8');
}

export function loadDaemonPid(): number | null {
  try {
    const raw = readFileSync(getDaemonPidPath(), 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function clearDaemonPid(): void {
  try {
    unlinkSync(getDaemonPidPath());
  } catch {
    // File may not exist — that's fine
  }
}
