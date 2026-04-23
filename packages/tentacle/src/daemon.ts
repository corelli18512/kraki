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
 * independent context. If launchctl also fails, the caller falls back
 * to running the daemon worker in the current process.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { delimiter, join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isSea } from 'node:sea';

import {
  getLogsDir,
  getLogVerbosity,
  type KrakiConfig,
  saveDaemonPid,
  loadDaemonPid,
  clearDaemonPid,
} from './config.js';

const STARTUP_GRACE_MS = 1500;
const LAUNCHD_LABEL = 'cloud.corelli.kraki';

function getLaunchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function unloadLaunchdAgent(): void {
  try {
    execSync(`launchctl unload "${getLaunchdPlistPath()}" 2>/dev/null`, { stdio: 'ignore' });
  } catch { /* not loaded */ }
}

function cleanupLaunchdPlist(): void {
  unloadLaunchdAgent();
  const p = getLaunchdPlistPath();
  if (existsSync(p)) unlinkSync(p);
}
export const INTERNAL_DAEMON_WORKER_COMMAND = '__daemon-worker';

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
    return {
      runtime: process.execPath,
      args: [INTERNAL_DAEMON_WORKER_COMMAND],
      cwd: process.cwd(),
      env: {
        ...process.env,
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

  return {
    runtime: process.execPath,
    args: isTsSource
      ? ['--import', 'tsx', entryPath, INTERNAL_DAEMON_WORKER_COMMAND]
      : [entryPath, INTERNAL_DAEMON_WORKER_COMMAND],
    cwd: isTsSource ? workspaceRoot : packageRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PATH: [...binPaths, process.env.PATH ?? ''].filter(Boolean).join(delimiter),
    },
    workerPath: entryPath,
  };
}

function waitForDaemonBootstrap(
  child: ChildProcess,
  bootstrapLogPath: string,
  timeoutMs = STARTUP_GRACE_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
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
      resolve();
    }, timeoutMs);

    child.once('error', onError);
    child.once('exit', onExit);
  });
}

// ── Status ──────────────────────────────────────────────

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
}

export function isDaemonRunning(): boolean {
  const pid = loadDaemonPid();
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist — stale PID file
    clearDaemonPid();
    return false;
  }
}

export function getDaemonStatus(): DaemonStatus {
  const pid = loadDaemonPid();
  if (pid === null) return { running: false, pid: null };

  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    clearDaemonPid();
    return { running: false, pid: null };
  }
}

export class MacOSCodeSignatureError extends Error {
  constructor(bootstrapLogPath: string) {
    super(
      `macOS blocked the daemon process (code signature provenance). ` +
      `Falling back to in-process daemon. Check ${bootstrapLogPath}`,
    );
    this.name = 'MacOSCodeSignatureError';
  }
}

// ── Start / Stop ────────────────────────────────────────

/**
 * Start the daemon via launchctl on macOS SEA.
 * launchd spawns the process in a clean context, bypassing CSM restrictions.
 * The daemon-worker saves its own PID; we poll for it here.
 */
async function startDaemonLaunchctl(config: KrakiConfig): Promise<number> {
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

  // Forward proxy and other relevant env vars so the daemon can reach
  // external services (e.g. Copilot API behind a proxy).
  const forwardVars = [
    'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy',
    'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
    'GITHUB_TOKEN', 'GH_TOKEN',
  ];
  for (const key of forwardVars) {
    if (process.env[key]) envEntries.push([key, process.env[key]!]);
  }

  const envXml = envEntries
    .map(([k, v]) => `        <key>${k}</key>\n        <string>${escapeXml(v)}</string>`)
    .join('\n');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(process.execPath)}</string>
        <string>${INTERNAL_DAEMON_WORKER_COMMAND}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>StandardOutPath</key>
    <string>${escapeXml(bootstrapLogPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(bootstrapLogPath)}</string>
    <key>WorkingDirectory</key>
    <string>${escapeXml(homedir())}</string>
</dict>
</plist>`;

  const plistPath = getLaunchdPlistPath();
  writeFileSync(plistPath, plist);
  unloadLaunchdAgent();
  execSync(`launchctl load "${plistPath}"`, { stdio: 'ignore' });

  // The daemon-worker writes its own PID on startup. Poll for it.
  const deadline = Date.now() + STARTUP_GRACE_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    const pid = loadDaemonPid();
    if (pid !== null) {
      try {
        process.kill(pid, 0);
        return pid;
      } catch {
        // PID saved but process already dead → CSM or crash
        break;
      }
    }
  }

  // Daemon didn't start or died immediately
  cleanupLaunchdPlist();
  throw new MacOSCodeSignatureError(bootstrapLogPath);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function startDaemon(config: KrakiConfig, cliEntryPath?: string): Promise<number> {
  stopDaemon();

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
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      // Child may already be gone
    }
    throw err;
  }

  child.unref();
  saveDaemonPid(child.pid);
  return child.pid;
}

export function stopDaemon(): boolean {
  const pid = loadDaemonPid();
  if (pid !== null) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process already gone
    }
    clearDaemonPid();
  }

  // On macOS, also clean up launchd agent
  if (process.platform === 'darwin') cleanupLaunchdPlist();

  return pid !== null;
}
