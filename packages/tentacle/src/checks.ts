/**
 * Environment checks for Kraki tentacle setup.
 *
 * Validates that required CLI tools are installed and authenticated.
 * Provides a retry mechanism for interactive setup flows.
 */

import { execSync } from 'node:child_process';
import { confirm } from '@inquirer/prompts';
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
    const output = execSync('gh --version 2>/dev/null', { encoding: 'utf8' }).trim();
    const match = output.match(/gh version ([\d.]+)/);
    return { found: true, version: match?.[1] ?? output.split('\n')[0] };
  } catch {
    return { found: false };
  }
}

export function checkGhAuth(): AuthCheckResult {
  try {
    const token = execSync('gh auth token 2>/dev/null', { encoding: 'utf8' }).trim();
    if (!token) return { authenticated: false };

    let username: string | undefined;
    try {
      username = execSync('gh api user --jq .login 2>/dev/null', { encoding: 'utf8' }).trim() || undefined;
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
    const output = execSync('copilot --version 2>/dev/null', { encoding: 'utf8' }).trim();
    return { found: true, version: output.split('\n')[0] };
  } catch {
    return { found: false };
  }
}

// ── Retry wrapper ───────────────────────────────────────

/**
 * Run a check function with interactive retry.
 * After 2 failures, prints a terminal-restart hint and exits.
 * If a spinner is provided, it is stopped before prompting and restarted on retry.
 */
export async function withRetry<T extends { found?: boolean; authenticated?: boolean }>(
  checkFn: () => T,
  label: string,
  installHint: string,
  spinner?: { stop: () => void; start: () => void },
): Promise<T> {
  let failures = 0;

  while (true) {
    const result = checkFn();
    const ok = ('found' in result ? result.found : result.authenticated) ?? false;

    if (ok) return result;

    failures++;
    spinner?.stop();
    console.log(chalk.yellow(`\n⚠  ${label} not found.`));
    console.log(chalk.dim(`   ${installHint}`));

    if (failures >= 2) {
      console.log(chalk.red(`\n✖  Still not detected after ${failures} attempts.`));
      console.log(chalk.dim('   Try opening a new terminal window and running kraki again.'));
      process.exit(1);
    }

    const retry = await confirm({ message: 'Retry?', default: true });
    if (!retry) {
      process.exit(1);
    }
    spinner?.start();
  }
}
