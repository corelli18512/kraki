/**
 * Unit tests for checks.ts — environment checks with retry.
 *
 * Mocks `execSync` from node:child_process and `confirm` from @inquirer/prompts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
    // Default: simulate successful find (App Data granted)
    setTimeout(() => cb(null), 0);
    const { EventEmitter } = require('node:events');
    return new EventEmitter();
  }),
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
    promises: {
      ...actual.promises,
      readdir: vi.fn(),
    },
  };
});

vi.mock('node:net', () => ({
  createConnection: vi.fn(() => {
    const { EventEmitter } = require('node:events');
    const socket = new EventEmitter();
    socket.destroy = vi.fn();
    // Simulate successful connection attempt (ECONNREFUSED = network allowed)
    setTimeout(() => socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })), 0);
    return socket;
  }),
}));

import { execSync, execFile } from 'node:child_process';
import { input } from '@inquirer/prompts';
import { existsSync, promises as fsp } from 'node:fs';
import { createConnection } from 'node:net';
import { platform, homedir } from 'node:os';
import { checkGhCli, checkGhAuth, checkCopilotCli, withRetry, warmupTccPermissions, ensureWindowsSystemPath } from '../checks.js';

const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
const mockInput = input as unknown as ReturnType<typeof vi.fn>;
const mockExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>;
const mockReaddir = fsp.readdir as unknown as ReturnType<typeof vi.fn>;
const mockPlatform = platform as unknown as ReturnType<typeof vi.fn>;
const mockHomedir = homedir as unknown as ReturnType<typeof vi.fn>;
const mockCreateConnection = createConnection as unknown as ReturnType<typeof vi.fn>;

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

// ── warmupTccPermissions ────────────────────────────────

describe('warmupTccPermissions()', () => {
  it('returns [] on non-darwin platforms', async () => {
    mockPlatform.mockReturnValue('linux');
    const result = await warmupTccPermissions();
    expect(result).toEqual([]);
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it('returns [] on win32', async () => {
    mockPlatform.mockReturnValue('win32');
    const result = await warmupTccPermissions();
    expect(result).toEqual([]);
  });

  it('probes all 7 protected folders plus App Data and Local Network on darwin', async () => {
    mockReaddir.mockResolvedValue([]);
    const result = await warmupTccPermissions();
    expect(result).toHaveLength(9);
    // 7 folder probes + 1 App Data + 1 network probe
    expect(result.slice(0, 7).every(r => r.status === 'granted')).toBe(true);
    expect(result[7]).toMatchObject({ label: 'App Data', path: '(file provider)', status: 'granted' });
    expect(result[8]).toMatchObject({ label: 'Local Network', path: '(network)', status: 'granted' });
    expect(mockReaddir).toHaveBeenCalledTimes(7);
  });

  it('maps EPERM to denied', async () => {
    const eperm = Object.assign(new Error('eperm'), { code: 'EPERM' });
    mockReaddir.mockRejectedValue(eperm);
    const result = await warmupTccPermissions();
    expect(result.slice(0, 7).every(r => r.status === 'denied')).toBe(true);
  });

  it('maps EACCES to denied', async () => {
    const eacces = Object.assign(new Error('eacces'), { code: 'EACCES' });
    mockReaddir.mockRejectedValue(eacces);
    const result = await warmupTccPermissions();
    expect(result.slice(0, 7).every(r => r.status === 'denied')).toBe(true);
  });

  it('reports missing when folder does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await warmupTccPermissions();
    expect(result.slice(0, 7).every(r => r.status === 'missing')).toBe(true);
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it('treats unknown errno as denied (defensive)', async () => {
    const eio = Object.assign(new Error('io'), { code: 'EIO' });
    mockReaddir.mockRejectedValue(eio);
    const result = await warmupTccPermissions();
    expect(result.slice(0, 7).every(r => r.status === 'denied')).toBe(true);
  });

  it('invokes onStart before each probe and onResult after', async () => {
    mockReaddir.mockResolvedValue([]);
    const starts: string[] = [];
    const results: string[] = [];
    await warmupTccPermissions(
      (label) => { starts.push(label); },
      (r) => { results.push(`${r.label}:${r.status}`); },
    );
    expect(starts).toHaveLength(9);
    expect(results).toHaveLength(9);
    expect(starts[0]).toBe('~/Documents');
    expect(results[0]).toBe('~/Documents:granted');
    expect(starts[7]).toBe('App Data');
    expect(results[7]).toBe('App Data:granted');
    expect(starts[8]).toBe('Local Network');
    expect(results[8]).toBe('Local Network:granted');
  });

  it('uses absolute paths under homedir', async () => {
    mockReaddir.mockResolvedValue([]);
    const result = await warmupTccPermissions();
    expect(result[0].path).toBe('/home/test/Documents');
    // iCloud Drive uses the long Library path
    const icloud = result.find(r => r.label === '~/iCloud Drive');
    expect(icloud?.path).toBe('/home/test/Library/Mobile Documents/com~apple~CloudDocs');
  });

  it('continues probing remaining folders even if one denies', async () => {
    let callCount = 0;
    mockReaddir.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        throw Object.assign(new Error('eperm'), { code: 'EPERM' });
      }
      return [];
    });
    const result = await warmupTccPermissions();
    expect(result).toHaveLength(9);
    expect(result[1].status).toBe('denied');
    expect(result[0].status).toBe('granted');
    expect(result[2].status).toBe('granted');
  });

  it('reports Local Network denied when socket returns EPERM', async () => {
    const { EventEmitter } = require('node:events');
    mockCreateConnection.mockImplementation(() => {
      const socket = new EventEmitter();
      socket.destroy = vi.fn();
      setTimeout(() => socket.emit('error', Object.assign(new Error('perm'), { code: 'EPERM' })), 0);
      return socket;
    });
    mockReaddir.mockResolvedValue([]);
    const result = await warmupTccPermissions();
    const net = result.find(r => r.label === 'Local Network');
    expect(net).toMatchObject({ label: 'Local Network', status: 'denied' });
  });

  it('reports Local Network granted on ECONNREFUSED (network allowed, host unreachable)', async () => {
    const { EventEmitter } = require('node:events');
    mockCreateConnection.mockImplementation(() => {
      const socket = new EventEmitter();
      socket.destroy = vi.fn();
      setTimeout(() => socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })), 0);
      return socket;
    });
    mockReaddir.mockResolvedValue([]);
    const result = await warmupTccPermissions();
    const net = result.find(r => r.label === 'Local Network');
    expect(net).toMatchObject({ label: 'Local Network', status: 'granted' });
  });

  it('reports App Data granted when find succeeds', async () => {
    mockReaddir.mockResolvedValue([]);
    // Default execFile mock already succeeds
    const result = await warmupTccPermissions();
    const appData = result.find(r => r.label === 'App Data');
    expect(appData).toMatchObject({ label: 'App Data', path: '(file provider)', status: 'granted' });
  });

  it('reports App Data denied when find returns EPERM', async () => {
    mockReaddir.mockResolvedValue([]);
    const { EventEmitter } = require('node:events');
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      setTimeout(() => cb(Object.assign(new Error('perm'), { code: 'EPERM' })), 0);
      return new EventEmitter();
    });
    const result = await warmupTccPermissions();
    const appData = result.find(r => r.label === 'App Data');
    expect(appData).toMatchObject({ label: 'App Data', status: 'denied' });
  });

  it('reports App Data missing when iCloud Drive folder does not exist', async () => {
    mockReaddir.mockResolvedValue([]);
    // existsSync returns false only for the iCloud Drive path
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('Mobile Documents')) return false;
      return true;
    });
    const result = await warmupTccPermissions();
    const appData = result.find(r => r.label === 'App Data');
    expect(appData).toMatchObject({ label: 'App Data', status: 'missing' });
  });
});
