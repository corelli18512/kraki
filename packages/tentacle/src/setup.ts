/**
 * Interactive first-time setup for Kraki tentacle.
 *
 * Guides the user through relay selection, authentication,
 * device naming, and agent verification.
 */

import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { hostname } from 'node:os';
import { WebSocket } from 'ws';

import {
  DEFAULT_LOG_VERBOSITY,
  type KrakiConfig,
  saveConfig,
  saveChannelKey,
  getOrCreateDeviceId,
  getConfigPath,
} from './config.js';
import { checkGhAuth, checkCopilotCli, withRetry } from './checks.js';
import { printAnimatedBanner } from './banner.js';

const OFFICIAL_RELAY = 'wss://kraki.corelli.cloud';

function getBrand(s: string) { return chalk.hex('#ea6046')(s); }
const icon = '◈';
function step(n: number, total: number) { return chalk.dim(`[${n}/${total}]`); }
function divider() { console.log(chalk.dim('  ─────────────────────────────────')); }

// Align inquirer prefix (✔/?) with ora spinners (4-space indent)
const promptTheme = {
  prefix: { idle: chalk.blue('  ?'), done: chalk.green('  ✔') },
  icon: { cursor: '  ❯' },
};

// Terminal hyperlink (OSC 8)
function link(text: string, url: string): string {
  return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
}

/**
 * Test if the relay is reachable by opening a WebSocket and waiting for connection.
 */
interface RelayInfo {
  methods: string[];
  pairing: boolean;
}

/**
 * Connect to the relay, query auth_info, and return server capabilities.
 */
function queryRelayInfo(url: string, timeoutMs = 5000): Promise<RelayInfo> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Connection timed out'));
    }, timeoutMs);

    const ws = new WebSocket(url);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth_info' }));
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'auth_info_response') {
          clearTimeout(timer);
          ws.close();
          resolve({
            methods: msg.methods ?? ['open'],
            pairing: msg.methods?.includes('pairing') ?? true,
          });
        }
      } catch { /* ignore non-JSON */ }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(err.message || 'Connection failed'));
    });
  });
}

// ── Box drawing ─────────────────────────────────────────

function printBox(lines: string[]): void {
  const plain = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '');
  const maxLen = Math.max(...lines.map((l) => plain(l).length));
  const pad = (s: string) => s + ' '.repeat(maxLen - plain(s).length);
  const border = chalk.dim;

  console.log(border(`  ┌${'─'.repeat(maxLen + 2)}┐`));
  for (const line of lines) {
    console.log(border('  │ ') + pad(line) + border(' │'));
  }
  console.log(border(`  └${'─'.repeat(maxLen + 2)}┘`));
}

// ── Setup flow ──────────────────────────────────────────

