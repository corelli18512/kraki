/**
 * Unit tests for daemon.ts — daemon start/stop/status.
 *
 * Mocks child_process.spawn and config functions so no real
 * processes are spawned and no files are written to the real Kraki home.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'node:path';

const TEST_UID = 501;
const expectedPlistPath = join('/tmp/fake-home', 'Library', 'LaunchAgents', 'cloud.corelli.kraki.plist');

// ── Mocks ───────────────────────────────────────────────

const mockSpawn = vi.fn();
const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();
const mockIsSea = vi.fn(() => false);
const mockGetKrakiAppBundlePath = vi.fn((): string | null => null);
const mockGetProcessBundleIdentity = vi.fn((): string | null => null);
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

const mockSaveDaemonPid = vi.fn();
const mockLoadDaemonPid = vi.fn();
const mockClearDaemonPid = vi.fn();
const mockSaveDaemonIdentity = vi.fn();
const mockLoadDaemonIdentity = vi.fn();
const mockClearDaemonIdentity = vi.fn();
const mockLoadDaemonReady = vi.fn();
const mockClearDaemonReady = vi.fn();
const mockMkdirSync = vi.fn();
const mockOpenSync = vi.fn();
const mockCloseSync = vi.fn();
const mockExistsSync = vi.fn(() => false);
const mockUnlinkSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockChmodSync = vi.fn();

vi.mock('node:fs', () => ({
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  openSync: (...args: unknown[]) => mockOpenSync(...args),
  closeSync: (...args: unknown[]) => mockCloseSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  chmodSync: (...args: unknown[]) => mockChmodSync(...args),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/tmp/fake-home'),
}));

vi.mock('node:sea', () => ({
  isSea: (...args: unknown[]) => mockIsSea(...args),
}));

vi.mock('../checks.js', () => ({
  getKrakiAppBundlePath: (...args: unknown[]) => mockGetKrakiAppBundlePath(...args),
  getProcessBundleIdentity: (...args: unknown[]) => mockGetProcessBundleIdentity(...args),
  KRAKI_BUNDLE_ID: 'chat.kraki.cli',
}));

vi.mock('../config.js', () => ({
  getKrakiHome: vi.fn(() => '/tmp/fake-home/.kraki'),
  getLogsDir: vi.fn(() => '/tmp/fake-kraki/logs'),
  getLogVerbosity: vi.fn((config: Record<string, unknown> | null) => (config?.logging as Record<string, unknown> | undefined)?.verbosity ?? 'normal'),
  saveDaemonPid: (...args: unknown[]) => mockSaveDaemonPid(...args),
  loadDaemonPid: (...args: unknown[]) => mockLoadDaemonPid(...args),
  clearDaemonPid: (...args: unknown[]) => mockClearDaemonPid(...args),
  saveDaemonIdentity: (...args: unknown[]) => mockSaveDaemonIdentity(...args),
  loadDaemonIdentity: (...args: unknown[]) => mockLoadDaemonIdentity(...args),
  clearDaemonIdentity: (...args: unknown[]) => mockClearDaemonIdentity(...args),
  loadDaemonReady: (...args: unknown[]) => mockLoadDaemonReady(...args),
  clearDaemonReady: (...args: unknown[]) => mockClearDaemonReady(...args),
}));

import {
  assertNoUntrackedLaunchdDaemon,
  isDaemonRunning,
  getDaemonStatus,
  startDaemon,
  startDaemonLaunchctl,
  prepareDaemonWorkerBootstrap,
  stopDaemon,
  inspectDaemonProcess,
  resolveDaemonLaunch,
  DaemonStartupError,
  getDaemonBootstrapLogPath,
} from '../daemon.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  mockLoadDaemonPid.mockReturnValue(null);
  mockOpenSync.mockReturnValue(99);
  mockExecFileSync.mockImplementation((command: string) => {
    if (command === '/bin/launchctl') throw new Error('not loaded');
    return '/path/to/kraki __daemon-worker';
  });
  mockIsSea.mockReturnValue(false);
  mockGetKrakiAppBundlePath.mockReturnValue(null);
  mockGetProcessBundleIdentity.mockReturnValue(null);
  mockLoadDaemonReady.mockReturnValue(null);
  mockLoadDaemonIdentity.mockReturnValue(null);
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

// ── daemon worker bootstrap ─────────────────────────────

describe('prepareDaemonWorkerBootstrap()', () => {
  it('removes the private Launch Services bundle variable before child processes can inherit it', async () => {
    const env: NodeJS.ProcessEnv = {
      __CFBundleIdentifier: 'chat.kraki.cli',
      HOME: '/tmp/home',
    };

    await prepareDaemonWorkerBootstrap(env, 12345, null, mockGetProcessBundleIdentity, 0);

    expect(env.__CFBundleIdentifier).toBeUndefined();
    expect(env.HOME).toBe('/tmp/home');
    expect(mockClearDaemonReady).toHaveBeenCalledOnce();
    expect(mockSaveDaemonPid).toHaveBeenCalledWith(12345);
    expect(mockSaveDaemonIdentity).not.toHaveBeenCalled();
  });

  it('captures a matching initial Launch Services identity before scrubbing the environment', async () => {
    const env: NodeJS.ProcessEnv = { __CFBundleIdentifier: 'chat.kraki.cli' };
    mockGetProcessBundleIdentity.mockReturnValue('chat.kraki.cli');

    await prepareDaemonWorkerBootstrap(env, 23456, '/Applications/Kraki.app', mockGetProcessBundleIdentity, 0);

    expect(mockGetProcessBundleIdentity).toHaveBeenCalledWith(23456);
    expect(mockSaveDaemonIdentity).toHaveBeenCalledWith({ pid: 23456, bundleId: 'chat.kraki.cli' });
    expect(env.__CFBundleIdentifier).toBeUndefined();
  });

  it('does not publish an identity proof when the initial bundle identity is absent', async () => {
    mockGetProcessBundleIdentity.mockReturnValue(null);

    await prepareDaemonWorkerBootstrap({}, 34567, '/Applications/Kraki.app', mockGetProcessBundleIdentity, 0);

    expect(mockSaveDaemonIdentity).not.toHaveBeenCalled();
  });
});

// ── inspectDaemonProcess ─────────────────────────────────

describe('inspectDaemonProcess()', () => {
  it('accepts only a process carrying the daemon-worker marker', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    mockExecFileSync.mockReturnValue('/path/to/kraki __daemon-worker');
    expect(inspectDaemonProcess(12345)).toBe('daemon');
    killSpy.mockRestore();
  });

  it('rejects another kraki CLI process without the worker marker', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    mockExecFileSync.mockReturnValue('/path/to/kraki update');
    expect(inspectDaemonProcess(12345)).toBe('other');
    killSpy.mockRestore();
  });
});

describe('launchd job without a verified worker PID', () => {
  it('fails closed instead of unloading a loaded job', () => {
    mockLoadDaemonPid.mockReturnValue(null);
    mockExecFileSync.mockImplementation((command: string) => {
      if (command === '/bin/launchctl') return '';
      return '/path/to/kraki __daemon-worker';
    });

    expect(stopDaemon('darwin', TEST_UID)).toBe(false);
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('refuses to start a duplicate beside a loaded untracked job', () => {
    mockLoadDaemonPid.mockReturnValue(null);
    mockExecFileSync.mockImplementation((command: string) => {
      if (command === '/bin/launchctl') return '';
      return '/path/to/kraki __daemon-worker';
    });

    expect(() => assertNoUntrackedLaunchdDaemon('darwin', TEST_UID)).toThrow('will not risk starting a duplicate daemon');
  });

  it('allows stale plist cleanup when launchctl confirms no job is loaded', () => {
    mockLoadDaemonPid.mockReturnValue(null);
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation((command: string) => {
      if (command === '/bin/launchctl') throw new Error('not loaded');
      return '/path/to/kraki __daemon-worker';
    });

    expect(stopDaemon('darwin', TEST_UID)).toBe(false);
    expect(mockExecSync).toHaveBeenCalled();
    expect(mockUnlinkSync).toHaveBeenCalled();
  });
});

// ── isDaemonRunning ─────────────────────────────────────

describe('isDaemonRunning()', () => {
  it('treats a loaded launchd job without a PID as running', () => {
    mockLoadDaemonPid.mockReturnValue(null);
    mockExecFileSync.mockImplementation((command: string) => {
      if (command === '/bin/launchctl') return '';
      return '/path/to/kraki __daemon-worker';
    });

    expect(isDaemonRunning('darwin', TEST_UID)).toBe(true);
    expect(getDaemonStatus('darwin', TEST_UID)).toEqual({ running: true, pid: null });
  });

  it('does not discard a stale PID while its launchd job remains loaded', () => {
    mockLoadDaemonPid.mockReturnValue(999999999);
    mockExecFileSync.mockImplementation((command: string) => {
      if (command === '/bin/launchctl') return '';
      return '/path/to/kraki __daemon-worker';
    });

    expect(isDaemonRunning('darwin', TEST_UID)).toBe(true);
    expect(mockClearDaemonPid).not.toHaveBeenCalled();
  });

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
  it('reports a loaded launchd job without a PID as running with unknown PID', () => {
    mockLoadDaemonPid.mockReturnValue(null);
    mockExecFileSync.mockImplementation((command: string) => {
      if (command === '/bin/launchctl') return '';
      return '/path/to/kraki __daemon-worker';
    });

    expect(getDaemonStatus('darwin', TEST_UID)).toEqual({ running: true, pid: null });
  });

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

  it('accepts a matching worker-published identity proof even if live lsappinfo later becomes unstable', async () => {
    vi.useFakeTimers();
    mockGetKrakiAppBundlePath.mockReturnValue('/Applications/Kraki.app');
    mockLoadDaemonReady.mockReturnValue(4142);
    mockLoadDaemonIdentity.mockReturnValue({ pid: 4142, bundleId: 'chat.kraki.cli' });
    mockGetProcessBundleIdentity.mockReturnValue(null);
    mockLoadDaemonPid.mockReturnValue(4142);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const startPromise = startDaemonLaunchctl(fakeConfig, TEST_UID);
    await vi.advanceTimersByTimeAsync(200);

    await expect(startPromise).resolves.toBe(4142);
    // The launcher consumes the proof captured before adapter children started;
    // it must not re-query the mutable Launch Services process table here.
    expect(mockGetProcessBundleIdentity).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('rejects a bundled macOS launch whose PID lacks the required Launch Services identity', async () => {
    vi.useFakeTimers();
    mockIsSea.mockReturnValue(true);
    mockGetKrakiAppBundlePath.mockReturnValue('/Applications/Kraki.app');
    mockGetProcessBundleIdentity.mockReturnValue(null);
    mockLoadDaemonReady.mockReturnValue(4242);
    mockExistsSync.mockReturnValue(true);
    // stopDaemon() sees no previous PID; the duplicate-start guard also sees
    // none; then the new worker writes PID 4242 during the launch poll.
    mockLoadDaemonPid
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValue(4242);
    let terminated = false;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal?: string | number) => {
      if (signal === 'SIGTERM') { terminated = true; return true; }
      if (signal === 0 && terminated) throw new Error('ESRCH');
      return true;
    }) as typeof process.kill);

    const startPromise = startDaemonLaunchctl(fakeConfig, TEST_UID);
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expectedPlistPath,
      expect.any(String),
      { mode: 0o600 },
    );
    const plistArg = mockWriteFileSync.mock.calls
      .find((call: unknown[]) => call[0] === expectedPlistPath)?.[1] as string;
    expect(plistArg).toMatch(/<key>KRAKI_HOME<\/key>\s*<string>\/tmp\/fake-home\/\.kraki<\/string>/);
    expect(mockChmodSync).toHaveBeenCalledWith(
      expectedPlistPath,
      0o600,
    );
    const rejection = expect(startPromise).rejects.toBeInstanceOf(DaemonStartupError);
    await vi.advanceTimersByTimeAsync(35_300);

    await rejection;
    expect(mockLoadDaemonIdentity).toHaveBeenCalled();
    expect(mockGetProcessBundleIdentity).not.toHaveBeenCalled();
    expect(mockUnlinkSync).toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('does not persist a Copilot session-scoped gho_ token in launchd', async () => {
    vi.useFakeTimers();
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'gho_session_only';
    mockGetKrakiAppBundlePath.mockReturnValue('/Applications/Kraki.app');
    mockLoadDaemonPid.mockReturnValue(null);
    mockExecFileSync.mockImplementation((command: string) => {
      if (command === '/bin/launchctl') return '';
      throw new Error('not inspected');
    });

    try {
      const startPromise = startDaemonLaunchctl(fakeConfig, TEST_UID);
      const rejection = expect(startPromise).rejects.toBeInstanceOf(DaemonStartupError);
      await vi.advanceTimersByTimeAsync(30_200);
      await rejection;

      const plistArg = mockWriteFileSync.mock.calls
        .find((call: unknown[]) => call[0] === expectedPlistPath)?.[1] as string;
      expect(plistArg).not.toContain('gho_session_only');
      expect(plistArg).not.toContain('<key>GITHUB_TOKEN</key>');
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });

  it('fails closed without removing supervision when startup identity cannot be inspected', async () => {
    vi.useFakeTimers();
    mockIsSea.mockReturnValue(true);
    mockGetKrakiAppBundlePath.mockReturnValue('/Applications/Kraki.app');
    mockLoadDaemonReady.mockReturnValue(4243);
    mockLoadDaemonPid
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValue(4243);
    mockExecFileSync.mockImplementation((command: string) => {
      if (command === '/bin/launchctl') return '';
      throw new Error('EPERM');
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const startPromise = startDaemonLaunchctl(fakeConfig, TEST_UID);
    const readyClearsBeforeTimeout = mockClearDaemonReady.mock.calls.length;
    const rejection = expect(startPromise).rejects.toBeInstanceOf(DaemonStartupError);
    await vi.advanceTimersByTimeAsync(30_200);

    await rejection;
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(mockClearDaemonPid).not.toHaveBeenCalled();
    expect(mockClearDaemonReady).toHaveBeenCalledTimes(readyClearsBeforeTimeout);
    expect(killSpy).not.toHaveBeenCalledWith(4243, 'SIGTERM');
    killSpy.mockRestore();
  });

  it('preserves a loaded launchd job when startup times out before any PID is available', async () => {
    vi.useFakeTimers();
    mockGetKrakiAppBundlePath.mockReturnValue('/Applications/Kraki.app');
    mockLoadDaemonPid.mockReturnValue(null);
    mockExecFileSync.mockImplementation((command: string) => {
      if (command === '/bin/launchctl') return '';
      throw new Error('unexpected process inspection');
    });

    const startPromise = startDaemonLaunchctl(fakeConfig, TEST_UID);
    const rejection = expect(startPromise).rejects.toBeInstanceOf(DaemonStartupError);
    await vi.advanceTimersByTimeAsync(30_200);

    await rejection;
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(mockClearDaemonPid).not.toHaveBeenCalled();
    expect(mockClearDaemonReady).toHaveBeenCalledTimes(1);
  });

  it('waits for bootstrap before saving the PID', async () => {
    vi.useFakeTimers();
    const { child } = makeFakeChild(42);
    mockSpawn.mockReturnValue(child);
    mockLoadDaemonReady.mockReturnValue(42);

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

    await vi.advanceTimersByTimeAsync(100);

    await expect(startPromise).resolves.toBe(42);
    expect(mockSaveDaemonPid).toHaveBeenCalledWith(42);
    expect(child.unref).toHaveBeenCalled();
  });

  it('uses debug LOG_LEVEL when verbose logging is configured', async () => {
    vi.useFakeTimers();
    const { child } = makeFakeChild(55);
    mockSpawn.mockReturnValue(child);
    mockLoadDaemonReady.mockReturnValue(55);

    const startPromise = startDaemon({
      ...fakeConfig,
      logging: { verbosity: 'verbose' },
    });

    const [, , opts] = mockSpawn.mock.calls[0];
    expect(opts.env.LOG_LEVEL).toBe('debug');

    await vi.advanceTimersByTimeAsync(100);
    await expect(startPromise).resolves.toBe(55);
  });

  it('fails instead of reporting success when a background worker never publishes readiness', async () => {
    vi.useFakeTimers();
    const { child } = makeFakeChild(77);
    mockSpawn.mockReturnValue(child);
    mockLoadDaemonReady.mockReturnValue(null);
    let terminated = false;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal?: string | number) => {
      if (signal === 'SIGTERM') { terminated = true; return true; }
      if (signal === 0 && terminated) throw new Error('ESRCH');
      return true;
    }) as typeof process.kill);

    const startPromise = startDaemon(fakeConfig);
    const rejection = expect(startPromise).rejects.toThrow('did not become ready');
    await vi.advanceTimersByTimeAsync(35_200);

    await rejection;
    expect(child.unref).not.toHaveBeenCalled();
    expect(mockSaveDaemonPid).not.toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(77, 'SIGTERM');
    killSpy.mockRestore();
  });

  it('does not SIGKILL a PID reused after the failed worker exits', async () => {
    vi.useFakeTimers();
    const { child } = makeFakeChild(78);
    mockSpawn.mockReturnValue(child);
    mockLoadDaemonReady.mockReturnValue(null);
    let psInspections = 0;
    mockExecFileSync.mockImplementation((command: string) => {
      if (command === '/bin/launchctl') throw new Error('not loaded');
      psInspections += 1;
      return psInspections === 1
        ? '/path/to/kraki __daemon-worker'
        : '/Applications/Safari.app/Contents/MacOS/Safari';
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const startPromise = startDaemon(fakeConfig);
    const rejection = expect(startPromise).rejects.toThrow('did not become ready');
    await vi.advanceTimersByTimeAsync(30_300);

    await rejection;
    expect(mockSaveDaemonPid).not.toHaveBeenCalled();
    expect(mockClearDaemonPid).toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalledWith(78, 'SIGKILL');
    killSpy.mockRestore();
  });

  it('preserves the PID when failed-worker identity becomes unknown', async () => {
    vi.useFakeTimers();
    const { child } = makeFakeChild(79);
    mockSpawn.mockReturnValue(child);
    mockLoadDaemonReady.mockReturnValue(null);
    let psInspections = 0;
    mockExecFileSync.mockImplementation((command: string) => {
      if (command === '/bin/launchctl') throw new Error('not loaded');
      psInspections += 1;
      if (psInspections === 1) return '/path/to/kraki __daemon-worker';
      throw new Error('EPERM');
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const startPromise = startDaemon(fakeConfig);
    const rejection = expect(startPromise).rejects.toThrow('could not be safely terminated');
    await vi.advanceTimersByTimeAsync(30_300);

    await rejection;
    expect(mockSaveDaemonPid).toHaveBeenCalledWith(79);
    expect(mockClearDaemonPid).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalledWith(79, 'SIGKILL');
    killSpy.mockRestore();
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
    mockExecFileSync.mockImplementation((command: string) => {
      if (command === '/bin/launchctl') throw new Error('not loaded');
      return '/Applications/Safari.app/Contents/MacOS/Safari';
    });
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
    let killed = false;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal?: string | number) => {
      if (signal === 'SIGKILL') { killed = true; return true; }
      if (signal === 0 && killed) throw new Error('ESRCH');
      return true;
    }) as typeof process.kill);
    mockLoadDaemonPid.mockReturnValue(12345);

    const result = stopDaemon();

    expect(result).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL');
    expect(mockClearDaemonPid).toHaveBeenCalled();
    killSpy.mockRestore();
  }, 10_000);

  it('keeps the PID and reports failure when SIGKILL does not terminate the daemon', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    mockLoadDaemonPid.mockReturnValue(12345);

    const result = stopDaemon();

    expect(result).toBe(false);
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL');
    expect(mockClearDaemonPid).not.toHaveBeenCalled();
    killSpy.mockRestore();
  }, 12_000);

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
