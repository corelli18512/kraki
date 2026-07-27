/**
 * Unit tests for daemon.ts — daemon start/stop/status.
 *
 * Mocks child_process.spawn and config functions so no real
 * processes are spawned and no files are written to the real Kraki home.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';

// ── Mocks ───────────────────────────────────────────────

const mockSpawn = vi.fn();
const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

const mockSaveDaemonPid = vi.fn();
const mockLoadDaemonPid = vi.fn();
const mockClearDaemonPid = vi.fn();
const mockMkdirSync = vi.fn();
const mockOpenSync = vi.fn();
const mockCloseSync = vi.fn();
const mockExistsSync = vi.fn(() => false);
const mockUnlinkSync = vi.fn();
const mockWriteFileSync = vi.fn();

vi.mock('node:fs', () => ({
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  openSync: (...args: unknown[]) => mockOpenSync(...args),
  closeSync: (...args: unknown[]) => mockCloseSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/tmp/fake-home'),
}));

// Force isSea() → false so startDaemon tests use the spawn path (not launchctl)
vi.mock('node:sea', () => ({
  isSea: vi.fn(() => false),
}));

vi.mock('../config.js', () => ({
  getKrakiHome: vi.fn(() => '/tmp/fake-home/.kraki'),
  getLogsDir: vi.fn(() => '/tmp/fake-kraki/logs'),
  getLogVerbosity: vi.fn((config: Record<string, unknown> | null) => (config?.logging as Record<string, unknown> | undefined)?.verbosity ?? 'normal'),
  saveDaemonPid: (...args: unknown[]) => mockSaveDaemonPid(...args),
  loadDaemonPid: (...args: unknown[]) => mockLoadDaemonPid(...args),
  clearDaemonPid: (...args: unknown[]) => mockClearDaemonPid(...args),
}));

import {
  isDaemonRunning,
  getDaemonStatus,
  startDaemon,
  stopDaemon,
  resolveDaemonLaunch,
  getDaemonBootstrapLogPath,
} from '../daemon.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  mockLoadDaemonPid.mockReturnValue(null);
  mockOpenSync.mockReturnValue(99);
  mockExecFileSync.mockReturnValue('/path/to/kraki __daemon-worker');
});

afterEach(() => {
  vi.useRealTimers();
});

function makeFakeChild(pid = 42) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const child = {
    pid,
    unref: vi.fn(),
    once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners.set(event, cb);
      return child;
    }),
    off: vi.fn(() => child),
  };
  return { child, listeners };
}

// ── isDaemonRunning ─────────────────────────────────────

describe('isDaemonRunning()', () => {
  it('returns false when no PID file exists', () => {
    mockLoadDaemonPid.mockReturnValue(null);
    expect(isDaemonRunning()).toBe(false);
  });

  it('returns true when PID file exists and process is alive', () => {
    mockLoadDaemonPid.mockReturnValue(process.pid); // current process is definitely alive
    expect(isDaemonRunning()).toBe(true);
  });

  it('returns false and clears stale PID when process is dead', () => {
    mockLoadDaemonPid.mockReturnValue(999999999); // almost certainly not a real PID
    expect(isDaemonRunning()).toBe(false);
    expect(mockClearDaemonPid).toHaveBeenCalled();
  });
});

// ── getDaemonStatus ─────────────────────────────────────

describe('getDaemonStatus()', () => {
  it('returns running=false and pid=null when no PID file', () => {
    mockLoadDaemonPid.mockReturnValue(null);
    expect(getDaemonStatus()).toEqual({ running: false, pid: null });
  });

  it('returns running=true with pid when process is alive', () => {
    mockLoadDaemonPid.mockReturnValue(process.pid);
    expect(getDaemonStatus()).toEqual({ running: true, pid: process.pid });
  });

  it('returns running=false and clears stale PID', () => {
    mockLoadDaemonPid.mockReturnValue(999999999);
    const status = getDaemonStatus();
    expect(status).toEqual({ running: false, pid: null });
    expect(mockClearDaemonPid).toHaveBeenCalled();
  });
});

// ── startDaemon ─────────────────────────────────────────

describe('startDaemon()', () => {
  const sourceCliPath = resolve('/tmp/repo/packages/tentacle/src/cli.ts');
  const sourceWorkspaceRoot = resolve('/tmp/repo');
  const publishedCliPath = resolve('/tmp/npx/node_modules/kraki/dist/cli.js');
  const publishedPackageRoot = resolve('/tmp/npx/node_modules/kraki');
  const fakeConfig = {
    relay: 'wss://relay.test',
    authMethod: 'github' as const,
    device: { name: 'test' },
    logging: { verbosity: 'normal' as const },
  };

  it('resolves source launch paths from the workspace root', () => {
    const launch = resolveDaemonLaunch(sourceCliPath, false);

    expect(launch.runtime).toBe(process.execPath);
    expect(launch.args).toEqual([
      '--import',
      'tsx',
      sourceCliPath,
      '__daemon-worker',
    ]);
    expect(launch.cwd).toBe(sourceWorkspaceRoot);
    expect(launch.env.NODE_ENV).toBe('production');
    expect(launch.env.PATH).toContain(resolve('/tmp/repo/node_modules/.bin'));
  });

  it('resolves published launch paths from the installed package root', () => {
    const launch = resolveDaemonLaunch(publishedCliPath, false);

    expect(launch.args).toEqual([publishedCliPath, '__daemon-worker']);
    expect(launch.cwd).toBe(publishedPackageRoot);
    expect(launch.env.PATH).toContain(resolve('/tmp/npx/node_modules/kraki/node_modules/.bin'));
  });

  it('resolves SEA launch paths to the current executable', () => {
    const launch = resolveDaemonLaunch('/tmp/kraki', true);

    expect(launch.runtime).toBe(process.execPath);
    expect(launch.args).toEqual(['__daemon-worker']);
    expect(launch.cwd).toBe(process.cwd());
    expect(launch.workerPath).toBe(process.execPath);
  });

  it('waits for bootstrap before saving the PID', async () => {
    vi.useFakeTimers();
    const { child } = makeFakeChild(42);
    mockSpawn.mockReturnValue(child);

    const startPromise = startDaemon(fakeConfig);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockSpawn.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(args).toContain('__daemon-worker');
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(['ignore', 99, 99]);
    expect(opts.env.NODE_ENV).toBe('production');
    expect(opts.env.LOG_LEVEL).toBe('info');
    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockOpenSync).toHaveBeenCalledWith(getDaemonBootstrapLogPath(), 'w');
    expect(mockCloseSync).toHaveBeenCalledWith(99);
    expect(mockSaveDaemonPid).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);

    await expect(startPromise).resolves.toBe(42);
    expect(mockSaveDaemonPid).toHaveBeenCalledWith(42);
    expect(child.unref).toHaveBeenCalled();
  });

  it('uses debug LOG_LEVEL when verbose logging is configured', async () => {
    vi.useFakeTimers();
    const { child } = makeFakeChild(55);
    mockSpawn.mockReturnValue(child);

    const startPromise = startDaemon({
      ...fakeConfig,
      logging: { verbosity: 'verbose' },
    });

    const [, , opts] = mockSpawn.mock.calls[0];
    expect(opts.env.LOG_LEVEL).toBe('debug');

    await vi.advanceTimersByTimeAsync(1500);
    await expect(startPromise).resolves.toBe(55);
  });

  it('fails fast when the child exits during bootstrap', async () => {
    vi.useFakeTimers();
    const { child, listeners } = makeFakeChild(100);
    mockSpawn.mockReturnValue(child);

    const startPromise = startDaemon(fakeConfig);
    listeners.get('exit')?.(1, null);

    await expect(startPromise).rejects.toThrow(getDaemonBootstrapLogPath());
    expect(mockSaveDaemonPid).not.toHaveBeenCalled();
    expect(child.unref).not.toHaveBeenCalled();
  });
});

// ── stopDaemon ──────────────────────────────────────────

describe('stopDaemon()', () => {
  it('returns false when no daemon is running (no PID file)', () => {
    mockLoadDaemonPid.mockReturnValue(null);
    expect(stopDaemon()).toBe(false);
  });

  it('does not signal a reused PID that belongs to another process', () => {
    mockLoadDaemonPid.mockReturnValue(12345);
    mockExecFileSync.mockReturnValue('/Applications/Safari.app/Contents/MacOS/Safari');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(stopDaemon()).toBe(true);

    expect(killSpy).toHaveBeenCalledWith(12345, 0);
    expect(killSpy).not.toHaveBeenCalledWith(12345, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(12345, 'SIGKILL');
    expect(mockClearDaemonPid).toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('fails closed when a live PID cannot be inspected', () => {
    mockLoadDaemonPid.mockReturnValue(12345);
    mockExecFileSync.mockImplementation(() => { throw new Error('EPERM'); });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(stopDaemon()).toBe(false);

    expect(killSpy).toHaveBeenCalledWith(12345, 0);
    expect(killSpy).not.toHaveBeenCalledWith(12345, 'SIGTERM');
    expect(mockClearDaemonPid).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('sends SIGTERM, clears PID, and returns true', () => {
    // Model a daemon that honours SIGTERM: the signal lands, and the
    // liveness probe (signal 0) then reports it gone.
    let terminated = false;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((_pid: number, sig?: string | number) => {
      if (sig === 'SIGTERM') { terminated = true; return true; }
      if (sig === 0 && terminated) throw new Error('ESRCH');
      return true;
    }) as typeof process.kill);
    mockLoadDaemonPid.mockReturnValue(12345);

    const result = stopDaemon();

    expect(result).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(12345, 'SIGKILL');
    expect(mockClearDaemonPid).toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('escalates to SIGKILL when the daemon ignores SIGTERM', () => {
    // Unloading the launchd job no longer kills the daemon — the job is `open`
    // and the daemon belongs to LaunchServices — so this escalation is the only
    // backstop left for a hung daemon.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    mockLoadDaemonPid.mockReturnValue(12345);

    const result = stopDaemon();

    expect(result).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL');
    expect(mockClearDaemonPid).toHaveBeenCalled();
    killSpy.mockRestore();
  }, 10_000);

  it('clears PID even if process is already gone', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    mockLoadDaemonPid.mockReturnValue(12345);

    const result = stopDaemon();

    expect(result).toBe(true);
    expect(mockClearDaemonPid).toHaveBeenCalled();
    killSpy.mockRestore();
  });
});
