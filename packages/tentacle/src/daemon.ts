/**
 * Daemon process management for Kraki tentacle.
 *
 * The daemon runs as a background child process executing daemon-worker.js.
 * Its PID is tracked under the current Kraki home.
 *
 * On macOS, downloaded SEA binaries carry com.apple.provenance which
 * cannot be removed. macOS 26+ CSM 2 blocks direct fork()+execve() of
 * such binaries from child processes. To bypass this, macOS SEA builds
 * use launchctl to have launchd spawn the daemon in a completely
 * independent context. A launch failure is fatal: Kraki never runs the
 * daemon inside the interactive CLI process.
 */

import { spawn, execSync, execFileSync, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeFileSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { delimiter, join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isSea } from 'node:sea';

import {
  getKrakiHome,
  getLogsDir,
  getLogVerbosity,
  type KrakiConfig,
  saveDaemonPid,
  loadDaemonPid,
  clearDaemonPid,
  loadDaemonReady,
  clearDaemonReady,
} from './config.js';
import { getKrakiAppBundlePath, getProcessBundleIdentity, KRAKI_BUNDLE_ID } from './checks.js';

// How long to wait for any background daemon to publish readiness. Agent
// discovery and capability loading can be slow on a cold machine; the explicit
// ready file prevents this larger timeout from accepting a half-started worker.
const DAEMON_READY_TIMEOUT_MS = 30_000;

// macOS LaunchServices uses the same readiness contract.
const LAUNCHCTL_GRACE_MS = DAEMON_READY_TIMEOUT_MS;
const LAUNCHD_LABEL_BASE = 'cloud.corelli.kraki';

/**
 * Derive a launchd label scoped to the current KRAKI_HOME.
 * The default home (~/.kraki) gets the base label; any override gets a
 * suffix so multiple instances (e.g. dev-local worktrees) don't collide.
 */
function getLaunchdLabel(): string {
  const home = getKrakiHome();
  const defaultHome = join(homedir(), '.kraki');
  if (resolve(home) === resolve(defaultHome)) return LAUNCHD_LABEL_BASE;
  const suffix = home
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(-60);
  return `${LAUNCHD_LABEL_BASE}.${suffix}`;
}

function getLaunchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${getLaunchdLabel()}.plist`);
}

function unloadLaunchdAgent(): void {
  try {
    execSync(`launchctl unload "${getLaunchdPlistPath()}" 2>/dev/null`, { stdio: 'ignore' });
  } catch { /* not loaded */ }
}

function isLaunchdAgentLoaded(platform = process.platform): boolean {
  if (platform !== 'darwin') return false;
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  try {
    execFileSync('/bin/launchctl', ['print', `gui/${uid}/${getLaunchdLabel()}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

function cleanupLaunchdPlist(): void {
  unloadLaunchdAgent();
  const p = getLaunchdPlistPath();
  if (existsSync(p)) unlinkSync(p);
}
export function hasUntrackedLaunchdDaemon(
  pid: number | null = loadDaemonPid(),
  platform = process.platform,
): boolean {
  return pid === null && isLaunchdAgentLoaded(platform);
}

export function assertNoUntrackedLaunchdDaemon(platform = process.platform): void {
  if (!hasUntrackedLaunchdDaemon(loadDaemonPid(), platform)) return;
  throw new Error(
    'Refusing to start: the launchd job is still loaded but no verified daemon PID is available. ' +
    'Inspect the existing job before removing it; Kraki will not risk starting a duplicate daemon.',
  );
}

export const INTERNAL_DAEMON_WORKER_COMMAND = '__daemon-worker';

export type DaemonProcessIdentity = 'daemon' | 'other' | 'gone' | 'unknown';

/**
 * Verify that a PID still belongs to a Kraki daemon before signalling it.
 *
 * PID files can outlive their process, and operating systems eventually reuse
 * the numeric PID. A liveness probe alone therefore cannot distinguish the real
 * daemon from an unrelated process that inherited the same number. Query the
 * process command line and require Kraki's internal worker marker. Fail closed
 * (`unknown`) when the command cannot be inspected: it is safer to leave a hung
 * daemon for manual diagnosis than to SIGKILL an arbitrary process.
 */
export function inspectDaemonProcess(pid: number): DaemonProcessIdentity {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'unknown' : 'gone';
  }

  try {
    const command = process.platform === 'win32'
      ? execFileSync('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
        ], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      : execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
          encoding: 'utf8',
          timeout: 5000,
        });
    const trimmed = command.trim();
    const marker = INTERNAL_DAEMON_WORKER_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\s)${marker}(?:\\s|$)`).test(trimmed) ? 'daemon' : 'other';
  } catch {
    return 'unknown';
  }
}

export interface DaemonLaunchSpec {
  runtime: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  workerPath: string;
}

export function getDaemonBootstrapLogPath(): string {
  return join(getLogsDir(), 'daemon-bootstrap.log');
}

export function resolveDaemonLaunch(
  cliEntryPath: string | undefined = process.argv[1],
  seaMode = isSea(),
): DaemonLaunchSpec {
  if (seaMode) {
    const {
      COPILOT_SDK_AUTH_TOKEN: _,
      COPILOT_AGENT_SESSION_ID: _2,
      COPILOT_CLI: _3,
      GITHUB_TOKEN: seaInheritedGhToken,
      ...seaCleanEnv
    } = process.env;
    if (seaInheritedGhToken && !seaInheritedGhToken.startsWith('gho_')) {
      seaCleanEnv.GITHUB_TOKEN = seaInheritedGhToken;
    }
    return {
      runtime: process.execPath,
      args: [INTERNAL_DAEMON_WORKER_COMMAND],
      cwd: process.cwd(),
      env: {
        ...seaCleanEnv,
        NODE_ENV: 'production',
      },
      workerPath: process.execPath,
    };
  }

  if (!cliEntryPath) {
    throw new Error('Cannot resolve daemon launch without a CLI entry path');
  }

  const entryPath = resolve(cliEntryPath);
  const moduleDir = dirname(entryPath);
  const isTsSource = entryPath.endsWith('.ts');
  const packageRoot = resolve(moduleDir, '..');
  const workspaceRoot = resolve(packageRoot, '..', '..');

  const binPaths = isTsSource
    ? [join(workspaceRoot, 'node_modules', '.bin'), join(packageRoot, 'node_modules', '.bin')]
    : [join(packageRoot, 'node_modules', '.bin')];

  // Strip Copilot-specific env vars so the daemon's Copilot SDK instance
  // uses its own auth chain instead of inheriting a session-scoped token
  // from a parent Copilot CLI process (which can't be used for models.list).
  const {
    COPILOT_SDK_AUTH_TOKEN: _,
    COPILOT_AGENT_SESSION_ID: _2,
    COPILOT_CLI: _3,
    // GITHUB_TOKEN from a parent Copilot CLI is a session-scoped gho_ token
    // that won't work for a separately spawned copilot process. The daemon's
    // adapter resolves its own token via `gh auth token` or the SDK's creds.
    GITHUB_TOKEN: inheritedGhToken,
    ...cleanEnv
  } = process.env;
  // Only strip GITHUB_TOKEN if it looks session-scoped (gho_ prefix).
  // A real PAT (ghp_) or fine-grained token (github_pat_) should pass through.
  if (inheritedGhToken && !inheritedGhToken.startsWith('gho_')) {
    cleanEnv.GITHUB_TOKEN = inheritedGhToken;
  }

  return {
    runtime: process.execPath,
    args: isTsSource
      ? ['--import', 'tsx', entryPath, INTERNAL_DAEMON_WORKER_COMMAND]
      : [entryPath, INTERNAL_DAEMON_WORKER_COMMAND],
    cwd: isTsSource ? workspaceRoot : packageRoot,
    env: {
      ...cleanEnv,
      NODE_ENV: 'production',
      PATH: [...binPaths, cleanEnv.PATH ?? ''].filter(Boolean).join(delimiter),
    },
    workerPath: entryPath,
  };
}

function waitForDaemonBootstrap(
  child: ChildProcess,
  bootstrapLogPath: string,
  timeoutMs = DAEMON_READY_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let poll: NodeJS.Timeout | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      child.off('error', onError);
      child.off('exit', onExit);
    };

    const onError = (err: Error) => {
      cleanup();
      reject(new Error(`Kraki failed to start: ${err.message}. Check ${bootstrapLogPath}`));
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Kraki exited during startup (code ${code ?? 'null'}, signal ${signal ?? 'none'}). Check ${bootstrapLogPath}`,
        ),
      );
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Kraki did not become ready within ${timeoutMs}ms. Check ${bootstrapLogPath}`));
    }, timeoutMs);

    poll = setInterval(() => {
      if (child.pid && loadDaemonReady() === child.pid) {
        cleanup();
        resolve();
      }
    }, 100);

    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function waitForProcessIdentityToChange(
  pid: number,
  timeoutMs: number,
): Promise<DaemonProcessIdentity> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = inspectDaemonProcess(pid);
    if (identity !== 'daemon') return identity;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return inspectDaemonProcess(pid);
}

async function terminateFailedDaemon(pid: number): Promise<boolean> {
  const initialIdentity = inspectDaemonProcess(pid);
  if (initialIdentity === 'gone' || initialIdentity === 'other') return true;
  if (initialIdentity !== 'daemon') return false;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return true;
  }

  const afterTerm = await waitForProcessIdentityToChange(pid, 5000);
  if (afterTerm === 'gone' || afterTerm === 'other') return true;
  if (afterTerm !== 'daemon') return false;

  // Re-check immediately before escalation to cover PID reuse during the wait.
  if (inspectDaemonProcess(pid) !== 'daemon') return true;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return true;
  }

  const afterKill = await waitForProcessIdentityToChange(pid, 1000);
  return afterKill === 'gone' || afterKill === 'other';
}

// ── Status ──────────────────────────────────────────────

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
}

export function isDaemonRunning(platform = process.platform): boolean {
  const pid = loadDaemonPid();
  if (pid === null) return isLaunchdAgentLoaded(platform);
  const identity = inspectDaemonProcess(pid);
  if (identity === 'gone' || identity === 'other') {
    if (isLaunchdAgentLoaded(platform)) return true;
    clearDaemonPid();
    clearDaemonReady();
    return false;
  }
  // `unknown` means the PID is alive but the OS refused command inspection.
  // Treat it as running to avoid launching a duplicate daemon; stopDaemon()
  // still refuses to signal it until its identity can be established.
  return true;
}

export function getDaemonStatus(platform = process.platform): DaemonStatus {
  const pid = loadDaemonPid();
  if (pid === null) {
    return isLaunchdAgentLoaded(platform)
      ? { running: true, pid: null }
      : { running: false, pid: null };
  }
  const identity = inspectDaemonProcess(pid);
  if (identity === 'gone' || identity === 'other') {
    if (isLaunchdAgentLoaded(platform)) return { running: true, pid: null };
    clearDaemonPid();
    clearDaemonReady();
    return { running: false, pid: null };
  }
  return { running: true, pid };
}

export class DaemonStartupError extends Error {
  constructor(bootstrapLogPath: string) {
    super(
      `Daemon did not become ready within ${LAUNCHCTL_GRACE_MS}ms. ` +
      `Kraki was not started. Check ${bootstrapLogPath}`,
    );
    this.name = 'DaemonStartupError';
  }
}

// ── Start / Stop ────────────────────────────────────────

/**
 * Build the launchd job that starts the daemon.
 *
 * Exported and pure so the launch mechanism is assertable in CI. That matters
 * more than it looks: "TCC permissions reset on every update" was diagnosed and
 * "fixed" six times, and every one of those fixes left the launch mechanism
 * untested, so each regression was invisible until a user hit it again.
 *
 * @param appBundle absolute path to the enclosing .app, or null for a raw binary
 * @param execPath  the daemon executable, used only in the non-bundled fallback
 */
export function buildLaunchdPlist(opts: {
  label: string;
  appBundle: string | null;
  execPath: string;
  bootstrapLogPath: string;
  workingDirectory: string;
  envEntries: [string, string][];
}): string {
  const { label, appBundle, execPath, bootstrapLogPath, workingDirectory, envEntries } = opts;

  // How the daemon is launched decides how TCC identifies it, and that decision
  // is what made Full Disk Access evaporate on every update.
  //
  // launchd `execve()`ing Kraki.app/Contents/MacOS/kraki gives the process NO
  // Launch Services application identity — verified directly: for a bundle
  // launched that way, NSRunningApplication(processIdentifier:) returns nil and
  // `lsappinfo info -only bundleid <pid>` reports NULL, while the same bundle
  // started via `open` resolves to its bundle id. With no bundle identity to key
  // on, TCC falls back to client_type=1 (absolute path) and, since the macOS 11.4
  // fix for CVE-2021-30713, revalidates the binary at that path against the
  // cdhash captured at grant time. Every update writes a new cdhash, so a
  // path-tracked grant cannot survive one.
  //
  // `lsregister -f` does not fix this. It only teaches Launch Services that the
  // bundle exists ON DISK; it has no effect on the runtime identity of a process
  // that was exec'd directly. That is why registering the bundle and clearing
  // zombie LS entries reduced the symptom without ever ending it.
  //
  // Launching through LaunchServices is the fix: `open` gives the process a real
  // bundle identity, so TCC stores the grant against chat.kraki.cli, whose
  // Designated Requirement is cdhash-free and stable across updates.
  //   -W  block for the app's lifetime so launchd still supervises the daemon
  //   -n  always start a fresh instance rather than reactivating a stale one
  // Info.plist flags are irrelevant here: LSBackgroundOnly and LSUIElement both
  // resolve fine under `open`, and neither rescues a path-exec'd process.
  const programArgs: string[] = appBundle
    ? [
        '/usr/bin/open',
        '-W',
        '-n',
        '-a', appBundle,
        '--stdout', bootstrapLogPath,
        '--stderr', bootstrapLogPath,
        // Do not pass `open --env` at all. The app launched by `open` already
        // inherits open's environment, which launchd supplies through the
        // EnvironmentVariables dictionary below. Contrary to the previous
        // implementation's assumption, `open --env NAME` sets NAME to an empty
        // string; it does not copy the existing value. NAME=VALUE would work but
        // would expose tokens and proxy credentials in the long-lived `open -W`
        // argv. Inheriting the launchd environment preserves values without
        // putting secrets on the command line.
        '--args', INTERNAL_DAEMON_WORKER_COMMAND,
      ]
    : [execPath, INTERNAL_DAEMON_WORKER_COMMAND];

  // `open -W` returns 0 even when the app it is waiting on is SIGKILLed, so
  // KeepAlive/SuccessfulExit=false would never fire and a crashed daemon would
  // stay dead. Supervise unconditionally instead, throttled so a bundle that
  // refuses to launch cannot spin. The direct-exec fallback keeps the original
  // exit-code semantics, where they still work.
  const keepAliveXml = appBundle
    ? '    <key>KeepAlive</key>\n    <true/>\n    <key>ThrottleInterval</key>\n    <integer>10</integer>'
    : '    <key>KeepAlive</key>\n    <dict>\n        <key>SuccessfulExit</key>\n        <false/>\n    </dict>';

  const programArgsXml = programArgs
    .map(a => `        <string>${escapeXml(a)}</string>`)
    .join('\n');

  const envXml = envEntries
    .map(([k, v]) => `        <key>${k}</key>\n        <string>${escapeXml(v)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${programArgsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
${keepAliveXml}
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>StandardOutPath</key>
    <string>${escapeXml(bootstrapLogPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(bootstrapLogPath)}</string>
    <key>WorkingDirectory</key>
    <string>${escapeXml(workingDirectory)}</string>
</dict>
</plist>`;
}

/**
 * Start the daemon via launchctl on macOS SEA.
 *
 * launchd spawns the job in a clean context, bypassing CSM restrictions. For a
 * bundled install the job is `open`, which hands the actual launch to
 * LaunchServices so the daemon gets a real bundle identity — see
 * buildLaunchdPlist() for why that is load-bearing.
 *
 * Either way the daemon-worker saves its own PID, so the poll below reads the
 * daemon's PID and not the PID of whatever launched it.
 */
export async function startDaemonLaunchctl(config: KrakiConfig): Promise<number> {
  const logLevel = getLogVerbosity(config) === 'verbose' ? 'debug' : 'info';
  const bootstrapLogPath = getDaemonBootstrapLogPath();
  mkdirSync(dirname(bootstrapLogPath), { recursive: true });

  const plistDir = join(homedir(), 'Library', 'LaunchAgents');
  mkdirSync(plistDir, { recursive: true });

  // Build PATH that includes locations for `gh` and other tools
  const pathParts = new Set((process.env.PATH ?? '').split(':'));
  for (const p of ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']) pathParts.add(p);

  const envEntries: [string, string][] = [
    ['NODE_ENV', 'production'],
    ['LOG_LEVEL', logLevel],
    ['PATH', [...pathParts].filter(Boolean).join(':')],
    ['HOME', homedir()],
  ];
  if (process.env.KRAKI_RELAY_URL) envEntries.push(['KRAKI_RELAY_URL', process.env.KRAKI_RELAY_URL]);

  // Forward proxy and GitHub auth variables so the daemon keeps the same
  // credential behavior as before. Values live only in launchd's
  // EnvironmentVariables dictionary; `open` and the app it launches inherit
  // them without exposing them in the long-lived command line.
  const forwardVars = [
    'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy',
    'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
    'GITHUB_TOKEN', 'GH_TOKEN',
  ];
  for (const key of forwardVars) {
    if (process.env[key]) envEntries.push([key, process.env[key]!]);
  }

  const appBundle = getKrakiAppBundlePath();
  const plist = buildLaunchdPlist({
    label: getLaunchdLabel(),
    appBundle,
    execPath: process.execPath,
    bootstrapLogPath,
    workingDirectory: homedir(),
    envEntries,
  });

  const plistPath = getLaunchdPlistPath();
  clearDaemonReady();
  writeFileSync(plistPath, plist, { mode: 0o600 });
  chmodSync(plistPath, 0o600);
  unloadLaunchdAgent();
  execSync(`launchctl load "${plistPath}"`, { stdio: 'ignore' });

  // The daemon-worker writes its own PID on startup. Poll for it.
  const deadline = Date.now() + LAUNCHCTL_GRACE_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    const pid = loadDaemonPid();
    if (pid !== null) {
      try {
        process.kill(pid, 0);
      } catch {
        // PID saved but process already dead → startup crash / CSM block.
        break;
      }

      // A PID file is written at the beginning of worker startup, before all
      // imports and adapters have finished initializing. Do not report success
      // merely because that early PID is alive: the process can still crash a
      // moment later (the v0.31.8 `open --env NAME` regression did exactly
      // this). Require the real worker marker, and for a bundled install require
      // the Launch Services identity that makes the TCC fix meaningful.
      const readinessPublished = loadDaemonReady() === pid;
      if (!readinessPublished) continue;

      const workerReady = inspectDaemonProcess(pid) === 'daemon';
      const launchServicesReady = appBundle === null || getProcessBundleIdentity(pid) === KRAKI_BUNDLE_ID;
      if (workerReady && launchServicesReady) return pid;
    }
  }

  // Daemon did not become ready. Inspect before removing supervision. If the OS
  // refuses process inspection, fail closed: keep the launchd job and PID files
  // intact so a potentially real daemon remains supervised and a later command
  // cannot start a duplicate beside it.
  const failedPid = loadDaemonPid();
  const failedIdentity = failedPid === null ? 'gone' : inspectDaemonProcess(failedPid);
  if (failedPid === null || failedIdentity !== 'daemon') {
    // Without a verified worker PID, unloading `open -W` could leave its
    // LaunchServices-owned child alive and unsupervised. Preserve the loaded job
    // and state so later commands refuse to start a duplicate. If launchctl says
    // the job is already gone, stale files are safe to clean.
    if (isLaunchdAgentLoaded('darwin')) {
      throw new DaemonStartupError(bootstrapLogPath);
    }
    cleanupLaunchdPlist();
    clearDaemonPid();
    clearDaemonReady();
    throw new DaemonStartupError(bootstrapLogPath);
  }

  cleanupLaunchdPlist();
  const terminated = await terminateFailedDaemon(failedPid);
  if (!terminated) throw new DaemonStartupError(bootstrapLogPath);
  clearDaemonPid();
  clearDaemonReady();
  throw new DaemonStartupError(bootstrapLogPath);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function startDaemon(config: KrakiConfig, cliEntryPath?: string): Promise<number> {
  stopDaemon();
  assertNoUntrackedLaunchdDaemon();
  // An alive PID whose identity could not be verified is deliberately left in
  // place by stopDaemon(). Do not start a second daemon beside it.
  if (loadDaemonPid() !== null) {
    throw new Error('Refusing to start: the recorded daemon PID is alive but could not be verified. Remove the stale daemon.pid only after checking the process.');
  }
  clearDaemonReady();

  // On macOS SEA, use launchctl so launchd spawns the daemon in a clean
  // context that isn't blocked by CSM provenance tracking.
  if (process.platform === 'darwin' && isSea()) {
    return startDaemonLaunchctl(config);
  }

  const launch = resolveDaemonLaunch(cliEntryPath);
  launch.env.LOG_LEVEL = getLogVerbosity(config) === 'verbose' ? 'debug' : 'info';
  const bootstrapLogPath = getDaemonBootstrapLogPath();
  mkdirSync(dirname(bootstrapLogPath), { recursive: true });
  const bootstrapFd = openSync(bootstrapLogPath, 'w');

  const child = spawn(launch.runtime, launch.args, {
    detached: true,
    stdio: ['ignore', bootstrapFd, bootstrapFd],
    cwd: launch.cwd,
    env: launch.env,
  });

  closeSync(bootstrapFd);

  if (!child.pid) {
    throw new Error(`Kraki failed to start: no daemon PID returned. Check ${bootstrapLogPath}`);
  }

  try {
    await waitForDaemonBootstrap(child, bootstrapLogPath);
  } catch (err) {
    const terminated = await terminateFailedDaemon(child.pid);
    if (!terminated) {
      saveDaemonPid(child.pid);
      throw new Error(
        `Kraki failed to become ready and the background worker could not be safely terminated. ` +
        `PID ${child.pid} remains recorded for manual diagnosis. Check ${bootstrapLogPath}`,
      );
    }
    clearDaemonPid();
    clearDaemonReady();
    throw err;
  }

  child.unref();
  saveDaemonPid(child.pid);
  return child.pid;
}

export function stopDaemon(platform = process.platform): boolean {
  const pid = loadDaemonPid();
  if (pid === null) {
    // A loaded launchd job without a PID is ambiguous: LaunchServices may still
    // own a child process that cannot be safely identified. Fail closed and
    // preserve supervision rather than unloading the job and risking a duplicate
    // daemon on the next start. Only remove a stale plist when launchctl confirms
    // the job itself is not loaded.
    if (hasUntrackedLaunchdDaemon(pid, platform)) return false;
    if (platform === 'darwin') cleanupLaunchdPlist();
    clearDaemonReady();
    return false;
  }

  // Establish identity BEFORE unloading supervision. If process inspection is
  // unavailable, fail closed and leave both the process and its launchd job
  // untouched rather than stranding a real daemon unsupervised.
  const identity = inspectDaemonProcess(pid);
  if (identity === 'unknown') return false;
  if ((identity === 'gone' || identity === 'other') && isLaunchdAgentLoaded(platform)) {
    return false;
  }

  // Unload the launchd job BEFORE signalling a verified daemon. The bundled macOS job
  // runs with KeepAlive=true (see startDaemonLaunchctl), so killing first would
  // let launchd restart the daemon in the window before the job is unloaded and
  // `kraki stop` would appear to do nothing.
  //
  // Unloading is no longer sufficient on its own, either. The job is now `open`,
  // and the daemon it launches belongs to LaunchServices rather than to launchd
  // — verified: after `launchctl unload` the daemon is still running. Before, the
  // daemon WAS the job process and the unload killed it. So the PID-based signal
  // below is now the only thing that actually stops the daemon, and it has to
  // succeed.
  if (platform === 'darwin') cleanupLaunchdPlist();

  if (identity === 'gone' || identity === 'other') {
    // Stale/reused PID: clean the record but never signal the process currently
    // holding that number.
    clearDaemonPid();
    clearDaemonReady();
    return true;
  }

  const alive = () => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process already gone.
    clearDaemonPid();
    clearDaemonReady();
    return true;
  }

  // Escalate if it ignores SIGTERM. Only ever targets the PID recorded under
  // THIS Kraki home, so a dev instance can never take down the global daemon
  // (the reason the launchd label is KRAKI_HOME-scoped in the first place) —
  // which is also why there is deliberately no pkill-by-name fallback here: with
  // no PID file there is no way to tell whose daemon a process is.
  // 5s: the daemon's SIGTERM handler disconnects the relay and stops the
  // adapter before exiting, so cutting it off too early truncates a real
  // shutdown. It exits well inside this window when healthy, so `kraki stop`
  // still returns promptly.
  const deadline = Date.now() + 5000;
  const idle = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline && alive()) {
    Atomics.wait(idle, 0, 0, 100);   // synchronous sleep; spawns nothing
  }
  if (alive()) {
    // Re-check immediately before escalation. The daemon may have exited and
    // its numeric PID may already have been reused during the grace window.
    const finalIdentity = inspectDaemonProcess(pid);
    if (finalIdentity === 'daemon') {
      try { process.kill(pid, 'SIGKILL'); } catch { /* raced us to exit */ }

      const killDeadline = Date.now() + 1000;
      while (Date.now() < killDeadline) {
        const afterKill = inspectDaemonProcess(pid);
        if (afterKill === 'gone' || afterKill === 'other') break;
        if (afterKill === 'unknown') return false;
        Atomics.wait(idle, 0, 0, 50);
      }
      if (inspectDaemonProcess(pid) === 'daemon') return false;
    } else if (finalIdentity === 'unknown') {
      return false;
    }
  }

  clearDaemonPid();
  clearDaemonReady();
  return true;
}
