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

import chalk from 'chalk';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { select } from '@inquirer/prompts';

import { loadConfig, saveConfig, getConfigPath, getKrakiHome, getLogVerbosity, getVersion, loadChannelKey, type KrakiConfig } from './config.js';
import { INTERNAL_DAEMON_WORKER_COMMAND, isDaemonRunning, getDaemonStatus, startDaemon, stopDaemon, MacOSCodeSignatureError } from './daemon.js';
import { runSetup } from './setup.js';
import { requestPairingToken, buildPairingUrl, renderQrToTerminal } from './pair.js';
import { printStaticBanner } from './banner.js';
import { readStatusFile } from './status-file.js';
import { ensureWindowsSystemPath } from './checks.js';
import type { AgentId } from '@kraki/protocol';
import { SELF_MANAGEMENT_DENIAL_REASON } from './self-management-guard.js';

// Self-heal PATH on Windows BEFORE any setup/check spawns a child
// process. If kraki is launched from a context with a minimal PATH
// (e.g. double-clicked SEA binary), tools like `gh`, `copilot`, and
// `powershell.exe` would otherwise be invisible. The daemon worker
// re-runs this on its side as a belt-and-suspenders for autostart
// paths that bypass the CLI entirely.
ensureWindowsSystemPath();

// Detect Node.js SEA (Single Executable Application)
const _isSEA = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();

// Detect double-click on Windows: stdin is TTY but parent is explorer
const _isWindowsDoubleClick = process.platform === 'win32' && _isSEA && process.stdin.isTTY;

