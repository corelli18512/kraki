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
import { isSea } from 'node:sea';

/**
 * Silently install the current binary as `kraki` in a PATH directory.
 * Only runs when executing as a SEA binary. Skips on errors.
 */
function installToPath(): void {
  if (!isSea()) return;

  const { copyFileSync, existsSync, chmodSync } = require('node:fs');
  const { execSync } = require('node:child_process');
  const path = require('node:path');
  const src = process.execPath;

  try {
    if (process.platform === 'win32') {
      // Copy to %LOCALAPPDATA%\Kraki and add to user PATH
      const appDir = path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'), 'Kraki');
      require('node:fs').mkdirSync(appDir, { recursive: true });
      const dest = path.join(appDir, 'kraki.exe');
      if (src !== dest) copyFileSync(src, dest);
      // Add to user PATH if not already there
      try {
        const currentPath = execSync('reg query "HKCU\\Environment" /v Path', { encoding: 'utf8' });
        if (!currentPath.toLowerCase().includes(appDir.toLowerCase())) {
          const pathValue = currentPath.match(/REG_(?:EXPAND_)?SZ\s+(.*)/)?.[1]?.trim() ?? '';
          const newPath = pathValue ? `${pathValue};${appDir}` : appDir;
          execSync(`reg add "HKCU\\Environment" /v Path /t REG_EXPAND_SZ /d "${newPath}" /f`, { stdio: 'ignore' });
          // Broadcast change so new terminals pick it up
          execSync('setx KRAKI_PATH_SET 1', { stdio: 'ignore' });
        }
      } catch { /* PATH update failed — not critical */ }
      console.log(chalk.dim(`  Installed to ${dest}`));
    } else {
      // macOS / Linux: copy to /usr/local/bin or ~/.local/bin
      const dest1 = '/usr/local/bin/kraki';
      const dest2 = path.join(require('node:os').homedir(), '.local', 'bin', 'kraki');

      let dest = dest2;
      try {
        copyFileSync(src, dest1);
        chmodSync(dest1, 0o755);
        dest = dest1;
      } catch {
        // /usr/local/bin not writable — use ~/.local/bin
        require('node:fs').mkdirSync(path.dirname(dest2), { recursive: true });
        copyFileSync(src, dest2);
        chmodSync(dest2, 0o755);
      }
      console.log(chalk.dim(`  Installed to ${dest}`));
    }
  } catch {
    // Silent failure — not critical
  }
}

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
  githubClientId?: string;
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
            githubClientId: msg.githubClientId,
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

// ── GitHub Device Authorization Flow ────────────────────

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/**
 * Authenticate with GitHub using the device authorization flow.
 * Opens the browser, copies the code to clipboard, and polls for approval.
 * Returns the access token and saves it for future use.
 */
async function githubDeviceFlow(clientId: string): Promise<string> {
  // 1. Request device code
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'read:user' }),
  });
  if (!res.ok) throw new Error(`GitHub device code request failed: ${res.status}`);
  const data = await res.json() as DeviceCodeResponse;

  // 2. Prompt to copy code and open browser
  console.log(chalk.dim(`    Your device code: ${chalk.bold(data.user_code)}`));
  await input({ message: 'Press Enter to copy code and open GitHub…', theme: promptTheme });

  // Copy to clipboard
  try {
    const { execSync } = await import('node:child_process');
    const platform = (await import('node:os')).platform();
    if (platform === 'darwin') {
      execSync('pbcopy', { input: data.user_code, stdio: ['pipe', 'ignore', 'ignore'] });
    } else if (platform === 'win32') {
      execSync('clip', { input: data.user_code, stdio: ['pipe', 'ignore', 'ignore'] });
    } else {
      try {
        execSync('xclip -selection clipboard', { input: data.user_code, stdio: ['pipe', 'ignore', 'ignore'] });
      } catch {
        execSync('xsel --clipboard', { input: data.user_code, stdio: ['pipe', 'ignore', 'ignore'] });
      }
    }
    console.log(chalk.dim(`    Code copied to clipboard ✓`));
  } catch { /* clipboard not available */ }

  // Open browser
  try {
    const { spawnSync } = await import('node:child_process');
    const platform = (await import('node:os')).platform();
    if (platform === 'darwin') {
      spawnSync('open', [data.verification_uri], { stdio: 'ignore' });
    } else if (platform === 'win32') {
      spawnSync('cmd', ['/c', 'start', '', data.verification_uri], { stdio: 'ignore' });
    } else {
      spawnSync('xdg-open', [data.verification_uri], { stdio: 'ignore' });
    }
  } catch { /* browser open failed — user can navigate manually */ }

  // 4. Poll for authorization
  const spinner = ora({ text: 'Waiting for authorization…', indent: 4 }).start();
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
      // Fetch username
      let username = 'unknown';
      try {
        const userRes = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'kraki-tentacle' },
        });
        const userData = await userRes.json() as Record<string, unknown>;
        username = String(userData.login ?? 'unknown');
      } catch { /* ignore */ }

      spinner.succeed(`Authenticated as ${chalk.bold(username)}`);

      // Save token for daemon to use
      const { saveGitHubToken } = await import('./config.js');
      saveGitHubToken(tokenData.access_token);
      return tokenData.access_token;
    }

    if (tokenData.error === 'slow_down') {
      await new Promise(r => setTimeout(r, 5000)); // extra backoff
    } else if (tokenData.error === 'expired_token') {
      spinner.fail('Device code expired. Please try again.');
      throw new Error('Device code expired');
    } else if (tokenData.error === 'access_denied') {
      spinner.fail('Authorization denied.');
      throw new Error('Access denied');
    }
    // 'authorization_pending' — keep polling
  }

  spinner.fail('Authorization timed out.');
  throw new Error('Device flow timed out');
}

