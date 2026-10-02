#!/usr/bin/env node

/**
 * Kraki CLI entry point.
 *
 * Usage:
 *   kraki              Start Kraki (runs setup first if needed)
 *   kraki stop          Stop Kraki
 *   kraki status        Show status
 *   kraki logs [-f]     Tail log files
 *   kraki config        Print current config
 *   kraki config reset  Delete config and re-run setup
 *   kraki --help        Show help
 *   kraki --version     Show version
 */

import { launchedFromExplorer } from './windows-console.js';
import chalk from 'chalk';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { select } from '@inquirer/prompts';

import { loadConfig, saveConfig, getConfigPath, getKrakiHome, getLogVerbosity, getVersion, loadChannelKey, type KrakiConfig } from './config.js';
import { getCliLaunchdJobState, INTERNAL_DAEMON_WORKER_COMMAND, INTERNAL_DAEMON_SMOKE_COMMAND, prepareDaemonWorkerBootstrap, isDaemonRunning, getDaemonStatus, startDaemon, runDaemonReleaseSmoke, stopDaemon } from './daemon.js';
import { runSetup } from './setup.js';
import { requestPairingToken, buildPairingUrl, renderQrToTerminal } from './pair.js';
import { printStaticBanner } from './banner.js';
import { disableWindowsAutostart } from './windows-autostart.js';
import { readStatusFile } from './status-file.js';
import { ensureWindowsSystemPath } from './checks.js';
import type { AgentId } from '@kraki/protocol';
import { SELF_MANAGEMENT_DENIAL_REASON } from './self-management-guard.js';
import { loadManagedBy, kickstartManagedDaemon, isManagedDaemonLoaded, type ManagedByMarker } from './managed.js';

// Self-heal PATH on Windows BEFORE any setup/check spawns a child
// process. If kraki is launched from a context with a minimal PATH
// (e.g. double-clicked SEA binary), tools like `gh`, `copilot`, and
// `powershell.exe` would otherwise be invisible. The daemon worker
// re-runs this on its side as a belt-and-suspenders for autostart
// paths that bypass the CLI entirely.
ensureWindowsSystemPath();

// Detect Node.js SEA (Single Executable Application)
const _isSEA = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();

// Double-clicked kraki.exe gets its own console that closes on exit, hiding
// the output; pause there. Run from a terminal (cmd, PowerShell, Windows
// Terminal) it must not wait for a key.
let _doubleClickCache: boolean | undefined;
function _isWindowsDoubleClick(): boolean {
  if (_doubleClickCache === undefined) {
    _doubleClickCache = process.platform === 'win32' && _isSEA && !!process.stdin.isTTY
      && launchedFromExplorer(process.env, process.ppid);
  }
  return _doubleClickCache === true;
}

// Graceful exit: on Windows SEA, avoid process.exit() after async work.
// Instead, schedule exit and let libuv drain.
function gracefulExit(code: number): void {
  if (_isWindowsDoubleClick()) {
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin });
    process.stdout.write('\nPress any key to exit...');
    process.stdin.setRawMode?.(true);
    process.stdin.once('data', () => process.exit(code));
    return;
  }
  process.exit(code);
}

// ── Help ────────────────────────────────────────────────

function printHelp(): void {
  printStaticBanner();
  const cmd = (c: string, d: string) => `    ${chalk.bold(c.padEnd(20))} ${d}`;
  const head = (t: string) => `  ${chalk.hex('#2384d4').bold(t)}`;
  console.log([
    head('Get started'),
    cmd('kraki', 'Set up this computer and start Kraki'),
    cmd('kraki connect', 'Show a QR code to connect your phone'),
    '',
    head('Everyday'),
    cmd('kraki status', 'Is Kraki running and connected?'),
    cmd('kraki agents', 'Check the coding agents on this computer'),
    cmd('kraki logs [-f]', 'Show logs (-f to follow)'),
    cmd('kraki start', 'Start Kraki in the background'),
    cmd('kraki stop', 'Stop Kraki'),
    cmd('kraki restart', 'Restart Kraki (e.g. after installing an agent)'),
    cmd('kraki update', 'Install the latest version'),
    '',
    head('Settings'),
    cmd('kraki config', 'Print the current config'),
    cmd('kraki config log <normal|verbose>', ''),
    cmd('', 'Set log detail for the next start'),
    cmd('kraki config reset', 'Delete the config and set up again'),
    cmd('kraki permissions', 'macOS privacy status (--open to open the panes)'),
    '',
    `${chalk.dim('  For apps and scripts: setup --json | --headless [--agent …], connect --json | --url-only,')}`,
    `${chalk.dim('  status --json, agents --json, doctor, fda --json | --watch, resolve-relay --json')}`,
    '',
    ...(process.platform === 'darwin'
      ? [`${chalk.dim('  Prefer an app? Kraki for Mac does all this without the CLI:')}`,
        `${chalk.dim('  https://github.com/corelli18512/kraki/releases?q=mac-v')}`, '']
      : []),
  ].join('\n'));
}

// ── Commands ────────────────────────────────────────────

// ── Ownership: Kraki for Mac vs. standalone CLI ─────────
//
// When Kraki for Mac supervises the daemon (managed-by.json, see managed.ts),
// this CLI must never install its own launchd job or signal the daemon: the
// app's job has KeepAlive, so a SIGTERM would just be followed by a respawn,
// and a second job would run two daemons with one device id.

