/**
 * Unit tests for daemon.ts — daemon start/stop/status.
 *
 * Mocks child_process.spawn and config functions so no real
 * processes are spawned and no files are written to ~/.kraki.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────

const mockSpawn = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

const mockSaveDaemonPid = vi.fn();
const mockLoadDaemonPid = vi.fn();
const mockClearDaemonPid = vi.fn();

vi.mock('../config.js', () => ({
  saveDaemonPid: (...args: any[]) => mockSaveDaemonPid(...args),
  loadDaemonPid: (...args: any[]) => mockLoadDaemonPid(...args),
  clearDaemonPid: (...args: any[]) => mockClearDaemonPid(...args),
}));

import { isDaemonRunning, getDaemonStatus, startDaemon, stopDaemon } from '../daemon.js';

beforeEach(() => {
  vi.resetAllMocks();
});

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
  };

  it('spawns a detached node process with the worker script', () => {
    const fakeChild = { unref: vi.fn(), pid: 42 };
    mockSpawn.mockReturnValue(fakeChild);

    const pid = startDaemon(fakeConfig);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockSpawn.mock.calls[0];
    expect(cmd).toBe(process.execPath); // full path to node
    expect(args.some((a: string) => /daemon-worker\.(js|ts)$/.test(a))).toBe(true);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    expect(opts.env.NODE_ENV).toBe('production');
    expect(fakeChild.unref).toHaveBeenCalled();
    expect(pid).toBe(42);
  });

  it('saves the PID after spawning', () => {
    mockSpawn.mockReturnValue({ unref: vi.fn(), pid: 100 });
    startDaemon(fakeConfig);
    expect(mockSaveDaemonPid).toHaveBeenCalledWith(100);
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
