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
import { INTERNAL_DAEMON_WORKER_COMMAND, isDaemonRunning, getDaemonStatus, startDaemon, stopDaemon } from './daemon.js';
import { runSetup } from './setup.js';
import { requestPairingToken, buildPairingUrl, renderQrToTerminal } from './pair.js';
import { printStaticBanner } from './banner.js';

// ── Help ────────────────────────────────────────────────

function printHelp(): void {
  printStaticBanner();
  console.log(`${chalk.bold('Usage:')}
  kraki                Setup wizard + start (first time or reconfigure)
  kraki start          Start silently from existing config
  kraki stop           Stop Kraki
  kraki update         Check for updates and install the latest version
  kraki connect        Generate QR code to connect a device
  kraki connect --url-only
                       Print pairing URL only (for toolbar / scripts)
  kraki setup --headless
                       Non-interactive setup (for toolbar / scripts)
  kraki doctor         Print environment status as JSON
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

async function cmdConnect(urlOnly = false): Promise<void> {
  let config = loadConfig();

  if (!isDaemonRunning()) {
    if (urlOnly) {
      process.stderr.write('error: daemon not running\n');
      process.exit(1);
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
    if (urlOnly) {
      process.stderr.write('error: no config found\n');
      process.exit(1);
      return;
    }
    console.log(chalk.red('No config found. Run `kraki` to set up.'));
    return;
  }

  if (!urlOnly) {
    console.log(chalk.dim('  Requesting pairing token from relay...'));
  }

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

    if (urlOnly) {
      // Machine-readable output for the desktop toolbar — just the URL, no decoration
      process.stdout.write(pairingUrl + '\n');
      return;
    }

    const qr = await renderQrToTerminal(pairingUrl);
    console.log(qr);
  } catch (err) {
    if (urlOnly) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      process.exit(1);
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
  const relay = getArgValue(args, '--relay');
  const auth = getArgValue(args, '--auth') ?? 'github_token';
  const deviceName = getArgValue(args, '--device-name');
  const githubToken = getArgValue(args, '--github-token');

  if (!relay) {
    process.stderr.write('error: --relay is required\n');
    process.exit(1);
    return;
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
    logging: { verbosity: DEFAULT_LOG_VERBOSITY },
  };

  saveConfig(config);
  process.stdout.write(JSON.stringify({ ok: true, configPath: getConfigPath() }) + '\n');
}

// ── kraki doctor — environment status as JSON ───────────

async function cmdDoctor(): Promise<void> {
  const { checkGhAuth, checkCopilotCli } = await import('./checks.js');
  const config = loadConfig();
  const ghAuth = checkGhAuth();
  const copilot = checkCopilotCli();

  const result = {
    configExists: config !== null,
    daemonRunning: isDaemonRunning(),
    ghAuth: ghAuth.authenticated,
    ghUser: ghAuth.username ?? null,
    copilotCli: copilot.found,
    copilotVersion: copilot.version ?? null,
  };

  process.stdout.write(JSON.stringify(result) + '\n');
}

// ── kraki auth — headless GitHub device flow ────────────

async function cmdAuth(args: string[]): Promise<void> {
  const clientId = getArgValue(args, '--client-id');
  if (!clientId) {
    process.stderr.write('error: --client-id is required\n');
    process.exit(1);
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
    process.exit(1);
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

      process.stdout.write(JSON.stringify({ phase: 'authenticated', username, token: tokenData.access_token }) + '\n');
      return;
    }

    if (tokenData.error === 'expired_token') {
      process.stderr.write('error: device code expired\n');
      process.exit(1);
      return;
    }
    if (tokenData.error === 'access_denied') {
      process.stderr.write('error: authorization denied\n');
      process.exit(1);
      return;
    }
    if (tokenData.error === 'slow_down') {
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  process.stderr.write('error: authorization timed out\n');
  process.exit(1);
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
    const urlOnly = args.includes('--url-only');
    await cmdConnect(urlOnly);
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