/** True when this executable is the helper embedded inside Kraki for Mac. */
export function isEmbeddedMacHelper(execPath = process.execPath): boolean {
  return /\.app\/Contents\/Library\/Helpers\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/.test(execPath);
}

function printManagedNotice(managed: ManagedByMarker): void {
  const status = getDaemonStatus();
  if (status.running) {
    console.log(chalk.green(`  🦑 Kraki is running${status.pid ? ` (PID ${status.pid})` : ''}, managed by Kraki for Mac.`));
  } else {
    console.log(chalk.yellow('  Kraki is managed by Kraki for Mac and is not running right now.'));
  }
  if (managed.appPath) console.log(chalk.dim(`  App: ${managed.appPath}`));
}

function refuseManaged(action: 'start' | 'stop' | 'update' | 'setup', managed: ManagedByMarker): void {
  printManagedNotice(managed);
  const hint: Record<typeof action, string> = {
    start: 'Open Kraki for Mac to start it (Settings → This Mac).',
    stop: 'Stop it from Kraki for Mac (Settings → This Mac) or turn Kraki off in System Settings → General → Login Items.',
    update: 'Kraki for Mac updates its built-in tentacle together with the app (Kraki → Check for Updates…).',
    setup: 'Reconfigure from Kraki for Mac, or switch it to "Use external CLI" in Settings → This Mac first.',
  };
  console.log(chalk.dim(`  ${hint[action]}`));
  process.exitCode = 1;
}

function refuseEmbeddedHelper(): void {
  console.log(chalk.yellow('  This kraki binary is the tentacle built into Kraki for Mac.'));
  console.log(chalk.dim('  Open Kraki for Mac to set it up and run it in the background.'));
  process.exitCode = 1;
}

async function restartManaged(managed: ManagedByMarker): Promise<void> {
  if (!isManagedDaemonLoaded(managed.label)) {
    refuseManaged('start', managed);
    return;
  }
  const before = getDaemonStatus().pid;
  if (!kickstartManagedDaemon(managed.label)) {
    console.log(chalk.red('  Failed to restart the Kraki for Mac background service.'));
    process.exitCode = 1;
    return;
  }
  const { loadDaemonReady } = await import('./config.js');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = loadDaemonReady();
    if (ready !== null && ready !== before) {
      console.log(chalk.green(`  🦑 Kraki restarted (PID ${ready}), managed by Kraki for Mac.`));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log(chalk.yellow('  Restart requested; the daemon has not reported ready yet. Check `kraki logs`.'));
}

// ── kraki (default) — setup wizard + auto start ─────────

async function cmdDefault(): Promise<void> {
  let config = loadConfig();

  const managed = loadManagedBy();
  if (managed) {
    printManagedNotice(managed);
    if (config && getDaemonStatus().running) {
      const { showPairingQr } = await import('./setup.js');
      await showPairingQr(config);
    }
    return;
  }
  if (isEmbeddedMacHelper()) {
    refuseEmbeddedHelper();
    return;
  }

  // Quick update check (blocks up to 2s, uses cache if available)
  const { checkForUpdate } = await import('./update.js');
  const currentVersion = getVersion();
  const updateAvailable = await checkForUpdate(currentVersion);
  if (updateAvailable) {
    console.log(chalk.cyan(`  ⬆  Update available: ${currentVersion} → ${updateAvailable}`) + chalk.dim('  (run `kraki update`)'));
    console.log();
  }

  if (config) {
    if (isDaemonRunning()) {
      const status = getDaemonStatus();
      console.log(chalk.green(`  🦑 Kraki is already running (PID ${status.pid})`));
      console.log();

      const action = await select({
        message: 'What do you want to do?',
        theme: {
          prefix: { idle: chalk.blue('  ?'), done: chalk.green('  ✔') },
          icon: { cursor: '  ❯' },
        },
        choices: [
          { name: '  Show pairing QR', value: 'qr' },
          { name: '  Check coding agents', value: 'agents' },
          { name: '  Stop', value: 'stop' },
          { name: '  Restart', value: 'restart' },
          { name: '  Clean restart (reconfigure)', value: 'reconfig' },
        ],
      });

      switch (action) {
        case 'qr': {
          const { showPairingQr } = await import('./setup.js');
          await showPairingQr(config);
          break;
        }
        case 'agents': {
          const { printAgentsCheck } = await import('./setup.js');
          await printAgentsCheck();
          break;
        }
        case 'stop':
          cmdStop();
          break;
        case 'restart':
          cmdStop();
          await silentStart(config);
          break;
        case 'reconfig':
          cmdStop();
          const { rmSync } = await import('node:fs');
          try { rmSync(getKrakiHome(), { recursive: true, force: true }); } catch { /* ignore */ }
          config = await runSetup();
          await silentStart(config);
          break;
      }
      return;
    }

    // Config exists but daemon not running — ask what to do
    const action = await select({
      message: 'Found previous config. What do you want to do?',
      theme: {
        prefix: { idle: chalk.blue('  ?'), done: chalk.green('  ✔') },
        icon: { cursor: '  ❯' },
      },
      choices: [
        { name: '  Start with existing config', value: 'start' },
        { name: '  Reconfigure', value: 'reconfig' },
      ],
    });

    if (action === 'reconfig') {
      const { rmSync } = await import('node:fs');
      try { rmSync(getKrakiHome(), { recursive: true, force: true }); } catch { /* ignore */ }
      config = await runSetup();
    }
  } else {
    // No config — first time setup
    config = await runSetup();
  }

  // Start daemon
  await silentStart(config);
}

// ── kraki start — silent start from config ──────────────

async function cmdStart(atLogin = false): Promise<void> {
  let config = loadConfig();

  // Windows login autostart: no prompts and no output, just start if needed.
  if (atLogin) {
    if (!config || isDaemonRunning() || loadManagedBy()) return;
    await startDaemon(config);
    return;
  }

  if (!config) {
    const { confirm } = await import('@inquirer/prompts');
    const setup = await confirm({ message: 'No config found. Set up now?', default: true });
    if (!setup) return;
    config = await runSetup();
  }

  if (isDaemonRunning()) {
    const status = getDaemonStatus();
    console.log(chalk.green(`  🦑 Kraki is already running (PID ${status.pid})`));
    return;
  }

  await silentStart(config);
}

// ── Shared start logic ──────────────────────────────────

async function silentStart(config: KrakiConfig): Promise<void> {
  const managed = loadManagedBy();
  if (managed) {
    if (!getDaemonStatus().running) refuseManaged('start', managed);
    else printManagedNotice(managed);
    return;
  }
  if (isEmbeddedMacHelper()) {
    refuseEmbeddedHelper();
    return;
  }

  // In install mode, finish configuration but leave startup to the install
  // script's subsequent `kraki start`. That command uses the normal background
  // daemon manager and shows the pairing QR only after readiness succeeds.
  if (process.env.KRAKI_INSTALL === '1') {
    return;
  }

  const pid = await startDaemon(config);
  console.log('');
  console.log(`  ${chalk.green('✔')} ${chalk.bold('Kraki is running')} ${chalk.dim(`in the background (PID ${pid})${process.platform === 'darwin' ? ' and starts again when you log in' : ''}.`)}`);
  console.log('');
  console.log(`  ${chalk.hex('#2384d4').bold('Use it from your phone')}`);

  // Show pairing QR code
  const { showPairingQr } = await import('./setup.js');
  await showPairingQr(config);

  console.log(chalk.dim(`  ${chalk.bold('kraki status')} to check on it, ${chalk.bold('kraki agents')} to recheck agents, ${chalk.bold('kraki --help')} for more.`));
  console.log('');
}

function cmdStop(): void {
  const managed = loadManagedBy();
  if (managed) {
    refuseManaged('stop', managed);
    return;
  }
  // Stopped on purpose: don't come back at the next Windows login either.
  disableWindowsAutostart();
  if (!isDaemonRunning()) {
    console.log(chalk.yellow('Kraki is not running.'));
    return;
  }

  const stopped = stopDaemon();
  if (stopped) {
    console.log(`  ${chalk.green('✔')} Kraki stopped.`);
  } else {
    console.log(chalk.red('Failed to stop.'));
  }
}

async function waitForPidExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function cmdRestart(): Promise<void> {
  const managed = loadManagedBy();
  if (managed) {
    await restartManaged(managed);
    return;
  }
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('Cannot restart Kraki: no config found. Run `kraki` to set up first.'));
    return;
  }

  const status = getDaemonStatus();
  if (status.running && status.pid !== null) {
    stopDaemon();
    await waitForPidExit(status.pid);
  }
  await silentStart(config);
}

