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
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync, realpathSync } from 'node:fs';
import { select } from '@inquirer/prompts';
import { isSea } from 'node:sea';

import { loadConfig, saveConfig, getConfigPath, getKrakiHome, getLogVerbosity, loadChannelKey, type KrakiConfig } from './config.js';
import { INTERNAL_DAEMON_WORKER_COMMAND, isDaemonRunning, getDaemonStatus, startDaemon, stopDaemon } from './daemon.js';
import { runSetup } from './setup.js';
import { requestPairingToken, buildPairingUrl, renderQrToTerminal } from './pair.js';
import { printStaticBanner } from './banner.js';

declare const __KRAKI_VERSION__: string | undefined;

// ── Version ─────────────────────────────────────────────

function resolvePackageRootFromArgv(): string | null {
  const scriptPath = process.argv[1];
  if (!scriptPath) return null;
  try {
    const realPath = realpathSync(resolve(scriptPath));
    return resolve(dirname(realPath), '..');
  } catch {
    return resolve(dirname(resolve(scriptPath)), '..');
  }
}

function getVersion(): string {
  if (typeof __KRAKI_VERSION__ !== 'undefined') {
    return __KRAKI_VERSION__;
  }

  if (isSea()) {
    return '0.0.0';
  }

  try {
    const packageRoot = resolvePackageRootFromArgv();
    if (!packageRoot) return '0.0.0';
    const pkgPath = join(packageRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ── Help ────────────────────────────────────────────────

function printHelp(): void {
  printStaticBanner();
  console.log(`${chalk.bold('Usage:')}
  kraki                Setup wizard + start (first time or reconfigure)
  kraki start          Start silently from existing config
  kraki stop           Stop Kraki
  kraki update         Check for updates and install the latest version
  kraki connect        Generate QR code to connect a device
  kraki status         Show status and connection info
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
  let pid: number;
  try {
    pid = await startDaemon(config);
  } catch (err) {
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

function cmdStatus(): void {
  const status = getDaemonStatus();
  const config = loadConfig();

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
    process.exit(1);
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

async function cmdConnect(): Promise<void> {
  let config = loadConfig();

  if (!isDaemonRunning()) {
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
    console.log(chalk.red('No config found. Run `kraki` to set up.'));
    return;
  }

  console.log(chalk.dim('  Requesting pairing token from relay...'));

  try {
    let token: string | undefined;
    if (config.authMethod === 'github_token') {
      try {
        const { execSync } = await import('node:child_process');
        token = execSync('gh auth token 2>/dev/null', { encoding: 'utf8' }).trim() || undefined;
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
    const qr = await renderQrToTerminal(pairingUrl);
    console.log(qr);
  } catch (err) {
    console.log(chalk.red(`  Failed to create pairing token: ${(err as Error).message}`));
  }
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

  if (cmd === 'stop') {
    cmdStop();
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
    cmdStatus();
    return;
  }

  if (cmd === 'connect') {
    await cmdConnect();
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
  process.exit(1);
}

main().catch((err) => {
  // User pressed Esc or Ctrl+C during a prompt — exit cleanly
  if (err?.name === 'ExitPromptError' || err?.message?.includes('User force closed')) {
    console.log(chalk.dim('\n  Cancelled.'));
    process.exit(0);
  }
  console.error(chalk.red('Fatal error:'), err);
  process.exit(1);
});
