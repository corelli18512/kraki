/**
 * Environment checks for Kraki tentacle setup.
 *
 * Validates that required CLI tools are installed and authenticated.
 * Provides a retry mechanism for interactive setup flows.
 */

import { execSync, execFile } from 'node:child_process';
import { existsSync, promises as fsp, appendFileSync, mkdirSync } from 'node:fs';
import { createConnection } from 'node:net';
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
 * Probe macOS "App Data" TCC (kTCCServiceSystemPolicyAppData) by spawning
 * /usr/bin/find against the iCloud Drive FileProvider path.
 *
 * A Node readdir from the parent process triggers per-folder TCC, but the
 * separate AppData category is only triggered when a *child process*
 * accesses a FileProvider-managed path. The Copilot agent regularly runs
 * `find` / `glob` which hits this code path — so we pre-trigger it here
 * during setup to avoid a surprise prompt mid-session.
 *
 * We use `-maxdepth 0` so find only stats the root directory without
 * actually traversing it.
 */
async function probeAppData(): Promise<TccProbeStatus> {
  const target = join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs');
  if (!existsSync(target)) return 'missing';

  return new Promise((resolve) => {
    const child = execFile(
      '/usr/bin/find',
      [target, '-maxdepth', '0'],
      { timeout: 30_000 },
      (err) => {
        if (!err) { resolve('granted'); return; }
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES') { resolve('denied'); return; }
        // Exit code 1 from find usually means permission denied on the path
        if (err.code === null && (err as { status?: number }).status === 1) { resolve('denied'); return; }
        resolve('denied');
      },
    );
    // Safety: if the child somehow hangs beyond the timeout, kill it
    child.on('error', () => resolve('denied'));
  });
}

/**
 * Probe macOS Local Network TCC by making a brief TCP connection to a
 * LAN-routable address. macOS surfaces the "Local Network" permission
 * prompt when a signed binary first attempts a local-network operation.
 *
 * We connect to 224.0.0.1:0 (the all-hosts multicast group) which is
 * guaranteed to be unroutable but still triggers the TCC check in the
 * kernel's network stack before the connection attempt fails. The
 * socket is destroyed immediately after the TCC decision.
 */
async function probeLocalNetwork(): Promise<TccProbeStatus> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      // Timed out waiting for the TCC dialog — treat as granted (the
      // dialog blocks the kernel call, so a timeout means it wasn't shown).
      resolve('granted');
    }, 10_000);

    const socket = createConnection({ host: '224.0.0.1', port: 9 });

    socket.on('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve('granted');
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      socket.destroy();
      const code = (err as NodeJS.ErrnoException).code;
      // ENETUNREACH / ECONNREFUSED / EHOSTUNREACH are normal — they mean
      // macOS allowed the network call but the destination is unreachable.
      // EPERM means the user denied the Local Network prompt.
      if (code === 'EPERM' || code === 'EACCES') {
        resolve('denied');
      } else {
        resolve('granted');
      }
    });
  });
}

/**
 * Probe each macOS TCC-protected resource in turn, triggering the system
 * permission prompt on first run. Probes folders first, then Local
 * Network. Calls `onStart` before each probe so a UI can render the
 * status line before the modal blocks, then `onResult` after the probe
 * resolves so the UI can show the outcome.
 *
 * Returns one result per resource. On non-macOS platforms returns [].
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

  // App Data (FileProvider) — child-process access to iCloud Drive triggers
  // kTCCServiceSystemPolicyAppData, a separate TCC category from folder access.
  // Probe after folders since it's file-related but uses a different mechanism.
  const appDataLabel = 'App Data';
  onStart?.(appDataLabel);
  const appDataStatus = await probeAppData();
  const appDataResult: TccProbeResult = { label: appDataLabel, path: '(file provider)', status: appDataStatus };
  results.push(appDataResult);
  onResult?.(appDataResult);

  // Local Network — probe after folders so the network dialog doesn't
  // interleave with folder dialogs.
  const netLabel = 'Local Network';
  onStart?.(netLabel);
  const netStatus = await probeLocalNetwork();
  const netResult: TccProbeResult = { label: netLabel, path: '(network)', status: netStatus };
  results.push(netResult);
  onResult?.(netResult);

  return results;
}