function cmdStatus(jsonOutput = false): void {
  const status = getDaemonStatus();
  const config = loadConfig();
  const statusFile = readStatusFile();

  if (jsonOutput) {
    const managed = loadManagedBy();
    const cliJob = getCliLaunchdJobState();
    // Machine-readable for desktop apps (mac toolbar, etc.). Schema is
    // additive — only add fields, never remove, to keep older clients
    // working.
    const payload = {
      ok: true,
      version: getVersion(),
      daemon: {
        running: status.running,
        pid: status.pid,
        // Additive fields for Kraki for Mac's onboarding and ownership logic.
        owner: managed ? 'kraki-mac' : (cliJob.plistExists ? 'cli' : null),
        managedLabel: managed?.label ?? null,
        cliLaunchdJob: cliJob,
        relayState: status.running ? (statusFile?.relayState ?? null) : null,
        daemonVersion: status.running ? (statusFile?.version ?? null) : null,
        fda: status.running ? (statusFile?.fda ?? null) : null,
        fdaCheckedAt: status.running ? (statusFile?.fdaCheckedAt ?? null) : null,
      },
      config: config
        ? {
            exists: true,
            relay: config.relay,
            authMethod: config.authMethod,
            device: { name: config.device.name, id: config.device.id },
            agents: config.agents ?? null,
            region: statusFile?.region ?? null,
            logVerbosity: getLogVerbosity(config),
          }
        : { exists: false },
    };
    process.stdout.write(JSON.stringify(payload) + '\n');
    return;
  }

  console.log('');
  console.log(`  ${chalk.hex('#2384d4').bold('Kraki')} ${chalk.dim(getVersion())}`);
  console.log('');

  const managedBy = loadManagedBy();
  const owner = managedBy ? ', managed by Kraki for Mac' : '';
  if (status.running) {
    const relay = statusFile?.relayState;
    const link = relay === 'connected' ? chalk.green(', connected')
      : relay ? chalk.yellow(`, ${relay}`) : '';
    console.log(`  Status:  ${chalk.green('running')}${link} ${chalk.dim(`(PID ${status.pid}${owner})`)}`);
    const daemonVersion = statusFile?.version;
    if (daemonVersion && daemonVersion !== getVersion()) {
      console.log(chalk.yellow(`  Running: ${daemonVersion} (installed ${getVersion()}; run \`kraki restart\` to switch)`));
    }
  } else {
    console.log(`  Status:  ${chalk.yellow('stopped')}${owner}`);
  }

  if (config) {
    console.log(`  Relay:   ${chalk.cyan(config.relay)}`);
    console.log(`  Auth:    ${config.authMethod}`);
    console.log(`  Device:  ${config.device.name}`);
    if (statusFile?.region) {
      console.log(`  Region:  ${statusFile.region}`);
    }
    console.log(`  Logs:    ${getLogVerbosity(config)}`);
  } else {
    console.log(chalk.dim('  No config found. Run `kraki` to set up.'));
  }

  console.log('');
}