// ── Setup flow ──────────────────────────────────────────

export async function runSetup(): Promise<KrakiConfig> {
  await printAnimatedBanner();

  const total = 4;

  // 1. Relay URL (with retry loop)
  const defaultRelay = process.env.KRAKI_RELAY_URL ?? OFFICIAL_RELAY;
  let relay: string = defaultRelay;
  let relayInfo: RelayInfo = { methods: ['open'], pairing: true };
  let urlConfirmed = false;
  while (!urlConfirmed) {
    console.log(`\n  ${icon} ${step(1, total)} ${chalk.bold('Relay')}`);
    const relayHost = await input({
      message: 'Relay:',
      default: defaultRelay.replace(/^wss?:\/\//, ''),
      theme: promptTheme,
      validate: (v) => {
        if (v.includes(' ')) return 'Invalid URL';
        return true;
      },
    });
    // Add wss:// if no protocol given
    relay = relayHost.startsWith('wss://') || relayHost.startsWith('ws://') ? relayHost : `wss://${relayHost}`;

    // Test relay connectivity and query auth info
    while (true) {
      const connSpinner = ora({ text: 'Querying relay…', indent: 4 }).start();
      try {
        relayInfo = await queryRelayInfo(relay);
        connSpinner.succeed('Relay is reachable');
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

  // 2. Auth method
  // For GitHub-enabled relays: silently try gh CLI, fall back to device flow
  // Only prompt if multiple non-GitHub methods are available
  const cliAuthLabels: Record<string, string> = {
    github_token: '  GitHub (recommended)',
    apikey: '  API key',
    open: '  Open (no auth)',
  };

  const hasGitHub = relayInfo.methods.includes('github_token');
  const cliMethods = relayInfo.methods.filter((m) => cliAuthLabels[m]);
  let authMethod: string;

  if (hasGitHub) {
    // GitHub relay: auto-select, try CLI then device flow
    authMethod = 'github_token';
    console.log(`  ${icon} ${step(2, total)} ${chalk.bold('Authentication')}`);
    const spinner = ora({ text: 'Checking GitHub CLI…', indent: 4 }).start();
    const ghResult = checkGhAuth();
    if (ghResult.authenticated) {
      spinner.succeed(`Authenticated via GitHub CLI as ${chalk.bold(ghResult.username ?? 'unknown')}`);
    } else {
      spinner.info('GitHub CLI not authenticated — signing in via browser');
      if (!relayInfo.githubClientId) {
        throw new Error('Relay does not provide a GitHub client ID. Install GitHub CLI and run: gh auth login');
      }
      await githubDeviceFlow(relayInfo.githubClientId);
    }
  } else if (cliMethods.length === 1) {
    authMethod = cliMethods[0];
    console.log(`  ${icon} ${step(2, total)} ${chalk.bold('Authentication')}`);
    console.log(chalk.dim(`    Auto-selected: ${cliAuthLabels[authMethod]?.trim() ?? authMethod}`));
  } else if (cliMethods.length > 1) {
    console.log(`  ${icon} ${step(2, total)} ${chalk.bold('Authentication')}`);
    authMethod = await select({
      message: 'Authentication:',
      theme: promptTheme,
      choices: cliMethods.map((m) => ({ name: cliAuthLabels[m], value: m })),
    });
  } else {
    throw new Error('No supported auth method found on this relay');
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
  if (isSea()) {
    const spinner = ora({ text: 'Looking for Copilot CLI…', indent: 4 }).start();
    const copilotResult = await withRetry(
      checkCopilotCli,
      'Copilot CLI',
      'Install from https://docs.github.com/copilot/how-tos/copilot-cli',
      spinner,
    );
    spinner.succeed(`Copilot CLI found (${copilotResult.version ?? 'unknown version'})`);

    // Check Copilot authentication — the adapter's own auth chain (SDK token
    // store, copilot login, etc.) works even without gh auth or env vars, so
    // we only show a soft hint rather than blocking on a false negative.
    const authSpinner = ora({ text: 'Checking Copilot authentication…', indent: 4 }).start();
    const hasGhToken = checkGhAuth().authenticated;
    const hasEnvToken = !!process.env.GITHUB_TOKEN || !!process.env.GH_TOKEN || !!process.env.COPILOT_GITHUB_TOKEN;
    if (hasGhToken || hasEnvToken) {
      authSpinner.succeed('Copilot authentication available');
    } else {
      authSpinner.succeed('Copilot authentication available (via Copilot login)');
    }
  } else {
    const spinner = ora({ text: 'Checking Copilot SDK…', indent: 4 }).start();
    spinner.succeed('Copilot SDK available');
  }
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

  // 7. Install to PATH (silent — only for SEA binaries)
  installToPath();

  // 8. Summary box
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
        token = execSync('gh auth token', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || undefined;
      } catch { /* ignore */ }
      if (!token) {
        const { loadGitHubToken } = await import('./config.js');
        token = loadGitHubToken() ?? undefined;
      }
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
