/**
 * Interactive first-time setup for Kraki tentacle.
 *
 * Guides the user through relay selection, authentication,
 * device naming, and agent verification.
 */

import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { hostname, platform } from 'node:os';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import {
  DEFAULT_LOG_VERBOSITY,
  type KrakiConfig,
  saveConfig,
  saveChannelKey,
  getOrCreateDeviceId,
  getConfigPath,
  getConfigDir,
} from './config.js';
import { checkGhAuth, checkCopilotCli, withRetry, warmupTccPermissions, type TccProbeResult } from './checks.js';
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
const OFFICIAL_API = 'https://kraki.corelli.cloud';

function getBrand(s: string) { return chalk.hex('#ea6046')(s); }
const icon = '◈';
function step(n: number, total: number) { return chalk.dim(`[${n}/${total}]`); }
function divider() { console.log(chalk.dim('  ─────────────────────────────────')); }

// ── macOS TCC warm-up ────────────────────────────────────

const TCC_WARMED_MARKER = '.tcc-warmed';

/**
 * True when this is a fresh macOS install that hasn't done the TCC
 * warm-up yet. We gate the warm-up to first-run only so existing users
 * aren't re-prompted on re-runs of the wizard.
 */
function needsTccWarmup(): boolean {
  if (platform() !== 'darwin') return false;
  return !existsSync(join(getConfigDir(), TCC_WARMED_MARKER));
}

function markTccWarmed(): void {
  try {
    writeFileSync(join(getConfigDir(), TCC_WARMED_MARKER),
      `${new Date().toISOString()}\n`, 'utf8');
  } catch {
    // Best-effort — if we can't write the marker, the worst case is that
    // the warm-up runs again next time the wizard is invoked.
  }
}

/**
 * Render the TCC warm-up step. Probes each protected folder one at a
 * time, printing a status line as we go. macOS surfaces the permission
 * modal during each probe; the modal blocks until the user clicks.
 */