// Graceful exit: on Windows SEA, avoid process.exit() after async work.
// Instead, schedule exit and let libuv drain.
function gracefulExit(code: number): void {
  if (_isWindowsDoubleClick) {
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
  console.log(`${chalk.bold('Usage:')}
  kraki                Setup wizard + start (first time or reconfigure)
  kraki start          Start silently from existing config
  kraki stop           Stop Kraki
  kraki restart        Restart Kraki
  kraki update         Check for updates and install the latest version
  kraki connect        Generate QR code to connect a device
  kraki connect --url-only
                       Print pairing URL only (for toolbar / scripts)
  kraki connect --json Print pairing token + url + expiry as JSON
  kraki setup --headless
                       Non-interactive setup (for toolbar / scripts)
                       [--relay --auth --device-name --github-token
                        --agent copilot|claude|both|auto --anthropic-key]
  kraki resolve-relay --json [--github-token <tok>]
                       Resolve best relay + region as JSON
  kraki doctor         Print environment status as JSON
  kraki fda --json     Print macOS Full Disk Access status as JSON
  kraki fda --watch    Stream FDA status as NDJSON until granted
  kraki permissions    macOS TCC status (bundle registration + FDA) as JSON
  kraki permissions --open
                       Open every TCC pane in System Settings
  kraki permissions --clean
                       Also purge stale Launch Services entries
  kraki status         Show status and connection info
  kraki status --json  Print status as JSON (for desktop apps)
  kraki logs [-f]      Tail log files (-f to follow)
  kraki config         Print current config
  kraki config log     Show current log verbosity
  kraki config log <normal|verbose>
                       Set log verbosity for future daemon starts
  kraki config reset   Delete config and re-run setup
  kraki --help         Show this help
  kraki --version      Show version
`);
}

// ── Commands ────────────────────────────────────────────

// ── kraki (default) — setup wizard + auto start ─────────

async function cmdDefault(): Promise<void> {
  let config = loadConfig();

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

async function cmdStart(): Promise<void> {
  let config = loadConfig();

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
  // In install mode, the install script handles daemon startup from the
  // shell (needed on macOS where kraki can't fork+exec itself due to CSM).
  if (process.env.KRAKI_INSTALL === '1') {
    const { showPairingQr } = await import('./setup.js');
    await showPairingQr(config);
    console.log(chalk.dim('  Commands:'));
    console.log(chalk.dim('    kraki connect   Generate a new connect code'));
    console.log(chalk.dim('    kraki status    Show connection status'));
    console.log(chalk.dim('    kraki logs -f   Follow logs'));
    console.log(chalk.dim('    kraki stop      Stop Kraki'));
    console.log('');
    return;
  }

  let pid: number;
  try {
    pid = await startDaemon(config);
  } catch (err) {
    if (err instanceof MacOSCodeSignatureError) {
      return startDaemonInProcess(config);
    }
    console.log(chalk.red(`  Failed to start Kraki: ${(err as Error).message}`));
    return;
  }
  console.log(chalk.green(`  🦑 Kraki started (PID ${pid})`));

  // Show pairing QR code
  const { showPairingQr } = await import('./setup.js');
  await showPairingQr(config);

  // Tips
  console.log(chalk.dim('  Commands:'));
  console.log(chalk.dim('    kraki connect   Generate a new connect code'));
  console.log(chalk.dim('    kraki status    Show connection status'));
  console.log(chalk.dim('    kraki logs -f   Follow logs'));
  console.log(chalk.dim('    kraki stop      Stop Kraki'));
  console.log('');
}

/**
 * Run the daemon worker in the current process.
 * Used on macOS when the kernel blocks child process spawning of
 * downloaded SEA binaries (com.apple.provenance + CSM 2).
 */
async function startDaemonInProcess(config: KrakiConfig): Promise<void> {
  // Ignore SIGHUP so the daemon survives terminal close
  process.on('SIGHUP', () => {});

  const { saveDaemonPid, getLogVerbosity: getLogV } = await import('./config.js');
  saveDaemonPid(process.pid);
  process.env.LOG_LEVEL = getLogV(config) === 'verbose' ? 'debug' : 'info';

  // Force production logging so pino writes to files, not stdout.
  // (The spawned-daemon path doesn't need this because stdio is 'ignore'.)
  process.env.NODE_ENV = 'production';

  console.log(chalk.green(`  🦑 Kraki started (PID ${process.pid})`));

  // Show pairing QR code
  const { showPairingQr } = await import('./setup.js');
  await showPairingQr(config);

  console.log(chalk.dim('  Running in foreground — press Ctrl+C or run `kraki stop` to quit'));
  console.log('');

  const { startWorker } = await import('./daemon-worker.js');
  await startWorker();
  // This never returns — the process is now the daemon
}

function cmdStop(): void {
  if (!isDaemonRunning()) {
    console.log(chalk.yellow('Kraki is not running.'));
    return;
  }

  const stopped = stopDaemon();
  if (stopped) {
    console.log(chalk.green(`${chalk.hex('#ea6046')('◈')} Kraki stopped.`));
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
    // Machine-readable for desktop apps (mac toolbar, etc.). Schema is
    // additive — only add fields, never remove, to keep older clients
    // working.
    const payload = {
      ok: true,
      version: getVersion(),
      daemon: {
        running: status.running,
        pid: status.pid,
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
  console.log(chalk.bold(`${chalk.hex('#ea6046')('◈')} Kraki Status`));
  console.log('');

  if (status.running) {
    console.log(`  Status:  ${chalk.green('running')} (PID ${status.pid})`);
  } else {
    console.log(`  Status:  ${chalk.yellow('stopped')}`);
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

function cmdLogs(follow: boolean): void {
  const logDir = join(getKrakiHome(), 'logs');

  if (!existsSync(logDir)) {
    console.log(chalk.yellow(`No log directory found at ${logDir}`));
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
    let token: string | undefined;
    if (config.authMethod === 'github_token') {
      try {
        const { execSync } = await import('node:child_process');
        token = execSync('gh auth token', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || undefined;
      } catch { /* ignore */ }
      if (!token) {
        const { loadGitHubToken } = await import('./config.js');
        token = loadGitHubToken() ?? undefined;
      }
    } else if (config.authMethod === 'open') {
      token = 'dev';
    }

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
    case 'both':
      agents = ['copilot', 'claude'];
      break;
    default:
      return fail('bad_agent', `--agent must be one of: copilot, claude, both, auto (got "${agentArg}")`);
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

  // Fall back to gh CLI / saved token if not provided.
  if (!token) {
    try {
      const { execSync } = await import('node:child_process');
      token = execSync('gh auth token', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || undefined;
    } catch { /* ignore */ }
  }
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
      console.log(chalk.bold('  Opening macOS Privacy & Security panes…'));
      console.log(chalk.dim('  TCC grants cannot be applied automatically (SIP-protected).'));
      console.log(chalk.dim('  Toggle the switch for Kraki in each pane that opens.'));
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
    checkGhAuth, checkCopilotCli, checkClaudeCli, checkAnthropicCreds, probeFda, getKrakiAppBundlePath,
  } = await import('./checks.js');
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
    },
    ghAuth: ghAuth.authenticated,
    ghUser: ghAuth.username ?? null,
    // Legacy fields — kept so existing consumers keep working.
    copilotCli: copilot.found,
    copilotVersion: copilot.version ?? null,
    // Structured multi-agent view.
    agents: {
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
  const interval = (data.interval ?? 5) * 1000;
  const deadline = Date.now() + data.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: data.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const tokenData = await tokenRes.json() as Record<string, string>;

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
      await new Promise(r => setTimeout(r, 5000));
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
    const { startWorker } = await import('./daemon-worker.js');
    await startWorker();
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
    const { performUpdate } = await import('./update.js');
    await performUpdate(getVersion());
    return;
  }

  if (cmd === 'start') {
    await cmdStart();
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
    } else {
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
  console.error(chalk.red('Fatal error:'), err);
  gracefulExit(1);
});
