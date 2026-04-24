/**
 * Environment checks for Kraki tentacle setup.
 *
 * Validates that required CLI tools are installed and authenticated.
 * Provides a retry mechanism for interactive setup flows.
 */

import { execSync } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { input } from '@inquirer/prompts';
import chalk from 'chalk';

// ── Check results ───────────────────────────────────────

export interface CliCheckResult {
  found: boolean;
  version?: string;
}

export interface AuthCheckResult {
  authenticated: boolean;
  username?: string;
  token?: string;
}

// ── Individual checks ───────────────────────────────────

export function checkGhCli(): CliCheckResult {
  try {
    const output = execSync('gh --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const match = output.match(/gh version ([\d.]+)/);
    return { found: true, version: match?.[1] ?? output.split('\n')[0] };
  } catch {
    return { found: false };
  }
}

export function checkGhAuth(): AuthCheckResult {
  try {
    const token = execSync('gh auth token', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!token) return { authenticated: false };

    let username: string | undefined;
    try {
      username = execSync('gh api user --jq .login', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || undefined;
    } catch {
      // Token exists but can't fetch username — still consider authenticated
    }

    return { authenticated: true, username, token };
  } catch {
    return { authenticated: false };
  }
}

export function checkCopilotCli(): CliCheckResult {
  try {
    const output = execSync('copilot --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return { found: true, version: output.split('\n')[0] };
  } catch {
    return { found: false };
  }
}

// ── Retry wrapper ───────────────────────────────────────

/**
 * Run a check function with interactive retry.
 * Loops forever until the check passes — the user installs the tool
 * in another terminal and presses Enter to retry.
 */
export async function withRetry<T extends { found?: boolean; authenticated?: boolean }>(
  checkFn: () => T,
  label: string,
  installHint: string,
  spinner?: { stop: () => void; start: () => void },
): Promise<T> {
  while (true) {
    const result = checkFn();
    const ok = ('found' in result ? result.found : result.authenticated) ?? false;

    if (ok) return result;

    spinner?.stop();
    console.log(chalk.yellow(`\n⚠  ${label} not found.`));
    console.log(chalk.dim(`   ${installHint}`));
    await input({ message: 'Press Enter to retry…' });
    spinner?.start();
  }
}

// ── macOS TCC warm-up ───────────────────────────────────

export type TccProbeStatus = 'granted' | 'denied' | 'missing';

export interface TccProbeResult {
  /** Short label suitable for display, e.g. "~/Documents". */
  label: string;
  /** Absolute path that was probed. */
  path: string;
  status: TccProbeStatus;
}

/**
 * Folders that macOS protects via TCC (Transparency, Consent, Control).
 * Touching any of these for the first time triggers a system permission
 * prompt attributed to the calling binary.
 *
 * Order matters — prompts appear in this order during setup.
 */
const TCC_PROTECTED_FOLDERS: Array<{ label: string; relPath: string }> = [
  { label: '~/Documents', relPath: 'Documents' },
  { label: '~/Desktop', relPath: 'Desktop' },
  { label: '~/Downloads', relPath: 'Downloads' },
  { label: '~/iCloud Drive', relPath: 'Library/Mobile Documents/com~apple~CloudDocs' },
  { label: '~/Pictures', relPath: 'Pictures' },
  { label: '~/Movies', relPath: 'Movies' },
  { label: '~/Music', relPath: 'Music' },
];

/**
 * Probe a single TCC-protected folder by attempting a tiny readdir.
 * Resolves with the access status. Never throws.
 */
async function probeFolder(absPath: string): Promise<TccProbeStatus> {
  if (!existsSync(absPath)) return 'missing';
  try {
    // Reading the directory is enough to trigger TCC. We don't need the
    // entries themselves — the system call is what flips the permission bit.
    await fsp.readdir(absPath);
    return 'granted';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM / EACCES → user denied (or hasn't decided yet and dismissed).
    if (code === 'EPERM' || code === 'EACCES') return 'denied';
    // ENOENT shouldn't happen since we existsSync'd, but treat as missing.
    if (code === 'ENOENT') return 'missing';
    // Anything else — treat as denied so we don't lie about access.
    return 'denied';
  }
}

/**
 * Probe each macOS TCC-protected folder in turn, triggering the system
 * permission prompt on first run. Calls `onStart` before each probe so
 * a UI can render the status line before the modal blocks, then
 * `onResult` after the probe resolves so the UI can show the outcome.
 *
 * Returns one result per folder. On non-macOS platforms returns [].
 */
export async function warmupTccPermissions(
  onStart?: (label: string) => void,
  onResult?: (result: TccProbeResult) => void,
): Promise<TccProbeResult[]> {
  if (platform() !== 'darwin') return [];

  const home = homedir();
  const results: TccProbeResult[] = [];

  for (const { label, relPath } of TCC_PROTECTED_FOLDERS) {
    const absPath = join(home, relPath);
    onStart?.(label);
    const status = await probeFolder(absPath);
    const result: TccProbeResult = { label, path: absPath, status };
    results.push(result);
    onResult?.(result);
  }

  return results;
}