async function runTccWarmupStep(stepNum: number, total: number): Promise<void> {
  console.log(`  ${icon} ${step(stepNum, total)} ${chalk.bold('macOS Privacy')}`);
  console.log(chalk.dim('    macOS will ask kraki for permission to access folders where'));
  console.log(chalk.dim('    your code lives. Click "Allow" on each prompt — this only'));
  console.log(chalk.dim('    happens once.\n'));

  const formatStatus = (r: TccProbeResult): string => {
    switch (r.status) {
      case 'granted': return chalk.green('✓ allowed');
      case 'denied':  return chalk.yellow('⚠ denied');
      case 'missing': return chalk.dim('— not present');
    }
  };

  const results = await warmupTccPermissions(
    (label) => {
      // Print label + ellipsis on the same line; status overwrites it.
      process.stdout.write(`    ${label.padEnd(22)} ${chalk.dim('checking…')}`);
    },
    (result) => {
      // Carriage return + clear-line (ANSI EL), then re-print with status.
      process.stdout.write(`\r\u001b[2K    ${result.label.padEnd(22)} ${formatStatus(result)}\n`);
    },
  );

  const denied = results.filter(r => r.status === 'denied');
  if (denied.length > 0) {
    console.log('');
    console.log(chalk.dim('    You can grant access later in System Settings →'));
    console.log(chalk.dim('    Privacy & Security → Files and Folders → kraki.'));
  }

  markTccWarmed();
}

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

  // Self-hosted relay override — skip login-first routing
  const customRelay = process.env.KRAKI_RELAY_URL;
  if (customRelay) {
    return runSetupDirect(customRelay);
  }

  const tccSteps = needsTccWarmup() ? 1 : 0;
  const total = 4 + tccSteps;
  const apiBase = process.env.KRAKI_API_URL ?? OFFICIAL_API;

  // 1. Authentication
  console.log(`\n  ${icon} ${step(1, total)} ${chalk.bold('Authentication')}`);

  let ghToken: string | undefined;
  const spinner = ora({ text: 'Checking GitHub CLI…', indent: 4 }).start();
  const ghResult = checkGhAuth();
  if (ghResult.authenticated) {
    spinner.succeed(`Authenticated via GitHub CLI as ${chalk.bold(ghResult.username ?? 'unknown')}`);
    try {
      const { execSync } = await import('node:child_process');
      ghToken = execSync('gh auth token', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || undefined;
    } catch { /* ignore */ }
  } else {
    // Try device flow — need GitHub client ID from the API first
    spinner.info('GitHub CLI not authenticated — signing in via browser');
    let clientId: string | undefined;
    try {
      const configRes = await fetch(`${apiBase}/api/config`, { signal: AbortSignal.timeout(5000) });
      const configData = await configRes.json() as { githubClientId?: string };
      clientId = configData.githubClientId;
    } catch { /* ignore */ }

    if (!clientId) {
      // Fall back to querying the relay directly for client ID
      try {
        const info = await queryRelayInfo(OFFICIAL_RELAY);
        clientId = info.githubClientId;
      } catch { /* ignore */ }
    }

    if (!clientId) {
      throw new Error('Could not obtain GitHub client ID. Install GitHub CLI and run: gh auth login');
    }
    ghToken = await githubDeviceFlow(clientId);
  }

  divider();

  // 2. Resolve region + relay URL
  console.log(`  ${icon} ${step(2, total)} ${chalk.bold('Relay')}`);
  let relay: string;
  let region: string | undefined;

  const resolveSpinner = ora({ text: 'Finding best relay…', indent: 4 }).start();
  try {
    const resolveRes = await fetch(`${apiBase}/api/login/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth: { method: 'github_token', token: ghToken } }),
      signal: AbortSignal.timeout(10_000),
    });
    const resolveData = await resolveRes.json() as {
      ok?: boolean;
      region?: string;
      relayUrl?: string;
      user?: { login?: string };
    };

    if (resolveData.ok && resolveData.relayUrl) {
      relay = resolveData.relayUrl;
      region = resolveData.region;
      resolveSpinner.succeed(`Relay assigned${region ? ` (${region})` : ''}`);
    } else {
      resolveSpinner.info('Could not resolve relay — using default');
      relay = OFFICIAL_RELAY;
    }
  } catch {
    resolveSpinner.info('Could not reach API — using default relay');
    relay = OFFICIAL_RELAY;
  }

  // Verify relay is reachable
  const connSpinner = ora({ text: 'Verifying relay…', indent: 4 }).start();
  try {
    await queryRelayInfo(relay);
    connSpinner.succeed('Relay is reachable');
  } catch (err) {
    connSpinner.fail(`Cannot reach relay: ${(err as Error).message}`);
    // Fall back to manual input
    relay = await promptRelayUrl(OFFICIAL_RELAY);
  }

  divider();

  // 3. Agent check
  console.log(`  ${icon} ${step(3, total)} ${chalk.bold('Agent Verification')}`);
  if (isSea()) {
    const agentSpinner = ora({ text: 'Looking for Copilot CLI…', indent: 4 }).start();
    const copilotResult = await withRetry(
      checkCopilotCli,
      'Copilot CLI',
      'Install from https://docs.github.com/copilot/how-tos/copilot-cli',
      agentSpinner,
    );
    agentSpinner.succeed(`Copilot CLI found (${copilotResult.version ?? 'unknown version'})`);

    const authSpinner = ora({ text: 'Checking Copilot authentication…', indent: 4 }).start();
    const hasGhToken = checkGhAuth().authenticated;
    const hasEnvToken = !!process.env.GITHUB_TOKEN || !!process.env.GH_TOKEN || !!process.env.COPILOT_GITHUB_TOKEN;
    if (hasGhToken || hasEnvToken) {
      authSpinner.succeed('Copilot authentication available');
    } else {
      authSpinner.succeed('Copilot authentication available (via Copilot login)');
    }
  } else {
    const agentSpinner = ora({ text: 'Checking Copilot SDK…', indent: 4 }).start();
    agentSpinner.succeed('Copilot SDK available');
  }

  divider();

  // 4. Device naming
  console.log(`  ${icon} ${step(4, total)} ${chalk.bold('Device Name')}`);
  const defaultName = hostname().replace(/\.local$/, '');
  const deviceName = await input({
    message: 'Device name:',
    theme: promptTheme,
    default: defaultName,
  });

  // 5. macOS Privacy (TCC warm-up) — fresh installs only
  if (tccSteps > 0) {
    console.log('');
    await runTccWarmupStep(5, total);
  }

  // Build config
  const deviceId = getOrCreateDeviceId();
  const config: KrakiConfig = {
    relay,
    authMethod: 'github_token',
    device: { name: deviceName, id: deviceId },
    logging: { verbosity: DEFAULT_LOG_VERBOSITY },
  };

  // Save
  saveConfig(config);

  // Install to PATH (silent — only for SEA binaries)
  installToPath();

  // Summary box
  console.log('');
  printBox([
    `${chalk.green.bold('✔')} ${chalk.bold('Setup complete!')}`,
    '',
    `${chalk.dim('Relay')}    ${chalk.cyan(relay)}`,
    ...(region ? [`${chalk.dim('Region')}   ${chalk.cyan(region)}`] : []),
    `${chalk.dim('Auth')}     ${chalk.cyan('github_token')}`,
    `${chalk.dim('Device')}   ${chalk.cyan(deviceName)}`,
    `${chalk.dim('Logs')}     ${chalk.cyan(DEFAULT_LOG_VERBOSITY)}`,
    '',
    chalk.dim(`Config saved to ${getConfigPath()}`),
  ]);

  return config;
}

/**
 * Direct setup — for self-hosted relays (KRAKI_RELAY_URL set).
 * Connects to the relay, queries capabilities, does inline auth.
 */
async function runSetupDirect(defaultRelay: string): Promise<KrakiConfig> {
  const tccSteps = needsTccWarmup() ? 1 : 0;
  const total = 4 + tccSteps;

  // 1. Relay URL (with retry loop)
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
    relay = relayHost.startsWith('wss://') || relayHost.startsWith('ws://') ? relayHost : `wss://${relayHost}`;

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
        if (action === 'change') break;
      }
    }
  }

  divider();

  // 2. Auth method
  const cliAuthLabels: Record<string, string> = {
    github_token: '  GitHub (recommended)',
    apikey: '  API key',
    open: '  Open (no auth)',
  };

  const hasGitHub = relayInfo.methods.includes('github_token');
  const cliMethods = relayInfo.methods.filter((m) => cliAuthLabels[m]);
  let authMethod: string;

  if (hasGitHub) {
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

  // 3. Agent check
  console.log(`  ${icon} ${step(3, total)} ${chalk.bold('Agent Verification')}`);
  if (isSea()) {
    const spinner = ora({ text: 'Looking for Copilot CLI…', indent: 4 }).start();
    const copilotResult = await withRetry(
      checkCopilotCli,
      'Copilot CLI',
      'Install from https://docs.github.com/copilot/how-tos/copilot-cli',
      spinner,
    );
    spinner.succeed(`Copilot CLI found (${copilotResult.version ?? 'unknown version'})`);

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

  divider();

  // 4. Device naming
  console.log(`  ${icon} ${step(4, total)} ${chalk.bold('Device Name')}`);
  const defaultName = hostname().replace(/\.local$/, '');
  const deviceName = await input({
    message: 'Device name:',
    theme: promptTheme,
    default: defaultName,
  });

  // 5. macOS Privacy (TCC warm-up) — fresh installs only
  if (tccSteps > 0) {
    console.log('');
    await runTccWarmupStep(5, total);
  }

  // Build config
  const deviceId = getOrCreateDeviceId();
  const config: KrakiConfig = {
    relay,
    authMethod: authMethod as KrakiConfig['authMethod'],
    device: { name: deviceName, id: deviceId },
    logging: { verbosity: DEFAULT_LOG_VERBOSITY },
  };

  saveConfig(config);
  installToPath();

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
 * Prompt for relay URL with retry loop. Used as fallback when API is unreachable.
 */
async function promptRelayUrl(defaultRelay: string): Promise<string> {
  while (true) {
    const relayHost = await input({
      message: 'Relay URL:',
      default: defaultRelay.replace(/^wss?:\/\//, ''),
      theme: promptTheme,
    });
    const relay = relayHost.startsWith('wss://') || relayHost.startsWith('ws://') ? relayHost : `wss://${relayHost}`;
    const connSpinner = ora({ text: 'Verifying relay…', indent: 4 }).start();
    try {
      await queryRelayInfo(relay);
      connSpinner.succeed('Relay is reachable');
      return relay;
    } catch (err) {
      connSpinner.fail(`Cannot reach relay: ${(err as Error).message}`);
    }
  }
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