export async function runSetup(): Promise<KrakiConfig> {
  await printAnimatedBanner();

  const total = 4;

  // 1. Relay URL (with retry loop)
  let relay: string = OFFICIAL_RELAY;
  let relayInfo: RelayInfo = { methods: ['open'], pairing: true };
  let urlConfirmed = false;
  while (!urlConfirmed) {
    console.log(`\n  ${icon} ${step(1, total)} ${chalk.bold('Relay URL')}`);
    relay = await input({
      message: 'Relay URL:',
      default: OFFICIAL_RELAY,
      theme: promptTheme,
      validate: (v) => {
        if (!v.startsWith('wss://') && !v.startsWith('ws://')) {
          return 'URL must start with wss:// or ws://';
        }
        return true;
      },
    });

    // Test relay connectivity and query auth info
    while (true) {
      const connSpinner = ora({ text: 'Querying relay…', indent: 4 }).start();
      try {
        relayInfo = await queryRelayInfo(relay);
        connSpinner.succeed(`Relay is reachable (auth: ${relayInfo.methods.join(', ')})`);
        urlConfirmed = true;
        break;
      } catch (err) {
        connSpinner.fail(`Cannot reach relay: ${(err as Error).message}`);
        const action = await select({
          message: 'What do you want to do?',
          theme: promptTheme,
          choices: [
            { name: '  Retry', value: 'retry' },
            { name: '  Enter a different URL', value: 'change' },
          ],
        });
        if (action === 'change') break; // back to URL input
        // 'retry' continues the inner loop
      }
    }
  }

  divider();

  // 2. Auth method (filtered by what the relay supports)
  const authLabels: Record<string, string> = {
    github_token: '  GitHub (recommended)',
    github_oauth: '  GitHub OAuth',
    apikey: '  API key',
    open: '  Open (no auth)',
  };

  const supportedModes = relayInfo.methods;
  let authMethod: string;

  if (supportedModes.length === 1) {
    // Auto-select
    authMethod = supportedModes[0];
    console.log(`  ${icon} ${step(2, total)} ${chalk.bold('Authentication')}`);
    console.log(chalk.dim(`    Auto-selected: ${authLabels[authMethod]?.trim() ?? authMethod}`));
  } else {
    console.log(`  ${icon} ${step(2, total)} ${chalk.bold('Authentication')}`);
    const choices = supportedModes
      .filter((m) => authLabels[m])
      .map((m) => ({ name: authLabels[m], value: m }));

    authMethod = await select({
      message: 'Authentication:',
      theme: promptTheme,
      choices,
    });
  }

  if (authMethod === 'github_token') {
    const spinner = ora({ text: 'Checking GitHub authentication…', indent: 4 }).start();
    const authResult = await withRetry(
      checkGhAuth,
      'GitHub CLI authentication',
      'Run: gh auth login',
    );
    spinner.succeed(`Authenticated as ${chalk.bold(authResult.username ?? 'unknown')}`);
  } else if (authMethod === 'channel-key') {
    const channelKey = await input({
      message: 'Channel key:',
      theme: promptTheme,
      validate: (v) => (v.trim().length > 0 ? true : 'Channel key cannot be empty'),
    });
    saveChannelKey(channelKey.trim());
    console.log(chalk.green('    ✔ Channel key saved'));
  }

  divider();

  // 3. Device naming
  console.log(`  ${icon} ${step(3, total)} ${chalk.bold('Device Name')}`);
  const defaultName = hostname().replace(/\.local$/, '');
  const deviceName = await input({
    message: 'Device name:',
    theme: promptTheme,
    default: defaultName,
  });

  divider();

  // 4. Agent check
  console.log(`  ${icon} ${step(4, total)} ${chalk.bold('Agent Verification')}`);
  const spinner = ora({ text: 'Looking for Copilot CLI…', indent: 4 }).start();
  const copilotResult = await withRetry(
    checkCopilotCli,
    'Copilot CLI',
    'Install: npm install -g @github/copilot  (or check your PATH)',
  );
  spinner.succeed(`Copilot CLI found (${copilotResult.version ?? 'unknown version'})`);

  // 5. Build config
  const deviceId = getOrCreateDeviceId();
  const config: KrakiConfig = {
    relay,
    authMethod: authMethod as KrakiConfig['authMethod'],
    device: { name: deviceName, id: deviceId },
    logging: { verbosity: DEFAULT_LOG_VERBOSITY },
  };

  // 6. Save
  saveConfig(config);

  // 7. Summary box
  console.log('');
  printBox([
    `${chalk.green.bold('✔')} ${chalk.bold('Setup complete!')}`,
    '',
    `${chalk.dim('Relay')}   ${chalk.cyan(relay)}`,
    `${chalk.dim('Auth')}    ${chalk.cyan(authMethod)}`,
    `${chalk.dim('Device')}  ${chalk.cyan(deviceName)}`,
    `${chalk.dim('Logs')}    ${chalk.cyan(DEFAULT_LOG_VERBOSITY)}`,
    '',
    chalk.dim(`Config saved to ${getConfigPath()}`),
  ]);

  return config;
}

/**
 * Generate and display pairing QR code.
 * Called by CLI after daemon is started.
 */
export async function showPairingQr(config: KrakiConfig): Promise<void> {
  console.log('');
  const pairSpinner = ora({ text: 'Generating pairing code…', indent: 2 }).start();
  try {
    let token: string | undefined;
    if (config.authMethod === 'github_token') {
      try {
        const { execSync } = await import('node:child_process');
        token = execSync('gh auth token 2>/dev/null', { encoding: 'utf8' }).trim() || undefined;
      } catch { /* ignore */ }
    } else if (config.authMethod === 'open') {
      token = 'dev';
    }

    const { requestPairingToken, buildPairingUrl, renderQrToTerminal } = await import('./pair.js');
    const info = await requestPairingToken(config.relay, token);
    const url = buildPairingUrl(info);
    const qr = await renderQrToTerminal(url);
    pairSpinner.stop();
    console.log(qr);
    console.log(chalk.dim('  Token expires in 5 minutes and can only be claimed once.\n'));
  } catch {
    pairSpinner.warn('Could not generate pairing code.');
    console.log(chalk.dim('  Run `kraki connect` later to connect your phone.\n'));
  }
}
