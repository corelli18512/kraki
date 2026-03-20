/**
 * Unit tests for config.ts — config/key/PID file management.
 *
 * Uses a temp directory instead of the real ~/.kraki to keep tests isolated.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, statSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

// Redirect homedir so CONFIG_DIR resolves to our temp folder
let tempHome: string;

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => tempHome,
  };
});

// Must import AFTER the mock is registered so module-level constants use the mock
let config: typeof import('../config.js');

beforeEach(async () => {
  tempHome = mkdtempSync(join(tmpdir(), 'kraki-config-test-'));
  // Re-import the module so it picks up the new tempHome
  vi.resetModules();
  config = await import('../config.js');
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

// ── getConfigDir ────────────────────────────────────────

describe('getConfigDir()', () => {
  it('returns ~/.kraki path', () => {
    const dir = config.getConfigDir();
    expect(dir).toBe(join(tempHome, '.kraki'));
  });

  it('creates the directory if it does not exist', () => {
    expect(existsSync(join(tempHome, '.kraki'))).toBe(false);
    config.getConfigDir();
    expect(existsSync(join(tempHome, '.kraki'))).toBe(true);
  });

  it('is idempotent — calling twice does not throw', () => {
    config.getConfigDir();
    expect(() => config.getConfigDir()).not.toThrow();
  });
});

// ── configExists ────────────────────────────────────────

describe('configExists()', () => {
  it('returns false when no config file exists', () => {
    expect(config.configExists()).toBe(false);
  });

  it('returns true after saveConfig', () => {
    config.saveConfig({ relay: 'wss://relay.test', authMethod: 'github', device: { name: 'test' } });
    expect(config.configExists()).toBe(true);
  });
});

// ── loadConfig / saveConfig ─────────────────────────────

describe('loadConfig() / saveConfig()', () => {
  const sampleConfig = {
    relay: 'wss://kraki.corelli.cloud',
    authMethod: 'github' as const,
    device: { name: 'my-laptop' },
  };

  it('returns null when no config exists', () => {
    expect(config.loadConfig()).toBeNull();
  });

  it('round-trips a config through save and load', () => {
    config.saveConfig(sampleConfig);
    const loaded = config.loadConfig();
    expect(loaded).toEqual(sampleConfig);
  });

  it('writes valid JSON to disk', () => {
    config.saveConfig(sampleConfig);
    const raw = readFileSync(join(tempHome, '.kraki', 'config.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual(sampleConfig);
  });

  it('creates config dir when saving', () => {
    expect(existsSync(join(tempHome, '.kraki'))).toBe(false);
    config.saveConfig(sampleConfig);
    expect(existsSync(join(tempHome, '.kraki'))).toBe(true);
  });

  it('overwrites existing config', () => {
    config.saveConfig(sampleConfig);
    const updated = { ...sampleConfig, device: { name: 'other-machine' } };
    config.saveConfig(updated);
    expect(config.loadConfig()).toEqual(updated);
  });
});

// ── Channel key ─────────────────────────────────────────

describe('getChannelKeyPath()', () => {
  it('returns path inside .kraki dir', () => {
    const p = config.getChannelKeyPath();
    expect(p).toBe(join(tempHome, '.kraki', 'channel.key'));
  });
});

describe('saveChannelKey() / loadChannelKey()', () => {
  const key = 'super-secret-channel-key-123';

  it('returns null when no key file exists', () => {
    expect(config.loadChannelKey()).toBeNull();
  });

  it('round-trips a channel key', () => {
    config.saveChannelKey(key);
    expect(config.loadChannelKey()).toBe(key);
  });

  it('sets file permissions to 0o600', () => {
    config.saveChannelKey(key);
    const st = statSync(config.getChannelKeyPath());
    // Mask to lower 9 bits (owner/group/other rwx)
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('trims whitespace on load', () => {
    // Manually write with trailing whitespace
    const keyPath = config.getChannelKeyPath();
    mkdirSync(join(tempHome, '.kraki'), { recursive: true });
    writeFileSync(keyPath, `  ${key}  \n`, 'utf8');
    expect(config.loadChannelKey()).toBe(key);
  });
});

// ── Daemon PID ──────────────────────────────────────────

describe('getDaemonPidPath()', () => {
  it('returns path inside .kraki dir', () => {
    expect(config.getDaemonPidPath()).toBe(join(tempHome, '.kraki', 'daemon.pid'));
  });
});

describe('saveDaemonPid() / loadDaemonPid() / clearDaemonPid()', () => {
  it('returns null when no PID file exists', () => {
    expect(config.loadDaemonPid()).toBeNull();
  });

  it('round-trips a PID', () => {
    config.saveDaemonPid(12345);
    expect(config.loadDaemonPid()).toBe(12345);
  });

  it('clears the PID file', () => {
    config.saveDaemonPid(99999);
    expect(config.loadDaemonPid()).toBe(99999);
    config.clearDaemonPid();
    expect(config.loadDaemonPid()).toBeNull();
  });

  it('clearDaemonPid does not throw when file is already missing', () => {
    expect(() => config.clearDaemonPid()).not.toThrow();
  });

  it('returns null for non-numeric PID content', () => {
    mkdirSync(join(tempHome, '.kraki'), { recursive: true });
    writeFileSync(join(tempHome, '.kraki', 'daemon.pid'), 'not-a-number', 'utf8');
    expect(config.loadDaemonPid()).toBeNull();
  });
});

describe('getOrCreateDeviceId()', () => {
  it('generates a new device ID on first call', () => {
    const id = config.getOrCreateDeviceId();
    expect(id).toMatch(/^dev_[a-f0-9-]+$/);
  });

  it('returns the same ID on subsequent calls', () => {
    const id1 = config.getOrCreateDeviceId();
    const id2 = config.getOrCreateDeviceId();
    expect(id1).toBe(id2);
  });

  it('persists the ID to a file', () => {
    const id = config.getOrCreateDeviceId();
    const filePath = join(tempHome, '.kraki', 'device-id');
    expect(existsSync(filePath)).toBe(true);
    const fileContent = readFileSync(filePath, 'utf8').trim();
    expect(fileContent).toBe(id);
  });

  it('reads existing device ID from file', () => {
    const dir = join(tempHome, '.kraki');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'device-id'), 'dev_custom123', 'utf8');
    expect(config.getOrCreateDeviceId()).toBe('dev_custom123');
  });
});
