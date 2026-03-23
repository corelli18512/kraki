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
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { select } from '@inquirer/prompts';

import { loadConfig, saveConfig, getConfigPath, getKrakiHome, getLogVerbosity, loadChannelKey } from './config.js';
import { isDaemonRunning, getDaemonStatus, startDaemon, stopDaemon } from './daemon.js';
import { runSetup } from './setup.js';
import { requestPairingToken, buildPairingUrl, renderQrToTerminal } from './pair.js';
import { printStaticBanner } from './banner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Version ─────────────────────────────────────────────

function getVersion(): string {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
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
  kraki                Start Kraki (runs setup first if needed)
  kraki stop           Stop Kraki
  kraki status         Show status and connection info
  kraki connect           Generate QR code to connect a mobile device
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

async function cmdStart(): Promise<void> {
  let config = loadConfig();

  if (!config) {
    config = await runSetup();
  }

  if (isDaemonRunning()) {
    const status = getDaemonStatus();
    const action = await select({
      message: `Kraki is already running (PID ${status.pid}). What do you want to do?`,
      theme: {
        prefix: { idle: chalk.blue('  ?'), done: chalk.green('  ✔') },
        icon: { cursor: '  ❯' },
      },
      choices: [
        { name: '  Keep running', value: 'exit' },
        { name: '  Restart Kraki', value: 'restart' },
        { name: '  Clean setup (stop + reset config)', value: 'clean' },
      ],
    });

    if (action === 'exit') {
      console.log(chalk.green(`${chalk.hex('#ea6046')('◈')} Kraki still running (PID ${status.pid})`));
      return;
    }

    stopDaemon();
    console.log(chalk.dim('   Stopped..'));

    if (action === 'clean') {
      const { rmSync } = await import('node:fs');
      const krakiHome = getKrakiHome();
      try {
        rmSync(krakiHome, { recursive: true, force: true });
        console.log(chalk.dim(`   Cleared ${krakiHome}`));
      } catch { /* already clean */ }
      config = await runSetup();
    }
  }

  let pid: number;
  try {
    pid = await startDaemon(config);
  } catch (err) {
    console.log('');
    console.log(chalk.red(`  Failed to start Kraki: ${(err as Error).message}`));
    console.log('');
    return;
  }
  console.log('');
  console.log(chalk.green(`  🦑 Kraki started (PID ${pid})`));

  // Show pairing QR code
  const { showPairingQr } = await import('./setup.js');
  await showPairingQr(config);

  // Tips
  console.log(chalk.dim('  Commands:'));
  console.log(chalk.dim(`    kraki connect     Generate a new connect code`));
  console.log(chalk.dim(`    kraki status   Show connection status`));
  console.log(chalk.dim(`    kraki logs -f  Follow logs`));
  console.log(chalk.dim(`    kraki stop     Stop Kraki`));
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
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('No config found. Run `kraki` to set up first.'));
    return;
  }

  if (!isDaemonRunning()) {
    console.log(chalk.yellow('Kraki is not running. Start it with `kraki` first.'));
    return;
  }

  console.log(chalk.dim('Requesting pairing token from relay...'));

  try {
    // Resolve auth token (same logic as daemon-worker)
    let token: string | undefined;
    if (config.authMethod === 'github') {
      try {
        const { execSync } = await import('node:child_process');
        token = execSync('gh auth token 2>/dev/null', { encoding: 'utf8' }).trim() || undefined;
      } catch { /* ignore */ }
    } else if (config.authMethod === 'open') {
      token = 'dev';
    } else {
      token = loadChannelKey() ?? undefined;
    }

    const info = await requestPairingToken(config.relay, token);
    const pairingUrl = buildPairingUrl(info);
    const qr = await renderQrToTerminal(pairingUrl);
    console.log(qr);
  } catch (err) {
    console.log(chalk.red(`Failed to create pairing token: ${(err as Error).message}`));
  }
}

// ── Arg parsing ─────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

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

  // Default: start
  if (!cmd) {
    await cmdStart();
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
