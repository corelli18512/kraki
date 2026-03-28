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
  confirm: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { confirm } from '@inquirer/prompts';
import { checkGhCli, checkGhAuth, checkCopilotCli, withRetry } from '../checks.js';

const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
const mockConfirm = confirm as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
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
  const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as never);

  beforeEach(() => {
    mockExit.mockClear();
  });

  it('returns immediately when check passes on first try', async () => {
    const check = vi.fn().mockReturnValue({ found: true, version: '1.0' });
    const result = await withRetry(check, 'Test', 'install hint');
    expect(result).toEqual({ found: true, version: '1.0' });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('retries when user confirms, then succeeds', async () => {
    const check = vi.fn()
      .mockReturnValueOnce({ found: false })
      .mockReturnValueOnce({ found: true, version: '2.0' });

    mockConfirm.mockResolvedValueOnce(true);

    const result = await withRetry(check, 'Test', 'install hint');
    expect(result).toEqual({ found: true, version: '2.0' });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('exits when user declines retry', async () => {
    const check = vi.fn().mockReturnValue({ found: false });
    mockConfirm.mockResolvedValueOnce(false);

    await expect(withRetry(check, 'Test', 'install hint'))
      .rejects.toThrow(/process\.exit/);
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits after 2 failures without asking again', async () => {
    const check = vi.fn().mockReturnValue({ found: false });
    mockConfirm.mockResolvedValueOnce(true); // retry after first failure

    await expect(withRetry(check, 'Test', 'install hint'))
      .rejects.toThrow(/process\.exit/);
    expect(check).toHaveBeenCalledTimes(2);
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('works with authenticated-style results', async () => {
    const check = vi.fn().mockReturnValue({ authenticated: true, username: 'u' });
    const result = await withRetry(check, 'Auth', 'login hint');
    expect(result).toEqual({ authenticated: true, username: 'u' });
  });

  it('treats authenticated=false as failure', async () => {
    const check = vi.fn().mockReturnValue({ authenticated: false });
    mockConfirm.mockResolvedValueOnce(false);

    await expect(withRetry(check, 'Auth', 'login hint'))
      .rejects.toThrow(/process\.exit/);
  });
});
