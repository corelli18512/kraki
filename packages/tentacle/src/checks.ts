/**
 * Environment checks for Kraki tentacle setup.
 *
 * Validates that required CLI tools are installed and authenticated.
 * Provides a retry mechanism for interactive setup flows.
 */

import { execSync } from 'node:child_process';
import { constants as fsConstants, promises as fsp, appendFileSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { input } from '@inquirer/prompts';
import chalk from 'chalk';

/**
 * On Windows, ensure essential system directories are present in
 * `process.env.PATH`. Returns the list of directories that were
 * prepended (empty if nothing was missing).
 *
 * Why: the daemon may be launched from a context with a minimal PATH
 * (Startup folder shortcut, Task Scheduler, double-clicked SEA binary),
 * where even `%SystemRoot%\System32` is absent. Tools that spawn
 * `powershell.exe` / `pwsh.exe` / `where` / `cmd` by short name then
 * fail with ENOENT — notably the GitHub Copilot SDK, whose PowerShell
 * tool looks up `pwsh.exe` and `powershell.exe` via PATH and surfaces
 * "PowerShell is not available" inside agent sessions.
 *
 * This helper is idempotent and merges (rather than wholesale-replaces)
 * existing PATH entries so it can run alongside other PATH manipulation
 * (e.g. the `node_modules/.bin` prepend in resolveDaemonLaunch).
 *
 * No-op on non-Windows platforms.
 */
export function ensureWindowsSystemPath(): string[] {
  if (platform() !== 'win32') return [];

  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const required = [
    `${sysRoot}\\System32`,
    `${sysRoot}\\System32\\WindowsPowerShell\\v1.0`,
    `${sysRoot}\\System32\\Wbem`,
    sysRoot,
  ];

  const current = (process.env.PATH ?? '').split(';');
  const currentLower = new Set(current.map((p) => p.toLowerCase()));
  const missing = required.filter((p) => !currentLower.has(p.toLowerCase()));

  if (missing.length === 0) return [];
  process.env.PATH = [...missing, ...current].filter(Boolean).join(';');

  // Record that we patched PATH so it's diagnosable after the fact.
  // The daemon-worker child usually inherits the already-patched PATH
  // from cli.ts and so this branch never fires there — meaning the log
  // file is effectively a record of the *parent* cli.ts process having
  // had to self-heal. Best-effort; never throw from this helper.
  try {
    const krakiHome = process.env.KRAKI_HOME?.trim() || join(homedir(), '.kraki');
    const logsDir = join(krakiHome, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const entry = JSON.stringify({
      time: new Date().toISOString(),
      pid: process.pid,
      argv0: process.argv0,
      script: process.argv[1] ?? '',
      addedPathDirs: missing,
    }) + '\n';
    appendFileSync(join(logsDir, 'path-self-heal.log'), entry);
  } catch {
    /* best effort */
  }

  return missing;
}

/**
 * On Windows, refresh process.env.PATH from the registry so that
 * newly-installed tools are visible without opening a new terminal.
 * No-op on other platforms.
 */
function refreshPathOnWindows(): void {
  if (platform() !== 'win32') return;
  try {
    const machinePath = execSync(
      'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).replace(/.*REG_(?:EXPAND_)?SZ\s+/i, '').trim();

    const userPath = execSync(
      'reg query "HKCU\\Environment" /v Path',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).replace(/.*REG_(?:EXPAND_)?SZ\s+/i, '').trim();

    process.env.PATH = `${machinePath};${userPath}`;
  } catch { /* best effort — fall through to stale PATH */ }
}

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
    refreshPathOnWindows();
    spinner?.start();
  }
}

// ── macOS Full Disk Access ───────────────────────────────
//
// FDA (kTCCServiceSystemPolicyAllFiles) is a superset of all per-folder
// and AppData TCC categories. Granting it eliminates every recurring
// macOS permission dialog that the Copilot agent would otherwise trigger.
// Instead of probing individual folders, we simply require FDA.

export type FdaStatus = 'granted' | 'denied' | 'missing';

// Paths that macOS gates behind FDA (kTCCServiceSystemPolicyAllFiles).
// A process without FDA receives EPERM when accessing any of these.
// Multiple targets guard against Apple removing protection from any single
// path in a future macOS release.
const FDA_PROBE_TARGETS = [
  'Library/Mail',
  'Library/Safari/Databases',
  'Library/Application Support/com.apple.TCC/TCC.db',
];

/**
 * Probe macOS Full Disk Access by attempting to read known TCC-protected
 * paths. Tries multiple targets so the check stays reliable across macOS
 * versions even if Apple changes protection on individual paths.
 *
 * Never triggers a system dialog — it only checks the current state.
 */
export async function probeFda(): Promise<FdaStatus> {
  if (platform() !== 'darwin') return 'granted'; // non-macOS: not applicable

  const home = homedir();
  let sawBlocked = false;

  for (const rel of FDA_PROBE_TARGETS) {
    const target = join(home, rel);
    try {
      await fsp.access(target, fsConstants.R_OK);
      return 'granted';
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        sawBlocked = true;
      }
      // ENOENT → path doesn't exist on this machine, try next
    }
  }

  return sawBlocked ? 'denied' : 'missing';
}

/**
 * Poll Full Disk Access at regular intervals until granted or the signal
 * is aborted. Never triggers a system dialog — uses the same multi-path
 * probe as `probeFda()`.
 *
 * Returns the final observed status ('granted' once the user toggles FDA
 * in System Settings, or the last polled status if aborted early).
 */
export async function pollFda(
  intervalMs = 2000,
  signal?: AbortSignal,
): Promise<FdaStatus> {
  const initial = await probeFda();
  if (initial === 'granted') return 'granted';

  while (!signal?.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      if (signal) {
        const onAbort = () => { clearTimeout(timer); resolve(); };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    if (signal?.aborted) break;
    const status = await probeFda();
    if (status === 'granted') return 'granted';
  }

  // Final check after abort — the user may have granted just before skip
  return probeFda();
}