/** `tail -n 50 [-f] *.log` without `tail`: last lines of each log, then
 *  (with follow) print whatever is appended, polling once a second. */
export function tailLogsPortable(logDir: string, follow: boolean, lines = 50): void {
  const files = () => readdirSync(logDir).filter((f) => f.endsWith('.log')).map((f) => join(logDir, f));
  const sizes = new Map<string, number>();
  for (const file of files().sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)) {
    const text = readFileSync(file, 'utf8');
    sizes.set(file, Buffer.byteLength(text));
    const tail = text.split(/\r?\n/).filter(Boolean).slice(-lines);
    if (tail.length === 0) continue;
    console.log(chalk.dim(`==> ${file} <==`));
    console.log(tail.join('\n'));
  }
  if (!follow) return;
  let last: string | undefined;
  setInterval(() => {
    for (const file of files()) {
      let size: number;
      try { size = statSync(file).size; } catch { continue; }
      const prev = sizes.get(file) ?? 0;
      if (size === prev) continue;
      const buf = readFileSync(file);
      const chunk = buf.subarray(size < prev ? 0 : prev).toString('utf8');
      sizes.set(file, size);
      if (!chunk.trim()) continue;
      if (last !== file) { console.log(chalk.dim(`==> ${file} <==`)); last = file; }
      process.stdout.write(chunk.endsWith('\n') ? chunk : `${chunk}\n`);
    }
  }, 1000);
}

function cmdLogs(follow: boolean): void {
  const logDir = join(getKrakiHome(), 'logs');

  if (!existsSync(logDir)) {
    console.log(chalk.yellow(`No log directory found at ${logDir}`));
    return;
  }

  if (process.platform === 'win32') {
    // No `tail` on Windows.
    tailLogsPortable(logDir, follow);
    return;
  }

  const args = follow
    ? ['-f', join(logDir, '*.log')]
    : ['-n', '50', join(logDir, '*.log')];

  const child = spawn('tail', args, {
    stdio: 'inherit',
    shell: true,
  });

  child.on('error', () => {
    console.log(chalk.red('Failed to tail logs.'));
  });
}

function cmdConfig(): void {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.yellow('No config found. Run `kraki` to set up.'));
    return;
  }
  console.log(JSON.stringify(config, null, 2));
}

function cmdConfigLog(verbosity?: string): void {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.yellow('No config found. Run `kraki` to set up.'));
    return;
  }

  if (!verbosity) {
    console.log(`Log verbosity: ${getLogVerbosity(config)}`);
    return;
  }

  if (verbosity !== 'normal' && verbosity !== 'verbose') {
    console.log(chalk.red(`Invalid log verbosity: ${verbosity}`));
    console.log(chalk.dim('Use `kraki config log normal` or `kraki config log verbose`.'));
    gracefulExit(1);
    return;
  }

  saveConfig({
    ...config,
    logging: { verbosity },
  });
  console.log(chalk.green(`Log verbosity set to ${verbosity}.`));
  console.log(chalk.dim('Restart Kraki to apply the new log level.'));
}

async function cmdConfigReset(): Promise<void> {
  const configPath = getConfigPath();
  try {
    unlinkSync(configPath);
    console.log(chalk.dim('Config deleted.'));
  } catch {
    // Config may not exist
  }
  await runSetup();
  const managed = loadManagedBy();
  if (managed) await restartManaged(managed);
}

async function cmdConnect(urlOnly = false, jsonOutput = false): Promise<void> {
  let config = loadConfig();

  if (!isDaemonRunning()) {
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ ok: false, error: 'daemon_not_running' }) + '\n');
      gracefulExit(1);
      return;
    }
    if (urlOnly) {
      process.stderr.write('error: daemon not running\n');
      gracefulExit(1);
      return;
    }
    const { confirm } = await import('@inquirer/prompts');
    const start = await confirm({ message: 'Kraki is not running. Start now?', default: true });
    if (!start) return;

    if (!config) {
      config = await runSetup();
    }
    await silentStart(config);
    return; // silentStart already shows QR
  }

  if (!config) {
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ ok: false, error: 'no_config' }) + '\n');
      gracefulExit(1);
      return;
    }
    if (urlOnly) {
      process.stderr.write('error: no config found\n');
      gracefulExit(1);
      return;
    }
    console.log(chalk.red('No config found. Run `kraki` to set up.'));
    return;
  }

  if (!urlOnly && !jsonOutput) {
    console.log(chalk.dim('  Requesting pairing token from relay...'));
  }

  try {
    const { relayAuthToken } = await import('./setup.js');
    const token = await relayAuthToken(config, !urlOnly && !jsonOutput);

    const info = await requestPairingToken(config.relay, token);
    const pairingUrl = buildPairingUrl(info);

    if (jsonOutput) {
      const payload = {
        ok: true,
        url: pairingUrl,
        token: info.pairingToken,
        relay: info.relay,
        publicKey: info.publicKey ?? null,
        expiresInSeconds: info.expiresIn,
        expiresAt: new Date(Date.now() + info.expiresIn * 1000).toISOString(),
      };
      process.stdout.write(JSON.stringify(payload) + '\n');
      return;
    }

    if (urlOnly) {
      // Machine-readable output for the desktop toolbar — just the URL, no decoration
      process.stdout.write(pairingUrl + '\n');
      return;
    }

    const qr = await renderQrToTerminal(pairingUrl);
    console.log(qr);
  } catch (err) {
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ ok: false, error: (err as Error).message }) + '\n');
      gracefulExit(1);
      return;
    }
    if (urlOnly) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      gracefulExit(1);
      return;
    }
    console.log(chalk.red(`  Failed to create pairing token: ${(err as Error).message}`));
  }
}

