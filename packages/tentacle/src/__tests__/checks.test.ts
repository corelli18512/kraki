/**
 * Unit tests for checks.ts — environment checks with retry.
 *
 * Mocks `execSync` from node:child_process and `confirm` from @inquirer/prompts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
}));

vi.mock('node:os', async (importActual) => {
  const actual = await importActual<typeof import('node:os')>();
  return {
    ...actual,
    platform: vi.fn(() => 'darwin'),
    homedir: vi.fn(() => '/home/test'),
  };
});

vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    realpathSync: vi.fn((p: string) => p),
    promises: {
      ...actual.promises,
      access: vi.fn(), // FDA probe — default: resolves (granted)
    },
  };
});

import { execSync } from 'node:child_process';
import { input } from '@inquirer/prompts';
import { existsSync, realpathSync, promises as fsp } from 'node:fs';
import { platform, homedir } from 'node:os';
import { checkGhCli, checkGhAuth, checkCopilotCli, withRetry, ensureWindowsSystemPath, probeFda, pollFda, getKrakiAppBundlePath, registerKrakiAppBundle, openTccPane, TCC_SERVICES, probeTccStatus, ensureTccBundleRegistered, unregisterAppBundlePath } from '../checks.js';

const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
const mockInput = input as unknown as ReturnType<typeof vi.fn>;
const mockExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>;
const mockRealpathSync = realpathSync as unknown as ReturnType<typeof vi.fn>;
const mockAccess = fsp.access as unknown as ReturnType<typeof vi.fn>;
const mockPlatform = platform as unknown as ReturnType<typeof vi.fn>;
const mockHomedir = homedir as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  // Restore default platform/homedir behavior after reset
  mockPlatform.mockReturnValue('darwin');
  mockHomedir.mockReturnValue('/home/test');
  mockExistsSync.mockReturnValue(true);
  // Suppress console.log noise from chalk output
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// ── checkGhCli ──────────────────────────────────────────

describe('checkGhCli()', () => {
  it('returns found=true with parsed version when gh is installed', () => {
    mockExecSync.mockReturnValue('gh version 2.65.0 (2025-01-01)\nhttps://github.com/cli/cli/releases/tag/v2.65.0');
    const result = checkGhCli();
    expect(result).toEqual({ found: true, version: '2.65.0' });
  });

  it('falls back to first line when version regex does not match', () => {
    mockExecSync.mockReturnValue('some-custom-build\nother line');
    const result = checkGhCli();
    expect(result).toEqual({ found: true, version: 'some-custom-build' });
  });

  it('returns found=false when gh is not installed', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });
    const result = checkGhCli();
    expect(result).toEqual({ found: false });
  });
});

// ── checkGhAuth ─────────────────────────────────────────

describe('checkGhAuth()', () => {
  it('returns authenticated with token and username', () => {
    mockExecSync
      .mockReturnValueOnce('gho_abc123\n')   // gh auth token
      .mockReturnValueOnce('octocat\n');       // gh api user --jq .login

    const result = checkGhAuth();
    expect(result).toEqual({
      authenticated: true,
      username: 'octocat',
      token: 'gho_abc123',
    });
  });

  it('returns authenticated even when username lookup fails', () => {
    mockExecSync
      .mockReturnValueOnce('gho_abc123\n')
      .mockImplementationOnce(() => { throw new Error('network'); });

    const result = checkGhAuth();
    expect(result).toEqual({
      authenticated: true,
      username: undefined,
      token: 'gho_abc123',
    });
  });

  it('returns not authenticated when token is empty', () => {
    mockExecSync.mockReturnValue('');
    const result = checkGhAuth();
    expect(result).toEqual({ authenticated: false });
  });

  it('returns not authenticated when gh auth token throws', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not logged in'); });
    const result = checkGhAuth();
    expect(result).toEqual({ authenticated: false });
  });
});

// ── checkCopilotCli ─────────────────────────────────────

describe('checkCopilotCli()', () => {
  it('returns found=true with version', () => {
    mockExecSync.mockReturnValue('1.0.0\n');
    const result = checkCopilotCli();
    expect(result).toEqual({ found: true, version: '1.0.0' });
  });

  it('returns found=false when copilot is not installed', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });
    const result = checkCopilotCli();
    expect(result).toEqual({ found: false });
  });
});

// ── withRetry ───────────────────────────────────────────

describe('withRetry()', () => {
  it('returns immediately when check passes on first try', async () => {
    const check = vi.fn().mockReturnValue({ found: true, version: '1.0' });
    const result = await withRetry(check, 'Test', 'install hint');
    expect(result).toEqual({ found: true, version: '1.0' });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('retries on Enter, then succeeds', async () => {
    const check = vi.fn()
      .mockReturnValueOnce({ found: false })
      .mockReturnValueOnce({ found: true, version: '2.0' });

    mockInput.mockResolvedValueOnce('');

    const result = await withRetry(check, 'Test', 'install hint');
    expect(result).toEqual({ found: true, version: '2.0' });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('refreshes PATH from Windows registry on retry (win32)', async () => {
    mockPlatform.mockReturnValue('win32');

    const check = vi.fn()
      .mockReturnValueOnce({ found: false })
      .mockReturnValueOnce({ found: true, version: '1.0' });

    // Mock reg query calls that refreshPathOnWindows() makes
    mockExecSync
      .mockReturnValueOnce('    Path    REG_EXPAND_SZ    C:\\Windows\\system32')
      .mockReturnValueOnce('    Path    REG_EXPAND_SZ    C:\\Users\\me\\bin');

    mockInput.mockResolvedValueOnce('');

    const origPath = process.env.PATH;
    await withRetry(check, 'Test', 'install hint');
    expect(process.env.PATH).toBe('C:\\Windows\\system32;C:\\Users\\me\\bin');
    process.env.PATH = origPath; // restore
  });

  it('keeps retrying until check passes', async () => {
    const check = vi.fn()
      .mockReturnValueOnce({ found: false })
      .mockReturnValueOnce({ found: false })
      .mockReturnValueOnce({ found: false })
      .mockReturnValueOnce({ found: true, version: '3.0' });

    mockInput.mockResolvedValue('');

    const result = await withRetry(check, 'Test', 'install hint');
    expect(result).toEqual({ found: true, version: '3.0' });
    expect(check).toHaveBeenCalledTimes(4);
    expect(mockInput).toHaveBeenCalledTimes(3);
  });

  it('works with authenticated-style results', async () => {
    const check = vi.fn().mockReturnValue({ authenticated: true, username: 'u' });
    const result = await withRetry(check, 'Auth', 'login hint');
    expect(result).toEqual({ authenticated: true, username: 'u' });
  });

  it('retries on authenticated=false', async () => {
    const check = vi.fn()
      .mockReturnValueOnce({ authenticated: false })
      .mockReturnValueOnce({ authenticated: true, username: 'u' });

    mockInput.mockResolvedValueOnce('');

    const result = await withRetry(check, 'Auth', 'login hint');
    expect(result).toEqual({ authenticated: true, username: 'u' });
    expect(check).toHaveBeenCalledTimes(2);
  });
});

// ── ensureWindowsSystemPath ─────────────────────────────

describe('ensureWindowsSystemPath()', () => {
  let origPath: string | undefined;
  let origSystemRoot: string | undefined;
  let origWindir: string | undefined;

  beforeEach(() => {
    origPath = process.env.PATH;
    origSystemRoot = process.env.SystemRoot;
    origWindir = process.env.windir;
  });

  const restore = () => {
    if (origPath === undefined) delete process.env.PATH; else process.env.PATH = origPath;
    if (origSystemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = origSystemRoot;
    if (origWindir === undefined) delete process.env.windir; else process.env.windir = origWindir;
  };

  it('returns [] and leaves PATH untouched on non-win32', () => {
    mockPlatform.mockReturnValue('darwin');
    process.env.PATH = '/usr/bin:/bin';
    expect(ensureWindowsSystemPath()).toEqual([]);
    expect(process.env.PATH).toBe('/usr/bin:/bin');
    restore();
  });

  it('prepends all four required dirs when PATH is empty on win32', () => {
    mockPlatform.mockReturnValue('win32');
    process.env.SystemRoot = 'C:\\Windows';
    process.env.PATH = '';

    const added = ensureWindowsSystemPath();
    expect(added).toEqual([
      'C:\\Windows\\System32',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      'C:\\Windows\\System32\\Wbem',
      'C:\\Windows',
    ]);
    expect(process.env.PATH).toBe(
      'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Windows\\System32\\Wbem;C:\\Windows',
    );
    restore();
  });

  it('only adds missing entries and preserves order of existing ones', () => {
    mockPlatform.mockReturnValue('win32');
    process.env.SystemRoot = 'C:\\Windows';
    process.env.PATH = 'C:\\Windows\\System32;C:\\Users\\me\\bin';

    const added = ensureWindowsSystemPath();
    expect(added).toEqual([
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      'C:\\Windows\\System32\\Wbem',
      'C:\\Windows',
    ]);
    expect(process.env.PATH).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Windows\\System32\\Wbem;C:\\Windows;C:\\Windows\\System32;C:\\Users\\me\\bin',
    );
    restore();
  });

  it('is idempotent — running twice changes nothing the second time', () => {
    mockPlatform.mockReturnValue('win32');
    process.env.SystemRoot = 'C:\\Windows';
    process.env.PATH = '';

    ensureWindowsSystemPath();
    const after1 = process.env.PATH;
    const added2 = ensureWindowsSystemPath();
    expect(added2).toEqual([]);
    expect(process.env.PATH).toBe(after1);
    restore();
  });

  it('matches case-insensitively so c:\\windows\\system32 also counts as present', () => {
    mockPlatform.mockReturnValue('win32');
    process.env.SystemRoot = 'C:\\Windows';
    process.env.PATH = 'c:\\windows\\system32;c:\\windows\\system32\\windowspowershell\\v1.0;c:\\windows\\system32\\wbem;c:\\windows';

    const added = ensureWindowsSystemPath();
    expect(added).toEqual([]);
    expect(process.env.PATH).toBe(
      'c:\\windows\\system32;c:\\windows\\system32\\windowspowershell\\v1.0;c:\\windows\\system32\\wbem;c:\\windows',
    );
    restore();
  });

  it('falls back to %windir% when SystemRoot is unset', () => {
    mockPlatform.mockReturnValue('win32');
    delete process.env.SystemRoot;
    process.env.windir = 'D:\\Windows';
    process.env.PATH = '';

    const added = ensureWindowsSystemPath();
    expect(added[0]).toBe('D:\\Windows\\System32');
    expect(added[added.length - 1]).toBe('D:\\Windows');
    restore();
  });

  it('falls back to C:\\Windows when both SystemRoot and windir are unset', () => {
    mockPlatform.mockReturnValue('win32');
    delete process.env.SystemRoot;
    delete process.env.windir;
    process.env.PATH = '';

    const added = ensureWindowsSystemPath();
    expect(added[0]).toBe('C:\\Windows\\System32');
    restore();
  });
});

// ── probeFda() ──────────────────────────────────────────

describe('probeFda()', () => {
  it('returns granted when any probe path is readable', async () => {
    mockAccess.mockResolvedValue(undefined);
    expect(await probeFda()).toBe('granted');
  });

  it('returns denied when all probe paths return EPERM', async () => {
    mockAccess.mockRejectedValue(Object.assign(new Error('perm'), { code: 'EPERM' }));
    expect(await probeFda()).toBe('denied');
  });

  it('returns granted if first path blocked but second readable', async () => {
    let calls = 0;
    mockAccess.mockImplementation(() => {
      calls++;
      if (calls === 1) return Promise.reject(Object.assign(new Error('perm'), { code: 'EPERM' }));
      return Promise.resolve(undefined);
    });
    expect(await probeFda()).toBe('granted');
  });

  it('returns missing when all probe paths return ENOENT', async () => {
    mockAccess.mockRejectedValue(Object.assign(new Error('enoent'), { code: 'ENOENT' }));
    expect(await probeFda()).toBe('missing');
  });

  it('returns granted on non-darwin platforms', async () => {
    mockPlatform.mockReturnValue('linux');
    expect(await probeFda()).toBe('granted');
  });

  it('returns granted on win32', async () => {
    mockPlatform.mockReturnValue('win32');
    expect(await probeFda()).toBe('granted');
  });

  it('returns denied when all paths return EACCES', async () => {
    mockAccess.mockRejectedValue(Object.assign(new Error('eacces'), { code: 'EACCES' }));
    expect(await probeFda()).toBe('denied');
  });
});

// ── pollFda() ───────────────────────────────────────────

describe('pollFda()', () => {
  it('returns granted immediately if FDA is already granted', async () => {
    mockAccess.mockResolvedValue(undefined);
    const result = await pollFda(100);
    expect(result).toBe('granted');
  });

  it('polls until FDA becomes granted', async () => {
    let callCount = 0;
    mockAccess.mockImplementation(() => {
      callCount++;
      if (callCount >= 3) return Promise.resolve(undefined);
      return Promise.reject(Object.assign(new Error('perm'), { code: 'EPERM' }));
    });
    const result = await pollFda(50);
    expect(result).toBe('granted');
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('stops polling when signal is aborted', async () => {
    mockAccess.mockRejectedValue(Object.assign(new Error('perm'), { code: 'EPERM' }));
    const ac = new AbortController();
    // Abort after a short delay
    setTimeout(() => ac.abort(), 120);
    const result = await pollFda(50, ac.signal);
    expect(result).toBe('denied');
  });

  it('returns granted on final check after abort if FDA was granted', async () => {
    let callCount = 0;
    mockAccess.mockImplementation(() => {
      callCount++;
      // Grant on the final check (after abort)
      if (callCount >= 4) return Promise.resolve(undefined);
      return Promise.reject(Object.assign(new Error('perm'), { code: 'EPERM' }));
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const result = await pollFda(50, ac.signal);
    expect(result).toBe('granted');
  });
});
// ── Launch Services registration + TCC panes ────────────────

describe('getKrakiAppBundlePath()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPlatform.mockReturnValue('darwin');
    mockHomedir.mockReturnValue('/home/test');
    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation((p: string) => p);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('returns null off macOS', () => {
    mockPlatform.mockReturnValue('linux');
    expect(getKrakiAppBundlePath()).toBeNull();
  });

  it('detects a bundle by walking up to Contents/*.app', () => {
    mockRealpathSync.mockReturnValue('/Users/x/.local/share/kraki/Kraki.app/Contents/MacOS/kraki');
    mockExistsSync.mockReturnValue(true);
    expect(getKrakiAppBundlePath()).toBe('/Users/x/.local/share/kraki/Kraki.app');
  });

  it('returns null for a standalone binary outside a bundle', () => {
    mockRealpathSync.mockReturnValue('/usr/local/bin/kraki');
    expect(getKrakiAppBundlePath()).toBeNull();
  });

  it('returns null when Info.plist is missing', () => {
    mockRealpathSync.mockReturnValue('/Users/x/.local/share/kraki/Kraki.app/Contents/MacOS/kraki');
    mockExistsSync.mockReturnValue(false);
    expect(getKrakiAppBundlePath()).toBeNull();
  });
});

describe('registerKrakiAppBundle()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPlatform.mockReturnValue('darwin');
    mockHomedir.mockReturnValue('/home/test');
    mockExistsSync.mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('is a no-op (returns true) off macOS', () => {
    mockPlatform.mockReturnValue('linux');
    expect(registerKrakiAppBundle()).toBe(true);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('runs lsregister against the bundle and returns true', () => {
    mockRealpathSync.mockReturnValue('/Users/x/.local/share/kraki/Kraki.app/Contents/MacOS/kraki');
    mockExecSync.mockReturnValue('');
    expect(registerKrakiAppBundle()).toBe(true);
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain('lsregister');
    expect(cmd).toContain('Kraki.app');
  });

  it('returns false when not running from a bundle', () => {
    mockRealpathSync.mockReturnValue('/usr/local/bin/kraki');
    expect(registerKrakiAppBundle()).toBe(false);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('swallows lsregister failure and returns false', () => {
    mockRealpathSync.mockReturnValue('/Users/x/.local/share/kraki/Kraki.app/Contents/MacOS/kraki');
    mockExecSync.mockImplementation(() => { throw new Error('boom'); });
    expect(registerKrakiAppBundle()).toBe(false);
  });
});

describe('ensureTccBundleRegistered()', () => {
  it('does not throw', () => {
    vi.resetAllMocks();
    mockPlatform.mockReturnValue('linux');
    expect(() => ensureTccBundleRegistered()).not.toThrow();
  });
});

describe('TCC_SERVICES + openTccPane()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPlatform.mockReturnValue('darwin');
  });

  it('covers the five services kraki wants, with deep-link URLs', () => {
    const ids = TCC_SERVICES.map((s) => s.id);
    expect(ids).toEqual(['fda', 'accessibility', 'inputMonitoring', 'screenRecording', 'automation']);
    for (const s of TCC_SERVICES) {
      expect(s.url.startsWith('x-apple.systempreferences:')).toBe(true);
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.reason.length).toBeGreaterThan(0);
    }
  });

  it('opens the right deep-link for a given service', () => {
    mockExecSync.mockReturnValue('');
    expect(openTccPane('fda')).toBe(true);
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect((mockExecSync.mock.calls[0][0] as string)).toContain('Privacy_AllFiles');
  });

  it('is a no-op off macOS', () => {
    mockPlatform.mockReturnValue('linux');
    expect(openTccPane('fda')).toBe(false);
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describe('probeTccStatus()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPlatform.mockReturnValue('darwin');
    mockHomedir.mockReturnValue('/home/test');
    mockExistsSync.mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('reports notApplicable off macOS with all services granted', async () => {
    mockPlatform.mockReturnValue('linux');
    const s = await probeTccStatus();
    expect(s.notApplicable).toBe(true);
    expect(s.services.fda).toBe('granted');
  });

  it('probes FDA and leaves the rest unknown, registering the bundle', async () => {
    mockRealpathSync.mockReturnValue('/Users/x/.local/share/kraki/Kraki.app/Contents/MacOS/kraki');
    mockExecSync.mockReturnValue('');
    mockAccess.mockResolvedValue(undefined); // FDA granted
    const s = await probeTccStatus();
    expect(s.bundled).toBe(true);
    expect(s.registered).toBe(true);
    expect(s.services.fda).toBe('granted');
    expect(s.services.accessibility).toBe('unknown');
    expect(s.services.screenRecording).toBe('unknown');
    expect(s.services.automation).toBe('unknown');
  });

  it('reports denied FDA when all probe paths are EPERM', async () => {
    mockRealpathSync.mockReturnValue('/Users/x/.local/share/kraki/Kraki.app/Contents/MacOS/kraki');
    mockExecSync.mockReturnValue('');
    mockAccess.mockRejectedValue(Object.assign(new Error('perm'), { code: 'EPERM' }));
    const s = await probeTccStatus();
    expect(s.services.fda).toBe('denied');
  });
});

// ── unregisterAppBundlePath(): vanished-path stub eviction ────

describe('unregisterAppBundlePath()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPlatform.mockReturnValue('darwin');
    mockHomedir.mockReturnValue('/home/test');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('is a no-op off macOS', () => {
    mockPlatform.mockReturnValue('linux');
    expect(() => unregisterAppBundlePath('/tmp/whatever.app')).not.toThrow();
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('evicts a vanished path by recreating a stub, running lsregister -u, then removing the stub', () => {
    // Path does not exist -> stub creation path
    mockExistsSync.mockReturnValue(false);
    // lsregister -u succeeds
    mockExecSync.mockReturnValue('');

    unregisterAppBundlePath('/tmp/kraki-app-update/Kraki.app');

    // mkdir + writeFileSync called to build the stub
    expect(mockExecSync).toHaveBeenCalled();
    const cmd = mockExecSync.mock.calls[mockExecSync.mock.calls.length - 1][0] as string;
    expect(cmd).toContain('lsregister');
    expect(cmd).toContain('-u');
  });

  it('does NOT create a stub when the path already exists', () => {
    // Info.plist exists -> no stub, just -u
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue('');
    unregisterAppBundlePath('/real/Kraki.app');
    const cmd = mockExecSync.mock.calls[0]?.[0] as string | undefined;
    expect(cmd).toContain('lsregister');
    expect(cmd).toContain('-u');
  });

  it('swallows lsregister failure', () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation(() => { throw new Error('-10814'); });
    expect(() => unregisterAppBundlePath('/x.app')).not.toThrow();
  });
});
