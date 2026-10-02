/**
 * Environment checks for Kraki tentacle setup.
 *
 * Validates that required CLI tools are installed and authenticated.
 * Provides a retry mechanism for interactive setup flows.
 */

import { execSync, execFileSync } from 'node:child_process';
import { promises as fsp, appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { input } from '@inquirer/prompts';
import { findAppBundledCli } from './agent-paths.js';
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

/** `reg query <key> /v Path`, by absolute path: PATH itself may be stale. */
function regQueryPath(key: string): string {
  const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  return execFileSync(reg, ['query', key, '/v', 'Path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
}

/** The value of a `reg query … /v Path` answer; `%VAR%` expanded from env. */
export function parseRegPath(output: string, env: NodeJS.ProcessEnv = process.env): string {
  const line = output.split(/\r?\n/).find((l) => /\sREG_(?:EXPAND_)?SZ\s/i.test(l));
  const value = line?.replace(/^.*?\sREG_(?:EXPAND_)?SZ\s+/i, '').trim() ?? '';
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? env[key] ?? whole : whole;
  });
}

/**
 * On Windows, refresh process.env.PATH from the registry so that tools
 * installed in another window (e.g. an agent, during setup) are found without
 * restarting Kraki. Entries already on PATH are kept. No-op elsewhere.
 */
export function refreshPathOnWindows(run: (key: string) => string = regQueryPath, os = platform()): void {
  if (os !== 'win32') return;
  const read = (key: string) => {
    try { return parseRegPath(run(key)); } catch { return ''; }
  };
  const machine = read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
  const user = read('HKCU\\Environment');
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [machine, user, process.env[pathKey] ?? ''].join(';').split(';')) {
    const d = dir.trim();
    if (!d || seen.has(d.toLowerCase())) continue;
    seen.add(d.toLowerCase());
    merged.push(d);
  }
  process.env[pathKey] = merged.join(';');
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

/** Coding agents Kraki can run, in the order setup lists them. */
export const SETUP_AGENTS: ReadonlyArray<{ id: 'claude' | 'codex' | 'copilot' | 'pi'; name: string; bin: string; installUrl: string }> = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', installUrl: 'https://code.claude.com/docs/en/setup' },
  { id: 'codex', name: 'Codex', bin: 'codex', installUrl: 'https://developers.openai.com/codex/cli' },
  { id: 'copilot', name: 'GitHub Copilot CLI', bin: 'copilot', installUrl: 'https://github.com/features/copilot/cli' },
  { id: 'pi', name: 'Pi', bin: 'pi', installUrl: 'https://github.com/earendil-works/pi#readme' },
];

/** Is `bin` runnable, and which version (leading semver when present)? Looks on
 *  PATH, then inside the agent's desktop app (Codex / Claude, see agent-paths.ts). */