// ── kraki setup --headless — non-interactive setup ──────

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function cmdSetupHeadless(args: string[]): Promise<void> {
  const fail = (code: string, message: string): void => {
    process.stdout.write(JSON.stringify({ ok: false, error: message, code }) + '\n');
    gracefulExit(1);
  };

  const relay = getArgValue(args, '--relay');
  const auth = getArgValue(args, '--auth') ?? 'github_token';
  const deviceName = getArgValue(args, '--device-name');
  const githubToken = getArgValue(args, '--github-token');
  const agentArg = getArgValue(args, '--agent'); // copilot | claude | both | auto
  const anthropicKey = getArgValue(args, '--anthropic-key');

  if (!relay) {
    return fail('missing_relay', '--relay is required');
  }

  // Map --agent to an explicit allow-list. Omit for auto-detection.
  let agents: AgentId[] | undefined;
  switch (agentArg) {
    case undefined:
    case 'auto':
      agents = undefined;
      break;
    case 'copilot':
      agents = ['copilot'];
      break;
    case 'claude':
      agents = ['claude'];
      break;
    case 'codex':
      agents = ['codex'];
      break;
    case 'both':
      agents = ['copilot', 'claude'];
      break;
    default:
      return fail('bad_agent', `--agent must be one of: copilot, claude, codex, both, auto (got "${agentArg}")`);
  }

  // Persist an Anthropic key into ~/.claude/settings.json so the daemon
  // (launched by launchd, no shell env) can read it.
  if (anthropicKey) {
    const { saveAnthropicKey } = await import('./checks.js');
    try {
      saveAnthropicKey(anthropicKey);
    } catch (err) {
      return fail('anthropic_key_write_failed', (err as Error).message);
    }
  }

  // Resolve GitHub token: explicit flag > gh CLI > saved token
  if (auth === 'github_token' && githubToken) {
    const { saveGitHubToken } = await import('./config.js');
    saveGitHubToken(githubToken);
  }

  const { hostname } = await import('node:os');
  const { getOrCreateDeviceId, DEFAULT_LOG_VERBOSITY } = await import('./config.js');
  const deviceId = getOrCreateDeviceId();

  const config: KrakiConfig = {
    relay,
    authMethod: auth as KrakiConfig['authMethod'],
    device: { name: deviceName ?? hostname().replace(/\.local$/, ''), id: deviceId },
    ...(agents && { agents }),
    logging: { verbosity: DEFAULT_LOG_VERBOSITY },
  };

  saveConfig(config);
  process.stdout.write(JSON.stringify({
    ok: true,
    configPath: getConfigPath(),
    agents: agents ?? 'auto',
  }) + '\n');
}

// ── kraki resolve-relay — resolve best relay as JSON ────

async function cmdResolveRelay(args: string[]): Promise<void> {
  const jsonOutput = args.includes('--json');
  let token = getArgValue(args, '--github-token');

  // Fall back to Kraki's own saved token (never the GitHub CLI's).
  if (!token) {
    const { loadGitHubToken } = await import('./config.js');
    token = loadGitHubToken() ?? undefined;
  }

  const { resolveRelay } = await import('./setup.js');
  const result = await resolveRelay(token);

  if (jsonOutput) {
    process.stdout.write(JSON.stringify({
      ok: result.ok,
      relayUrl: result.relayUrl,
      region: result.region ?? null,
      user: result.user ?? null,
      fallback: result.fallback ?? false,
      ...(result.error && { error: result.error }),
    }) + '\n');
    if (!result.ok) gracefulExit(1);
    return;
  }

  if (result.ok) {
    console.log(`  Relay:  ${chalk.cyan(result.relayUrl)}`);
    if (result.region) console.log(`  Region: ${chalk.cyan(result.region)}`);
  } else {
    console.log(chalk.yellow(`  Could not resolve — using default: ${result.relayUrl}`));
    gracefulExit(1);
  }
}

// ── kraki fda — macOS Full Disk Access status ───────────

