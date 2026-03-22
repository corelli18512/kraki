/**
 * Unit tests for daemon.ts — daemon start/stop/status.
 *
 * Mocks child_process.spawn and config functions so no real
 * processes are spawned and no files are written to ~/.kraki.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────

const mockSpawn = vi.fn();
const mockExecSync = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
  execSync: (...args: any[]) => mockExecSync(...args),
}));

const mockSaveDaemonPid = vi.fn();
const mockLoadDaemonPid = vi.fn();
const mockClearDaemonPid = vi.fn();
const mockMkdirSync = vi.fn();
const mockOpenSync = vi.fn();
const mockCloseSync = vi.fn();

vi.mock('node:fs', () => ({
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  openSync: (...args: any[]) => mockOpenSync(...args),
  closeSync: (...args: any[]) => mockCloseSync(...args),
}));

vi.mock('../config.js', () => ({
  getLogVerbosity: vi.fn((config: any) => config?.logging?.verbosity ?? 'normal'),
  saveDaemonPid: (...args: any[]) => mockSaveDaemonPid(...args),
  loadDaemonPid: (...args: any[]) => mockLoadDaemonPid(...args),
  clearDaemonPid: (...args: any[]) => mockClearDaemonPid(...args),
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
  mockExecSync.mockReturnValue('');
  mockOpenSync.mockReturnValue(99);
});

afterEach(() => {
  vi.useRealTimers();
});

function makeFakeChild(pid = 42) {
  const listeners = new Map<string, (...args: any[]) => void>();
  const child = {
    pid,
    unref: vi.fn(),
    once: vi.fn((event: string, cb: (...args: any[]) => void) => {
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
  const fakeConfig = {
    relay: 'wss://relay.test',
    authMethod: 'github' as const,
    device: { name: 'test' },
    logging: { verbosity: 'normal' as const },
  };

  it('resolves source launch paths from the workspace root', () => {
    const launch = resolveDaemonLaunch('file:///tmp/repo/packages/tentacle/src/daemon.ts');

    expect(launch.runtime).toBe(process.execPath);
    expect(launch.args).toEqual([
      '--import',
      'tsx',
      '/tmp/repo/packages/tentacle/src/daemon-worker.ts',
    ]);
    expect(launch.cwd).toBe('/tmp/repo');
    expect(launch.env.NODE_ENV).toBe('production');
    expect(launch.env.PATH).toContain('/tmp/repo/node_modules/.bin');
  });

  it('resolves published launch paths from the installed package root', () => {
    const launch = resolveDaemonLaunch('file:///tmp/npx/node_modules/kraki/dist/daemon.js');

    expect(launch.args).toEqual(['/tmp/npx/node_modules/kraki/dist/daemon-worker.js']);
    expect(launch.cwd).toBe('/tmp/npx/node_modules/kraki');
    expect(launch.env.PATH).toContain('/tmp/npx/node_modules/kraki/node_modules/.bin');
  });

  it('waits for bootstrap before saving the PID', async () => {
    vi.useFakeTimers();
    const { child } = makeFakeChild(42);
    mockSpawn.mockReturnValue(child);

    const startPromise = startDaemon(fakeConfig);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockSpawn.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(args.some((a: string) => /daemon-worker\.(js|ts)$/.test(a))).toBe(true);
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

  it('sends SIGTERM, clears PID, and returns true', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    mockLoadDaemonPid.mockReturnValue(12345);

    const result = stopDaemon();

    expect(result).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
    expect(mockClearDaemonPid).toHaveBeenCalled();
    killSpy.mockRestore();
  });

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