export function checkAgentCli(bin: string): CliCheckResult & { path?: string } {
  const parse = (output: string, path?: string) => {
    const first = output.trim().split('\n')[0] ?? '';
    const match = first.match(/(\d+\.\d+\.\d+)/);
    return { found: true, version: match?.[1] ?? (first || undefined), ...(path && { path }) };
  };
  try {
    // execSync (not execFile) so Windows resolves .cmd shims like the other checks.
    return parse(execSync(`${bin} --version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 25_000 }));
  } catch { /* not on PATH */ }
  const bundled = findAppBundledCli(bin);
  if (bundled) {
    try {
      return parse(execFileSync(bundled, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 25_000 }), bundled);
    } catch { /* broken app install */ }
  }
  return { found: false };
}

export function checkClaudeCli(): CliCheckResult {
  try {
    const output = execSync('claude --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    // `claude --version` prints e.g. "1.2.3 (Claude Code)" — keep the
    // leading semver if present, otherwise the whole first line.
    const first = output.split('\n')[0];
    const match = first.match(/(\d+\.\d+\.\d+)/);
    return { found: true, version: match?.[1] ?? first };
  } catch {
    return { found: false };
  }
}

export function checkCodexCli(): CliCheckResult {
  try {
    const output = execSync('codex --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 }).trim();
    return { found: true, version: output.split('\n')[0].replace(/^codex-cli\s+/, '') };
  } catch {
    return { found: false };
  }
}

// ── Anthropic credentials ───────────────────────────────
//
// The Claude adapter resolves credentials from process.env merged with
// the `env` block of ~/.claude/settings.json (see adapters/claude.ts
// loadClaudeSettingsEnv). A daemon launched by launchd/systemd does NOT
// inherit the interactive shell environment, so settings.json is the
// canonical place a key lands. We mirror that resolution order here so
// setup/doctor report the same truth the daemon will see at runtime.

export type AnthropicCredSource = 'env' | 'settings' | 'provider';

export interface AnthropicCredResult {
  configured: boolean;
  /** Where the credential was found, or null if none. */
  source: AnthropicCredSource | null;
}

/** Read the `env` map from ~/.claude/settings.json (best-effort). */
export function readClaudeSettingsEnv(): Record<string, string> {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown> };
    const out: Record<string, string> = {};
    if (parsed.env && typeof parsed.env === 'object') {
      for (const [k, v] of Object.entries(parsed.env)) {
        if (typeof v === 'string') out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Probe whether the Claude SDK will find usable credentials. Mirrors the
 * daemon's resolution: process.env wins, then ~/.claude/settings.json,
 * then third-party provider flags. Never makes a network call.
 */
export function checkAnthropicCreds(): AnthropicCredResult {
  const settingsEnv = readClaudeSettingsEnv();
  const get = (key: string): string | undefined =>
    process.env[key] ?? settingsEnv[key];
  const sourceOf = (key: string): AnthropicCredSource =>
    process.env[key] !== undefined ? 'env' : 'settings';

  // Direct API key / auth token.
  if (get('ANTHROPIC_API_KEY')) {
    return { configured: true, source: sourceOf('ANTHROPIC_API_KEY') };
  }
  if (get('ANTHROPIC_AUTH_TOKEN')) {
    return { configured: true, source: sourceOf('ANTHROPIC_AUTH_TOKEN') };
  }

  // Third-party providers (Bedrock / Vertex / Foundry) — credentials are
  // resolved by their own SDKs, so the flag being set is sufficient.
  for (const flag of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    if (get(flag) === '1') return { configured: true, source: 'provider' };
  }

  return { configured: false, source: null };
}

/**
 * Persist an Anthropic API key into ~/.claude/settings.json `env` block —
 * the same file the daemon and Claude Code itself read. Merges into any
 * existing settings, creating the file/dir if needed. Used by headless
 * setup (`--anthropic-key`) so a GUI wizard can store the key where the
 * launchd daemon will pick it up.
 */
export function saveAnthropicKey(key: string): void {
  const dir = join(homedir(), '.claude');
  const settingsPath = join(dir, 'settings.json');
  mkdirSync(dir, { recursive: true });

  let settings: { env?: Record<string, unknown>; [k: string]: unknown } = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as typeof settings;
  } catch {
    /* missing or malformed — start fresh */
  }
  const env = (settings.env && typeof settings.env === 'object')
    ? settings.env as Record<string, unknown>
    : {};
  env.ANTHROPIC_API_KEY = key;
  settings.env = env;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
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
// A process without FDA receives EPERM when it actually opens or lists any of
// these. Multiple targets guard against Apple removing protection from any
// single path in a future macOS release, and against a path that does not
// exist yet on a fresh account.
//
// The probe must perform the real read. `access(2)` only evaluates Unix
// permission bits and succeeds on these paths even when TCC would refuse the
// open — the previous implementation therefore reported "granted" on machines
// without FDA (reproduced on a clean macOS 26 VM).
export const FDA_PROBE_TARGETS: readonly { rel: string; kind: 'dir' | 'file' }[] = [
  { rel: 'Library/Safari', kind: 'dir' },
  { rel: 'Library/Mail', kind: 'dir' },
  { rel: 'Library/Application Support/com.apple.TCC/TCC.db', kind: 'file' },
];

async function readProbe(target: string, kind: 'dir' | 'file'): Promise<void> {
  if (kind === 'dir') {
    await fsp.readdir(target);
    return;
  }
  const handle = await fsp.open(target, 'r');
  try {
    await handle.read(Buffer.alloc(16), 0, 16, 0);
  } finally {
    await handle.close();
  }
}

/**
 * Probe macOS Full Disk Access by reading known TCC-protected paths. Tries
 * multiple targets so the check stays reliable across macOS versions even if
 * Apple changes protection on individual paths.
 *
 * Never triggers a system dialog — FDA-gated paths fail silently with EPERM.
 */
export async function probeFda(): Promise<FdaStatus> {
  if (platform() !== 'darwin') return 'granted'; // non-macOS: not applicable

  const home = homedir();
  let sawBlocked = false;

  for (const { rel, kind } of FDA_PROBE_TARGETS) {
    const target = join(home, rel);
    try {
      await readProbe(target, kind);
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
/**
 * Probe FDA as Kraki.app itself. A CLI started from Terminal is attributed to
 * Terminal by TCC, so an in-process probe reports Terminal's access, not the
 * grant the user just gave Kraki. Launching `kraki fda --json` through
 * LaunchServices gives the probe Kraki's bundle identity, exactly like the
 * daemon. Falls back to the in-process probe when not running from a bundle.
 */
export async function probeFdaAsApp(): Promise<FdaStatus> {
  const app = platform() === 'darwin' ? getKrakiAppBundlePath() : null;
  if (!app) return probeFda();
  const out = join(tmpdir(), `kraki-fda-${process.pid}-${Date.now()}.json`);
  try {
    execFileSync('/usr/bin/open', ['-W', '-n', '-g', '-a', app, '--stdout', out, '--stderr', '/dev/null', '--args', 'fda', '--json'], {
      stdio: 'ignore',
      timeout: 15_000,
    });
    const line = readFileSync(out, 'utf8').trim().split('\n').pop() ?? '';
    const status = (JSON.parse(line) as { status?: string }).status;
    if (status === 'granted' || status === 'denied' || status === 'missing') return status;
  } catch {
    /* fall through to the in-process probe */
  } finally {
    try { rmSync(out, { force: true }); } catch { /* ignore */ }
  }
  return probeFda();
}

/**
 * Whether this process (and the agents it starts) may click and type, via
 * AXIsProcessTrusted in JXA. With `prompt`, macOS shows its "would like to
 * control this computer" notice and lists Kraki under Accessibility, so the
 * user only has to flip the switch. Run from Kraki.app (see
 * probeAccessibilityAsApp) so the answer is about Kraki, not a terminal.
 */
export function probeAccessibility(prompt = false): 'granted' | 'denied' | 'unknown' {
  if (platform() !== 'darwin') return 'granted';
  const script = prompt
    ? "ObjC.import('ApplicationServices'); String($.AXIsProcessTrustedWithOptions($({AXTrustedCheckOptionPrompt: true})))"
    : "ObjC.import('ApplicationServices'); String($.AXIsProcessTrusted())";
  try {
    const out = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    return out === 'true' ? 'granted' : out === 'false' ? 'denied' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function pollFda(
  intervalMs = 2000,
  signal?: AbortSignal,
  probe: () => Promise<FdaStatus> = probeFda,
): Promise<FdaStatus> {
  const initial = await probe();
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
    const status = await probe();
    if (status === 'granted') return 'granted';
  }

  // Final check after abort - the user may have granted just before skip
  return probe();
}

// ── macOS TCC: Launch Services registration ───────────────
//
// THE root cause of every recurring "kraki lost its permissions" bug.
//
// macOS TCC can track a signed .app bundle two ways:
//   1. By cdhash + path (default for raw Mach-O executed directly)
//   2. By bundle id + signing identity Designated Requirement (DR)
//      — only when the bundle is REGISTERED with Launch Services
//
// The release pipeline already signs the .app with a stable Developer ID
// and gives it a stable CFBundleIdentifier (chat.kraki.cli), which is what
// makes (2) possible. But the install/update paths never told Launch
// Services about the bundle, so TCC silently fell back to (1). Every
// release ships a new binary -> new cdhash -> every previously granted
// TCC service (FDA, Accessibility, Screen Recording, Input Monitoring,
// Automation) is invalidated and the user has to re-grant.
//
// Calling `lsregister -f <bundle>` once (per install location) flips TCC
// into bundle-id tracking. As long as the Developer ID Team ID stays
// stable across releases, every TCC grant then survives updates forever.
// This is the fix commits #123/#133/#138/#142 were all reaching for but
// never actually completed.

/** Path to the system `lsregister` binary (stable across macOS versions). */
export const LSREGISTER_PATH =
  '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/' +
  'LaunchServices.framework/Versions/A/Support/lsregister';

/** Bundle id of the signed Kraki CLI/daemon .app (must never change). */
export const KRAKI_BUNDLE_ID = 'chat.kraki.cli';

/**
 * Resolve the .app bundle that contains the current executable, if any.
 * Returns the absolute path to `*.app`, or null when running as a raw
 * standalone binary / from node_modules / on non-macOS hosts.
 *
 * Expected layout: <prefix>/Kraki.app/Contents/MacOS/kraki
 */
export function getKrakiAppBundlePath(): string | null {
  if (platform() !== 'darwin') return null;
  let realPath: string;
  try {
    realPath = realpathSync(process.execPath);
  } catch {
    realPath = process.execPath;
  }
  const macosDir = dirname(realPath);
  const contentsDir = dirname(macosDir);
  const appDir = dirname(contentsDir);
  if (
    macosDir.endsWith('/MacOS') &&
    contentsDir.endsWith('/Contents') &&
    appDir.endsWith('.app') &&
    existsSync(join(contentsDir, 'Info.plist'))
  ) {
    return appDir;
  }
  return null;
}

/**
 * Register (or re-register) the installed Kraki.app bundle with Launch Services.
 *
 * This makes Launch Services aware that the bundle exists ON DISK — which is
 * what lets System Settings show it with its name and icon, and what keeps the
 * bundle-id lookup unambiguous. It does NOT by itself make TCC track the daemon
 * by bundle id.
 *
 * TCC's choice between bundle-id and path tracking follows the RUNTIME identity
 * of the process, which is decided by how the process was launched, not by what
 * is registered on disk. A binary `execve()`d out of Contents/MacOS has no
 * Launch Services application identity at all (verified: NSRunningApplication
 * returns nil for it, and resolves the bundle id for the same bundle started via
 * `open`), so TCC path-tracks it and the grant dies with the next cdhash change.
 * The daemon is therefore launched through LaunchServices — see the launch
 * comment in startDaemonLaunchctl() (daemon.ts), which is the actual fix.
 *
 * Safe to call repeatedly and on every platform:
 *   - non-darwin -> no-op, returns true
 *   - not running from a .app bundle -> returns false (dev/node_modules)
 *   - lsregister missing/fails -> swallows the error, returns false
 *
 * Returns true when the bundle looks registered.
 */
export function registerKrakiAppBundle(appBundlePath?: string): boolean {
  if (platform() !== 'darwin') return true;
  // An explicit path is required after an update: the bundle directory has just
  // been replaced, and deriving it from the still-running process's execPath
  // either points at the old (now renamed) bundle or, when migrating a
  // standalone binary to a bundle for the first time, resolves to null — in
  // which case the freshly installed bundle was never registered at all.
  const appPath = appBundlePath ?? getKrakiAppBundlePath();
  if (!appPath) return false;

  try {
    execSync(`"${LSREGISTER_PATH}" -f "${appPath}"`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return true;
  } catch {
    // lsregister can fail spuriously under CSM/SSV. Registration is also
    // performed implicitly the first time the bundle is opened via Launch
    // Services, so a failure here is not fatal — TCC will still resolve the
    // bundle id once the user adds it in System Settings.
    return false;
  }
}

/**
 * Whether a running process has a Launch Services application identity, i.e.
 * whether TCC has a bundle id to key its grants on.
 *
 * This is the signal that was missing while "permissions reset on every update"
 * was misdiagnosed six times. Registering the bundle on disk and cleaning zombie
 * Launch Services entries are both visible and both looked correct, while the
 * thing that actually decides bundle-id vs path tracking — the runtime identity
 * of the daemon process — was never measured.
 *
 * `lsappinfo` answers it without a compiled helper. A process launched through
 * LaunchServices reports its bundle id; one `execve()`d straight out of
 * Contents/MacOS reports NULL, and NULL means TCC is path-tracking it and the
 * grant will not survive the next update.
 *
 * Returns the bundle id, or null when the process has no LS identity (or on any
 * lookup failure — this is a diagnostic and must never throw).
 */
export function getProcessBundleIdentity(pid: number): string | null {
  if (platform() !== 'darwin') return null;
  try {
    const { __CFBundleIdentifier: _privateLaunchServicesIdentity, ...safeEnv } = process.env;
    const out = execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', String(pid)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 5000,
      // The probe is a child of the LaunchServices-owned daemon during early
      // bootstrap. Never let the diagnostic helper inherit the private app
      // identity variable it is trying to measure.
      env: safeEnv,
    });
    // Older macOS: "CFBundleIdentifier"="chat.kraki.cli"
    // macOS 27:    bundleID="chat.kraki.cli" (in a multi-line app summary).
    // Both formats use [ NULL ] for absent values. Match only a complete
    // field line so an app name/path cannot masquerade as a bundle identity.
    const m = out.match(/^\s*(?:"CFBundleIdentifier"|bundleID)\s*=\s*"([^"\r\n]+)"[ \t]*\r?$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Report whether the daemon is launched in a way TCC can track by bundle id.
 *
 * `healthy: false` with `bundled: true` is the exact state that caused the
 * recurring permission loss: a correctly signed, correctly registered bundle
 * whose daemon was nonetheless started by absolute path.
 */
export function getDaemonTccIdentity(
  daemonPid: number | null,
  identityProof?: { pid: number; bundleId: string } | null,
): {
  bundled: boolean;
  bundlePath: string | null;
  daemonPid: number | null;
  daemonBundleId: string | null;
  healthy: boolean;
} {
  const bundlePath = getKrakiAppBundlePath();
  const bundled = bundlePath !== null;
  const daemonBundleId = daemonPid !== null
    ? (identityProof?.pid === daemonPid
        ? identityProof.bundleId
        : getProcessBundleIdentity(daemonPid))
    : null;
  return {
    bundled,
    bundlePath,
    daemonPid,
    daemonBundleId,
    // Only meaningful while the daemon is actually running.
    healthy: daemonPid === null ? bundled : daemonBundleId === KRAKI_BUNDLE_ID,
  };
}

/** Ensure the bundle is registered. Convenience wrapper for setup/update. */
export function ensureTccBundleRegistered(): void {
  registerKrakiAppBundle();
}

/**
 * Remove a bundle path from Launch Services. Use after extracting an update
 * into a throwaway temp dir so TCC's responsible-bundle resolver never sees
 * a stale duplicate `chat.kraki.cli` entry pointing at a path that no longer
 * exists. Stale duplicates are the second root cause of "permissions lost
 * after update": with many conflicting entries, TCC can fail to attribute
 * the running daemon to the canonical bundle and re-prompt for every TCC
 * service. Best-effort; never throws.
 *
 * Implementation note: `lsregister -u <path>` only works when <path> still
 * exists on disk — on a vanished path it returns -10814 ("failed to scan")
 * and silently leaves the zombie entry behind. So when the path is gone we
 * recreate a 3-file stub bundle at the same path (same CFBundleIdentifier),
 * run `-u`, then delete the stub. That is the only reliable way to evict an
 * orphan Launch Services record without a full `-kill` db reset.
 */
export function unregisterAppBundlePath(appPath: string): void {
  if (platform() !== 'darwin') return;
  const safeTry = (fn: () => void) => { try { fn(); } catch { /* best-effort */ } };

  // `lsregister -u <path>` only works when <path> still exists on disk — on a
  // vanished path it returns -10814 ("failed to scan") and silently leaves the
  // zombie entry behind. When the path is gone we recreate a 3-file stub
  // bundle at the same path (same CFBundleIdentifier), run `-u`, then delete
  // the stub. That is the only reliable way to evict an orphan Launch Services
  // record without a destructive `-kill` db reset.
  // Only fabricate a stub at a path that is COMPLETELY absent. A directory that
  // exists but has no Contents/Info.plist is not necessarily ours — it can be a
  // half-extracted update, or an unrelated directory that merely shares the name.
  // Writing a stub into it would make the rmSync below delete the whole tree, so
  // in that case do the plain `-u` and leave the directory alone even if the
  // zombie entry survives. An uncollected LS record is recoverable; deleting a
  // user's directory is not.
  const alreadyExists = existsSync(appPath);
  const isIntactBundle = existsSync(join(appPath, 'Contents', 'Info.plist'));
  let createdStub = false;

  if (!alreadyExists) {
    safeTry(() => {
      mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true });
      writeFileSync(join(appPath, 'Contents', 'MacOS', 'kraki'), '#!/bin/sh\n', { mode: 0o755 });
      writeFileSync(
        join(appPath, 'Contents', 'Info.plist'),
        '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>' +
        '<key>CFBundleIdentifier</key><string>' + KRAKI_BUNDLE_ID + '</string>' +
        '<key>CFBundleExecutable</key><string>kraki</string>' +
        '<key>CFBundleName</key><string>Kraki CLI</string>' +
        '<key>CFBundleVersion</key><string>0</string>' +
        '</dict></plist>\n',
      );
      createdStub = true;
    });
  }

  safeTry(() => {
    execSync('"' + LSREGISTER_PATH + '" -u "' + appPath + '"', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  });

  // Remove only a stub this call created at a path that did not previously
  // exist. Never touch a pre-existing directory, intact bundle or not.
  if (createdStub && !alreadyExists && !isIntactBundle) {
    safeTry(() => rmSync(appPath, { recursive: true, force: true }));
  }
}

/**
 * Sweeper: when kraki has been installed/updated/test-built many times,
 * Launch Services accumulates zombie entries for `chat.kraki.cli` at paths
 * that no longer exist (old update temp dirs, Xcode build products, test
 * extractions). Each one is a chance for TCC to mis-resolve the running
 * daemon's bundle and silently invalidate its grants. This parses
 * `lsregister -dump`, finds every registered path whose bundle id is the
 * daemon's, and unregisters any that either no longer exist on disk or are
 * not the canonical install path. Safe to run on every install/update.
 */
export function cleanupStaleBundleEntries(canonicalAppPath?: string): {
  removed: string[]; kept: string[];
} {
  if (platform() !== 'darwin') return { removed: [], kept: [] };

  const canonical = canonicalAppPath ?? getKrakiAppBundlePath();
  const canonicalReal = canonical ? realpathSafe(canonical) : null;
  const removed: string[] = [];
  const kept: string[] = [];

  let dump = '';
  try {
    dump = execSync(`"${LSREGISTER_PATH}" -dump`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return { removed, kept };
  }

  // Each LS record block is delimited by a line of dashes. A block claims
  // bundle id `chat.kraki.cli` (or whatever the running binary's id is) if
  // it contains `CFBundleIdentifier = "<id>"`. The path it is registered at
  // is the `path:` line. We unregister any path that is gone from disk or
  // is a /private/tmp or $TMPDIR throwaway.
  const bundleId = KRAKI_BUNDLE_ID;
  const tmpRoot = realpathSafe(tmpdir());
  const blocks = dump.split(/^----+\s*$/m);
  const seenPaths = new Set<string>();
  for (const block of blocks) {
    if (!block.includes(`CFBundleIdentifier = "${bundleId}"`)) continue;
    const pathMatch = block.match(/^path:\s*(\S.*?)\s*\(0x/m);
    if (!pathMatch) continue;
    const rawPath = pathMatch[1].trim();
    if (seenPaths.has(rawPath)) continue;
    seenPaths.add(rawPath);

    const isCanonical = canonicalReal !== null && realpathSafe(rawPath) === canonicalReal;
    const isUnderTmp = rawPath.startsWith('/private/tmp/') || rawPath.startsWith(tmpRoot) || rawPath.startsWith('/tmp/');
    const existsOnDisk = existsSync(rawPath);

    // NEVER touch the canonical install path, even if it's momentarily gone
    // (e.g. mid-replacement during an update) — it will be re-registered by
    // the caller. Only evict throwaway /tmp paths and genuinely-orphaned
    // non-canonical paths.
    if (isCanonical) {
      kept.push(rawPath);
      continue;
    }
    // Unregister anything stale (gone from disk) OR a throwaway temp path,
    // even if it still exists this instant (it won't after the update).
    if (!existsOnDisk || isUnderTmp) {
      unregisterAppBundlePath(rawPath);
      removed.push(rawPath);
    } else {
      kept.push(rawPath);
    }
  }
  return { removed, kept };
}

/** Resolve a path without throwing (falls back to the input). */
function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// ── macOS TCC: System Settings deep-links ───────────────
//
// The URLs below are the supported Privacy & Security anchors (macOS 13+).
// `open`-ing them lands the user on the exact pane; they still have to flip
// the toggle (TCC.db is SIP-protected and cannot be flipped programmatically).

/**
 * macOS privacy panes Kraki points to. Full Disk Access: agents read and edit
 * projects. Accessibility: optional, for agents that click and type — macOS
 * never asks for it, it silently denies, so it has to be turned on here.
 * (Screen Recording, Automation, … are asked for when first used.)
 */
export type TccService = 'fda' | 'accessibility';

interface TccServiceInfo {
  /** Stable id used in JSON output. */
  id: TccService;
  /** Human label for the setup/CLI UX. */
  label: string;
  /** System Settings deep-link URL. */
  url: string;
  /** Why kraki wants this. */
  reason: string;
}

export const TCC_SERVICES: readonly TccServiceInfo[] = [
  {
    id: 'fda',
    label: 'Full Disk Access',
    url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    reason: 'let agents read and edit your projects without per-folder macOS prompts',
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    reason: 'optional: let agents click and type for you',
  },
] as const;

/** Open a specific TCC pane in System Settings. No-op off macOS. */
export function openTccPane(service: TccService): boolean {
  if (platform() !== 'darwin') return false;
  const info = TCC_SERVICES.find((s) => s.id === service);
  if (!info) return false;
  try {
    execSync(`open "${info.url}"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Select Kraki.app in a Finder window so it can be dragged into a TCC list. */
export function revealKrakiApp(): boolean {
  const app = getKrakiAppBundlePath();
  if (!app) return false;
  try {
    execFileSync('open', ['-R', app], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Open the TCC pane(s) kraki wants (used by `kraki permissions --open`). */
export function openAllTccPanes(): void {
  if (platform() !== 'darwin') return;
  for (const s of TCC_SERVICES) openTccPane(s.id);
}

// ── macOS TCC: full status snapshot ──────────────────────

export type TccProbeStatus = 'granted' | 'denied' | 'unknown';

export interface TccStatus {
  /** Whether the running binary lives inside a Launch-Services bundle. */
  bundled: boolean;
  /** Whether that bundle is registered with Launch Services. Best-effort. */
  registered: boolean;
  /** True on non-darwin hosts where none of this applies. */
  notApplicable: boolean;
  /**
   * Per-service probe. Only `fda` can be probed reliably without triggering a
   * system dialog; the rest stay `'unknown'` until the user grants them and
   * kraki actually exercises the protected capability at runtime.
   */
  services: Record<TccService, TccProbeStatus>;
}

/**
 * Probe macOS TCC state for kraki. FDA is the only service with a reliable
 * non-intrusive probe (multi-path file-access check). Accessibility / Input
 * Monitoring / Screen Recording / Automation have no public, prompt-free
 * probe from a Node process, so they report `'unknown'` and the caller is
 * expected to open the corresponding pane via `openTccPane()`.
 */
export async function probeTccStatus(): Promise<TccStatus> {
  if (platform() !== 'darwin') {
    return {
      bundled: false,
      registered: false,
      notApplicable: true,
      services: {
        fda: 'granted',
        accessibility: 'granted',
      },
    };
  }

  const bundled = getKrakiAppBundlePath() !== null;
  // Registration is idempotent; calling it here also self-heals machines that
  // installed before the lsregister step existed.
  const registered = registerKrakiAppBundle();
  const fda = await probeFda();

  return {
    bundled,
    registered,
    notApplicable: false,
    services: {
      fda: fda === 'granted' ? 'granted' : fda === 'denied' ? 'denied' : 'unknown',
      accessibility: probeAccessibility(),
    },
  };
}