async function cmdFda(args: string[]): Promise<void> {
  const watch = args.includes('--watch');
  const { probeFda } = await import('./checks.js');

  if (process.platform !== 'darwin') {
    process.stdout.write(JSON.stringify({ ok: true, status: 'not_applicable', platform: process.platform }) + '\n');
    return;
  }

  if (watch) {
    // Stream NDJSON status updates until FDA is granted (or aborted).
    const ac = new AbortController();
    process.on('SIGINT', () => ac.abort());
    process.on('SIGTERM', () => ac.abort());
    let last: string | undefined;
    while (!ac.signal.aborted) {
      const status = await probeFda();
      if (status !== last) {
        last = status;
        process.stdout.write(JSON.stringify({ ok: true, status }) + '\n');
      }
      if (status === 'granted') {
        process.stdout.write(JSON.stringify({ ok: true, status: 'granted', done: true }) + '\n');
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    process.stdout.write(JSON.stringify({ ok: true, status: 'aborted', done: true }) + '\n');
    return;
  }

  const status = await probeFda();
  process.stdout.write(JSON.stringify({ ok: true, status }) + '\n');
}

// ── kraki permissions - macOS TCC status + deep-links ─────
//
// This is the user-facing entry point for the root-cause fix. It:
//   1. registers the installed .app bundle with Launch Services so TCC
//      tracks grants by bundle id (stable across updates) instead of
//      cdhash (invalidated every release), and
//   2. opens the exact System Settings panes the user must toggle, since
//      TCC.db is SIP-protected and cannot be flipped programmatically.

async function cmdPermissions(args: string[]): Promise<void> {
  const {
    probeTccStatus, openAllTccPanes, TCC_SERVICES, ensureTccBundleRegistered, cleanupStaleBundleEntries,
  } = await import('./checks.js');

  const open = args.includes('--open');
  const json = args.includes('--json');
  const clean = args.includes('--clean');

  if (process.platform !== 'darwin') {
    process.stdout.write(JSON.stringify({ ok: true, status: 'not_applicable', platform: process.platform }) + '\n');
    return;
  }

  // Always (re)register the bundle. Idempotent and cheap; this is the
  // fix the recurring-FDA commits #123/#133/#138/#142 were all missing.
  // (probeTccStatus below also registers, so this is technically redundant,
  // but kept explicit so `--open` alone still registers without a full probe.)
  ensureTccBundleRegistered();
  // Purge zombie Launch Services entries (paths that no longer exist, or
  // throwaway /tmp extracts from prior updates). `--clean` reports them;
  // the sweep itself always runs as hygiene.
  const sweep = cleanupStaleBundleEntries();

  const status = await probeTccStatus();

  if (open) {
    openAllTccPanes();
    if (!json) {
      console.log(chalk.bold('  Opening the privacy panes in System Settings…'));
      console.log(chalk.dim('  macOS only lets you grant these yourself. Turn on Kraki:'));
      console.log('');
      for (const s of TCC_SERVICES) {
        console.log(`    ${chalk.bold(s.label)}`);
        console.log(chalk.dim(`      ${s.url}`));
        console.log(chalk.dim(`      needed to: ${s.reason}`));
      }
      console.log('');
      console.log(chalk.green('  Because Kraki.app is signed with a stable Developer ID and now'));
      console.log(chalk.green('  registered with Launch Services, these grants survive updates.'));
    }
  }

  if (clean && sweep.removed.length > 0 && !json) {
    console.log(chalk.dim(`  Cleaned ${sweep.removed.length} stale Launch Services entr${sweep.removed.length === 1 ? 'y' : 'ies'}:`));
    for (const p of sweep.removed.slice(0, 10)) console.log(chalk.dim(`    - ${p}`));
    if (sweep.removed.length > 10) console.log(chalk.dim(`    … and ${sweep.removed.length - 10} more`));
  }

  if (json || !open) {
    process.stdout.write(JSON.stringify({
      ok: true,
      bundled: status.bundled,
      registered: status.registered,
      notApplicable: status.notApplicable,
      services: status.services,
      launchServices: { staleRemoved: sweep.removed.length, kept: sweep.kept.length },
      servicesNeeded: TCC_SERVICES.map((s) => ({ id: s.id, label: s.label, reason: s.reason })),
    }, null, 2) + '\n');
  }
}

// ── kraki doctor — environment status as JSON ───────────

async function cmdDoctor(): Promise<void> {
  const {
    checkGhAuth, checkCopilotCli, checkClaudeCli, checkCodexCli, checkAnthropicCreds, probeFda, getKrakiAppBundlePath,
    getDaemonTccIdentity,
  } = await import('./checks.js');
  const { loadDaemonPid, loadDaemonIdentity } = await import('./config.js');
  // `kraki doctor` must emit a single clean JSON line on stdout. The
  // multi-adapter logger (created at module load) defaults to info-level
  // stdout (dev) which would interleave pino lines into the output, so
  // force it silent before importing the module.
  const prevLogLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'silent';
  const { detectAvailableAgents } = await import('./adapters/multi.js');

  const config = loadConfig();
  const ghAuth = checkGhAuth();
  const copilot = checkCopilotCli();
  const claude = checkClaudeCli();
  const codex = checkCodexCli();
  const anthropic = checkAnthropicCreds();
  // doctor is a READ-ONLY status query (called frequently by the toolbar).
  // We do NOT mutate Launch Services here — only report current TCC identity
  // health so the UI can surface "re-grant needed". The actual registration
  // happens in `kraki permissions`, setup, the daemon start, and after updates.
  const tccBundled = getKrakiAppBundlePath() !== null;
  const fda = await probeFda();

  // SDK + CLI level "can actually start" detection (matches runtime).
  let available: string[] = [];
  try {
    available = await detectAvailableAgents();
  } catch { /* detection best-effort */ }
  if (prevLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = prevLogLevel;

  const hasCopilotAuth = ghAuth.authenticated
    || !!process.env.GITHUB_TOKEN || !!process.env.GH_TOKEN || !!process.env.COPILOT_GITHUB_TOKEN;

  const result = {
    configExists: config !== null,
    daemonRunning: isDaemonRunning(),
    fda,
    // macOS TCC identity health. `tccRegistered=true` means permissions
    // granted in System Settings will survive future updates; false means
    // the user will be re-prompted after every release.
    tcc: {
      platform: process.platform,
      bundled: tccBundled,
      bundlePath: getKrakiAppBundlePath(),
      // Read-only hint: run `kraki permissions` to (re)register + clean.
      // We intentionally do NOT mutate LS from a status query.
      //
      // identity.healthy answers the question that actually predicts whether a
      // grant survives the next update: does the RUNNING daemon have a Launch
      // Services bundle identity? A bundled, registered, correctly signed app
      // still reports healthy:false when its daemon was started by absolute
      // path — that combination is what made this bug recur six times.
      identity: getDaemonTccIdentity(loadDaemonPid(), loadDaemonIdentity()),
    },
    ghAuth: ghAuth.authenticated,
    ghUser: ghAuth.username ?? null,
    // Legacy fields — kept so existing consumers keep working.
    copilotCli: copilot.found,
    copilotVersion: copilot.version ?? null,
    // Structured multi-agent view.
    agents: {
      codex: { cli: codex.found, version: codex.version ?? null },
      copilot: {
        cli: copilot.found,
        version: copilot.version ?? null,
        auth: hasCopilotAuth,
      },
      claude: {
        cli: claude.found,
        version: claude.version ?? null,
        creds: anthropic.configured,
        credsSource: anthropic.source,
      },
    },
    // Agents that can actually be started right now (SDK importable + CLI present).
    available,
    pinnedAgents: config?.agents ?? null,
  };

  process.stdout.write(JSON.stringify(result) + '\n');
}

// ── kraki relay-info — query relay capabilities ─────────

async function cmdRelayInfo(args: string[]): Promise<void> {
  const url = args[1];
  if (!url) {
    process.stderr.write('error: relay URL is required\nusage: kraki relay-info <url>\n');
    gracefulExit(1);
    return;
  }
  if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
    process.stderr.write('error: URL must start with wss:// or ws://\n');
    gracefulExit(1);
    return;
  }

  const { WebSocket } = await import('ws');

  const result = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Connection timed out'));
    }, 5000);

    const ws = new WebSocket(url);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth_info' }));
    });
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'auth_info_response') {
          clearTimeout(timer);
          ws.close();
          resolve(JSON.stringify({
            ok: true,
            methods: msg.methods ?? ['open'],
            githubClientId: msg.githubClientId ?? null,
          }));
        }
      } catch { /* ignore non-JSON */ }
    });
    ws.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  }).catch((err) => {
    return JSON.stringify({ ok: false, error: (err as Error).message });
  });

  process.stdout.write(result + '\n');
}

// ── kraki auth — headless GitHub device flow ────────────

async function cmdAuth(args: string[]): Promise<void> {
  const clientId = getArgValue(args, '--client-id');
  if (!clientId) {
    process.stderr.write('error: --client-id is required\n');
    gracefulExit(1);
    return;
  }

  // Step 1: Request device code
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'read:user' }),
  });
  if (!res.ok) {
    process.stderr.write(`error: GitHub device code request failed: ${res.status}\n`);
    gracefulExit(1);
    return;
  }
  const data = await res.json() as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };

  // Print device code so the caller can display it
  process.stdout.write(JSON.stringify({ phase: 'device_code', user_code: data.user_code, verification_uri: data.verification_uri, expires_in: data.expires_in }) + '\n');

  // Step 2: Poll for token
  let interval = (data.interval ?? 5) * 1000;
  const deadline = Date.now() + data.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    let tokenData: Record<string, string>;
    try {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          device_code: data.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      tokenData = await tokenRes.json() as Record<string, string>;
    } catch {
      continue; // transient network error: keep polling until the code expires
    }

    if (tokenData.access_token) {
      let username = 'unknown';
      try {
        const userRes = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'kraki-tentacle' },
        });
        const userData = await userRes.json() as Record<string, unknown>;
        username = String(userData.login ?? 'unknown');
      } catch { /* ignore */ }

      const { saveGitHubToken } = await import('./config.js');
      saveGitHubToken(tokenData.access_token);

      process.stdout.write(JSON.stringify({ phase: 'authenticated', username }) + '\n');
      return;
    }

    if (tokenData.error === 'expired_token') {
      process.stderr.write('error: device code expired\n');
      gracefulExit(1);
      return;
    }
    if (tokenData.error === 'access_denied') {
      process.stderr.write('error: authorization denied\n');
      gracefulExit(1);
      return;
    }
    if (tokenData.error === 'slow_down') {
      interval += 5000;
    }
  }

  process.stderr.write('error: authorization timed out\n');
  gracefulExit(1);
}

// ── Arg parsing ─────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === INTERNAL_DAEMON_WORKER_COMMAND) {
    // Kraki for Mac's job: run as a supervisor of the real worker, which
    // restarts it after a crash without relying on launchd (see
    // daemon-supervisor.ts: launchd's KeepAlive is dead while the user's
    // domain is stuck in on-demand-only mode).
    const { isMacAppManagedWorker } = await import('./managed.js');
    const { SUPERVISED_ENV, runSupervisor } = await import('./daemon-supervisor.js');
    if (process.platform === 'darwin' && isMacAppManagedWorker() && !process.env[SUPERVISED_ENV]) {
      const { getLogsDir } = await import('./config.js');
      const { join } = await import('node:path');
      const code = await runSupervisor({
        command: process.execPath,
        args: _isSEA ? [cmd] : [...process.execArgv, process.argv[1], cmd],
        logFile: join(getLogsDir(), 'daemon-supervisor.log'),
      });
      process.exit(code);
    }
    // Must run before importing daemon-worker/adapters: capture the initial
    // PID-bound Launch Services identity while it is still stable, then scrub
    // private LS bootstrap state from the child-process environment.
    await prepareDaemonWorkerBootstrap();
    const { startWorker } = await import('./daemon-worker.js');
    await startWorker();
    return;
  }

  if (cmd === INTERNAL_DAEMON_SMOKE_COMMAND) {
    const config = loadConfig();
    if (!config) throw new Error(`No release smoke config found at ${getConfigPath()}`);
    const pid = await runDaemonReleaseSmoke(config);
    process.stdout.write(`daemon-release-smoke-ok pid=${pid}\n`);
    return;
  }

  if (cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  if (cmd === '--version' || cmd === '-v') {
    console.log(getVersion());
    return;
  }

  if (process.env.KRAKI_META_FILE && (cmd === 'stop' || cmd === 'restart' || cmd === 'update')) {
    process.stderr.write(`${SELF_MANAGEMENT_DENIAL_REASON}\n`);
    gracefulExit(1);
    return;
  }

  if (cmd === 'stop') {
    cmdStop();
    return;
  }

  if (cmd === 'restart') {
    await cmdRestart();
    return;
  }

  if (cmd === 'update') {
    const managed = loadManagedBy();
    if (managed) {
      refuseManaged('update', managed);
      return;
    }
    if (isEmbeddedMacHelper()) {
      refuseEmbeddedHelper();
      return;
    }
    const { performUpdate } = await import('./update.js');
    await performUpdate(getVersion());
    return;
  }

  if (cmd === 'start') {
    await cmdStart(args.includes('--login'));
    return;
  }

  if (cmd === 'status') {
    cmdStatus(args.includes('--json'));
    return;
  }

  if (cmd === 'connect') {
    const urlOnly = args.includes('--url-only');
    const jsonOutput = args.includes('--json');
    await cmdConnect(urlOnly, jsonOutput);
    return;
  }

  if (cmd === 'setup') {
    if (args.includes('--headless')) {
      await cmdSetupHeadless(args);
    } else if (args.includes('--json')) {
      const { runSetupJson } = await import('./setup-json.js');
      process.exitCode = await runSetupJson(args);
    } else {
      const managed = loadManagedBy();
      if (managed) {
        refuseManaged('setup', managed);
        return;
      }
      const config = await runSetup();
      await silentStart(config);
    }
    return;
  }

  if (cmd === 'doctor') {
    await cmdDoctor();
    return;
  }

  if (cmd === 'resolve-relay') {
    await cmdResolveRelay(args);
    return;
  }

  if (cmd === 'fda') {
    await cmdFda(args);
    return;
  }

  if (cmd === 'accessibility') {
    // Machine-readable for Kraki for Mac, which runs it as the helper app so
    // the answer (and the macOS prompt) is about Kraki.
    const { probeAccessibility } = await import('./checks.js');
    const status = process.platform === 'darwin' ? probeAccessibility(args.includes('--prompt')) : 'not_applicable';
    process.stdout.write(JSON.stringify({ ok: true, status }) + '\n');
    return;
  }

  if (cmd === 'agents' && !args.includes('--json')) {
    const { printAgentsCheck } = await import('./setup.js');
    await printAgentsCheck();
    return;
  }

  if (cmd === 'agents') {
    const { runAgentsCheckJson } = await import('./agents-check.js');
    process.exitCode = await runAgentsCheckJson(args);
    // Adapters can leave child processes / timers behind; this is a one-shot probe.
    gracefulExit(process.exitCode ?? 0);
    return;
  }

  if (cmd === 'permissions') {
    await cmdPermissions(args);
    return;
  }

  if (cmd === 'relay-info') {
    await cmdRelayInfo(args);
    return;
  }

  if (cmd === 'auth') {
    await cmdAuth(args);
    return;
  }

  if (cmd === 'logs') {
    const follow = args.includes('-f') || args.includes('--follow');
    cmdLogs(follow);
    return;
  }

  if (cmd === 'config') {
    if (args[1] === 'reset') {
      await cmdConfigReset();
      return;
    }
    if (args[1] === 'log') {
      cmdConfigLog(args[2]);
      return;
    }
    cmdConfig();
    return;
  }

  // Default: setup wizard + start
  if (!cmd) {
    await cmdDefault();
    return;
  }

  console.log(chalk.red(`Unknown command: ${cmd}`));
  printHelp();
  gracefulExit(1);
}

main().catch((err) => {
  // User pressed Esc or Ctrl+C during a prompt — exit cleanly
  if (err?.name === 'ExitPromptError' || err?.message?.includes('User force closed')) {
    console.log(chalk.dim('\n  Cancelled.'));
    gracefulExit(0);
    return;
  }
  // Users see a one-line reason; the stack trace is only for KRAKI_DEBUG.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${chalk.red('✖')} ${message}`);
  if (process.env.KRAKI_DEBUG) console.error(err);
  gracefulExit(1);
});
