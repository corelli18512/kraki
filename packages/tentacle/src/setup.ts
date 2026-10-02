/**
 * Interactive first-time setup for Kraki tentacle.
 *
 * Guides the user through relay selection, authentication,
 * device naming, and agent verification.
 */

import { select, input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { homedir, hostname, platform, userInfo } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { execSync, spawn } from 'node:child_process';

import {
  DEFAULT_LOG_VERBOSITY,
  type KrakiConfig,
  saveConfig,
  getOrCreateDeviceId,
  getConfigPath,
  loadConfig,
} from './config.js';
import { SETUP_AGENTS, probeFdaAsApp, pollFda, ensureTccBundleRegistered, openTccPane, revealKrakiApp, getKrakiAppBundlePath, refreshPathOnWindows } from './checks.js';
import { printAnimatedBanner } from './banner.js';
import { termLink } from './term-link.js';
import { findMacAppWithBuiltIn } from './managed.js';
import { runAgentsCheckChild, type AgentCheckResult } from './agents-check.js';
import { isSea } from 'node:sea';

/**
 * Silently install the current binary as `kraki` in a PATH directory.
 * Only runs when executing as a SEA binary. Skips on errors.
 */
function installToPath(): void {
  if (!isSea()) return;
  // Installed as Kraki.app (install.sh / updater): ~/.local/bin/kraki is already
  // a symlink into the bundle. Copying "ourselves" onto it would follow the
  // symlink and rewrite the running bundle executable in place, which breaks
  // its code-signature state; LaunchServices then refuses to launch the daemon
  // ("Launchd job spawn failed", 162) until the cache settles ~30s later.
  if (getKrakiAppBundlePath()) return;

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
    }
  } catch {
    // Silent failure — not critical
  }
}

export const OFFICIAL_RELAY = 'wss://relay.kraki.chat';
export const OFFICIAL_API = 'https://relay.kraki.chat';

/** Same wording as Kraki for Mac's setup ("Step 1 of 2 · Set up this computer"). */
function stepHeader(n: number, total: number, title: string): void {
  console.log('');
  console.log(`  ${chalk.hex('#2384d4').bold(`Step ${n} of ${total}`)}  ${chalk.bold(title)}`);
  console.log('');
}
function subhead(title: string): void {
  console.log(`    ${chalk.dim(title.toUpperCase())}`);
}

/**
 * Full Disk Access, as in Kraki for Mac's first setup step: agents read and
 * edit files across the user's projects, so grant it once and macOS never
 * interrupts a session with a permission prompt. The grant is keyed to the
 * signed Kraki CLI app bundle (registered with Launch Services), so it
 * survives updates. Waits for the grant; Enter skips.
 */
async function runFullDiskAccess(): Promise<void> {
  subhead('Full Disk Access');
  ensureTccBundleRegistered();

  if (await probeFdaAsApp() === 'granted') {
    console.log(`    ${chalk.green('✔')} Allowed. Agents can work in any folder without macOS prompts.`);
    return;
  }

  console.log('    Agents read and edit files across your projects. Allow it once and macOS');
  console.log("    won't interrupt them with permission prompts.");
  console.log('');
  console.log(`    ${chalk.bold('Turn on “Kraki CLI” in the list that opens.')} ${chalk.dim('If it is not there, drag it in')}`);
  console.log(chalk.dim('    from the Finder window that opens next to it.'));
  console.log('');
  // macOS never lists an app under Full Disk Access by itself, and Kraki.app
  // lives in a hidden folder the "+" picker can't easily reach. Open only the
  // FDA pane (the others are feature-specific: `kraki permissions --open`)
  // and reveal the bundle so it can be dragged straight in.
  openTccPane('fda');
  revealKrakiApp();

  const ac = new AbortController();
  const spinner = ora({
    indent: 4,
    text: `Waiting for Full Disk Access…  ${chalk.dim('(Enter to skip)')}`,
  }).start();

  const granted = await Promise.race([
    pollFda(2000, ac.signal, probeFdaAsApp).then((s) => { ac.abort(); return s === 'granted'; }),
    input(
      { message: '' },
      { signal: ac.signal },
    ).then(() => { ac.abort(); return false; })
     .catch(() => false), // AbortError when poll wins
  ]);

  if (granted) {
    spinner.succeed('Full Disk Access allowed');
  } else {
    spinner.warn('Skipped. macOS may ask for permission during sessions; allow it later in System Settings.');
  }
  console.log(chalk.dim(`    Agents that click, type or look at the screen also need Accessibility and Screen Recording: ${chalk.bold('kraki permissions --open')}`));
}

// Align inquirer prefix (✔/?) with ora spinners (4-space indent)
const promptTheme = {
  prefix: { idle: chalk.blue('  ?'), done: chalk.green('  ✔') },
  icon: { cursor: '  ❯' },
};

// Terminal hyperlink (OSC 8)
function link(text: string, url: string): string {
  return termLink(text, url);
}

/**
 * Test if the relay is reachable by opening a WebSocket and waiting for connection.
 */
export interface RelayInfo {
  methods: string[];
  pairing: boolean;
  githubClientId?: string;
}

/**
 * Connect to the relay, query auth_info, and return server capabilities.
 */
export function queryRelayInfo(url: string, timeoutMs = 5000): Promise<RelayInfo> {
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

/**
 * Resolve the best relay + region for a GitHub token via the login API.
 * Shared by interactive setup and the headless `resolve-relay` command.
 * Falls back to the official relay if the API can't be reached.
 */
export interface ResolveRelayResult {
  ok: boolean;
  relayUrl: string;
  region?: string;
  user?: string;
  fallback?: boolean;
  error?: string;
}

export async function resolveRelay(
  ghToken: string | undefined,
  apiBase: string = process.env.KRAKI_API_URL ?? OFFICIAL_API,
): Promise<ResolveRelayResult> {
  try {
    const res = await fetch(`${apiBase}/api/login/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth: { method: 'github_token', token: ghToken } }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json() as {
      ok?: boolean;
      region?: string;
      relayUrl?: string;
      user?: { login?: string };
    };

    if (data.ok && data.relayUrl) {
      return {
        ok: true,
        relayUrl: data.relayUrl,
        region: data.region,
        user: data.user?.login,
      };
    }
    return { ok: false, relayUrl: OFFICIAL_RELAY, fallback: true, error: 'unresolved' };
  } catch (err) {
    return { ok: false, relayUrl: OFFICIAL_RELAY, fallback: true, error: (err as Error).message };
  }
}

// ── Box drawing ─────────────────────────────────────────

/** Terminal columns of a string: CJK, full-width and emoji take two. */
export function displayWidth(s: string): number {
  let width = 0;
  for (const ch of s.replace(/\x1B\[[0-9;]*m/g, '')) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

function printBox(lines: string[]): void {
  const maxLen = Math.max(...lines.map((l) => displayWidth(l)));
  const pad = (s: string) => s + ' '.repeat(maxLen - displayWidth(s));
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
 * Sign in with a GitHub device code. Like Kraki for Mac's code fallback: the
 * code is copied and GitHub opens in the browser right away (no extra
 * keypress); the user pastes it and approves. Saves the token for the daemon.
 */
async function githubDeviceFlow(clientId: string): Promise<{ token: string; username: string }> {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'read:user' }),
  });
  if (!res.ok) throw new Error(`GitHub device code request failed: ${res.status}`);
  const data = await res.json() as DeviceCodeResponse;

  const copied = copyToClipboard(data.user_code);
  const opened = openInBrowser(data.verification_uri);
  console.log(`    Enter this code on GitHub:  ${chalk.bold.hex('#56b9f2')(data.user_code)}${copied ? chalk.dim('  (copied)') : ''}`);
  console.log(chalk.dim(`    ${opened ? 'Opened' : 'Open'} ${link(data.verification_uri, data.verification_uri)}${opened ? ' in your browser.' : ' in a browser.'}`));
  console.log('');

  const spinner = ora({ text: 'Waiting for you to approve Kraki on GitHub…', indent: 4 }).start();
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
      const username = await githubLogin(tokenData.access_token) ?? 'unknown';
      spinner.succeed(`Signed in as ${chalk.bold(username)}`);
      const { saveGitHubToken } = await import('./config.js');
      saveGitHubToken(tokenData.access_token);
      return { token: tokenData.access_token, username };
    }

    if (tokenData.error === 'slow_down') {
      interval += 5000; // RFC 8628: add 5 s to the polling interval for good
    } else if (tokenData.error === 'expired_token') {
      spinner.fail('The code expired.');
      throw new Error('The GitHub code expired. Run `kraki` to try again.');
    } else if (tokenData.error === 'access_denied') {
      spinner.fail('Sign-in was cancelled on GitHub.');
      throw new Error('GitHub sign-in was cancelled.');
    }
    // 'authorization_pending' — keep polling
  }

  spinner.fail('The code expired.');
  throw new Error('The GitHub code expired. Run `kraki` to try again.');
}

async function githubLogin(token: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'kraki-tentacle' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json() as { login?: unknown };
    return typeof body.login === 'string' ? body.login : null;
  } catch {
    return null;
  }
}

function copyToClipboard(text: string): boolean {
  try {
    const os = platform();
    if (os === 'darwin') execSync('pbcopy', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    else if (os === 'win32') execSync('clip', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    else {
      try { execSync('xclip -selection clipboard', { input: text, stdio: ['pipe', 'ignore', 'ignore'] }); }
      catch { execSync('xsel --clipboard', { input: text, stdio: ['pipe', 'ignore', 'ignore'] }); }
    }
    return true;
  } catch {
    return false;
  }
}

/** Open a URL locally, but not from an SSH session (it would open on the remote desktop, or nowhere). */
function openInBrowser(url: string): boolean {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  // Fire and forget: never wait on the browser. On a brand-new Windows account
  // `start <url>` can block indefinitely (no default browser chosen yet), which
  // used to freeze setup before the code was even shown.
  try {
    const os = platform();
    const [cmd, args] = os === 'darwin' ? ['open', [url]]
      : os === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * GitHub sign-in with Kraki's own device code (scope `read:user`).
 *
 * Never reuse `gh auth token`: that token carries the GitHub CLI's broad
 * scopes (repo, workflow, read:org, gist) and would be handed to the relay.
 * Kraki only needs to prove who the user is.
 */
async function signInWithGitHub(clientId: () => Promise<string | undefined>): Promise<{ token: string; username: string }> {
  // Re-setup: Kraki's own saved token is fine to reuse while GitHub accepts it.
  const { loadGitHubToken } = await import('./config.js');
  const saved = loadGitHubToken();
  if (saved) {
    let rejected = false;
    let username: string | null = null;
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${saved}`, 'User-Agent': 'kraki-tentacle' },
        signal: AbortSignal.timeout(10_000),
      });
      rejected = res.status === 401;
      const body = await res.json() as { login?: unknown };
      if (typeof body.login === 'string') username = body.login;
    } catch { /* offline: keep using the saved token */ }
    if (!rejected) {
      console.log(`    ${chalk.green('✔')} Signed in${username ? ` as ${chalk.bold(username)}` : ''}`);
      return { token: saved, username: username ?? 'unknown' };
    }
  }
  const id = await clientId();
  if (!id) throw new Error('Could not reach Kraki to start GitHub sign-in. Check your network connection.');
  return githubDeviceFlow(id);
}

// ── Setup flow ──────────────────────────────────────────

/**
 * Coding agents on this computer, as in Kraki for Mac: each supported agent
 * is checked for real (installed, signed in, models available) by starting it
 * the way sessions will. Read-only — Kraki only relays, so a problem gets a
 * hint for the user to fix in that agent. Agents are auto-detected by the
 * daemon; nothing is pinned in config.
 */
async function runAgentStep(): Promise<AgentCheckResult[]> {
  subhead('Coding agents');
  for (;;) {
    // prefixText, not indent: ora's clear() leaves the cursor at the indent
    // column, which shifts the first row (visibly so on Windows consoles).
    const spinner = ora({ text: 'Checking the coding agents on this computer…', prefixText: '   ' }).start();
    const results = await setupDeps.checkAgents();
    spinner.stop();
    const byId = new Map(results.map((r) => [r.id, r]));
    for (const agent of SETUP_AGENTS) printAgentRow(agent, byId.get(agent.id));
    const ready = results.filter((r) => r.status === 'ready');
    const fixable = results.filter((r) => r.status === 'needs_login' || r.status === 'error');
    console.log('');
    console.log(chalk.dim(`    ${ready.length === 0 ? 'No agent is ready yet.' : ready.length === 1 ? '1 agent is ready.' : `${ready.length} agents are ready.`}`));

    if (ready.length > 0 && fixable.length === 0) return results;
    const choices = ready.length > 0
      ? [{ name: '  Continue', value: 'continue' }, { name: '  Check again', value: 'again' }]
      : [{ name: '  Check again', value: 'again' }, { name: '  Continue without an agent', value: 'continue' }];
    const action = await select({
      message: ready.length > 0 ? 'Fix the agents above in their own app or Terminal, or continue:' : 'Install or sign in to an agent, then check again:',
      theme: promptTheme,
      choices,
    });
    if (action === 'again') refreshPathOnWindows();
    if (action === 'continue') {
      if (ready.length === 0) {
        console.log(chalk.dim(`    Kraki starts without one. After setting one up, run ${chalk.bold('kraki restart')}.`));
      }
      return results;
    }
    console.log('');
  }
}

function printAgentRow(agent: (typeof SETUP_AGENTS)[number], r: AgentCheckResult | undefined): void {
  const version = r?.version ? chalk.dim(` ${r.version}`) : '';
  switch (r?.status) {
    case 'ready': {
      const n = r.models;
      console.log(`    ${chalk.green('✔')} ${agent.name}${version}  ${chalk.dim(`ready · ${n} ${n === 1 ? 'model' : 'models'}`)}`);
      break;
    }
    case 'needs_login':
      console.log(`    ${chalk.yellow('!')} ${agent.name}${version}  ${chalk.yellow('not signed in')}${r.hint ? chalk.dim(` — ${r.hint}`) : ''}`);
      break;
    case 'error':
      console.log(`    ${chalk.yellow('!')} ${agent.name}${version}  ${chalk.yellow("didn't start")}${r.hint ? chalk.dim(` — ${r.hint}`) : ''}`);
      break;
    default:
      console.log(chalk.dim(`    – ${agent.name}  not installed · ${link('how to install', agent.installUrl)}`));
  }
}

/** `kraki agents`: the setup check as a standalone report. */
export async function printAgentsCheck(): Promise<void> {
  console.log('');
  const spinner = ora({ text: 'Checking the coding agents on this computer…', prefixText: '   ' }).start();
  const results = await setupDeps.checkAgents();
  spinner.stop();
  const byId = new Map(results.map((r) => [r.id, r]));
  for (const agent of SETUP_AGENTS) printAgentRow(agent, byId.get(agent.id));
  console.log('');
}

/** Overridable in tests. */
export const setupDeps = {
  checkAgents: (): Promise<AgentCheckResult[]> => runAgentsCheckChild(),
};

/**
 * Kraki for Mac with a built-in tentacle sets Kraki up by itself; a separate
 * CLI setup would create a second owner for the same Mac. Ask before going on.
 * install.sh asks the same question before downloading, so it is skipped when
 * the installer launched us (KRAKI_INSTALL=1).
 */
async function confirmDespiteMacApp(): Promise<void> {
  if (platform() !== 'darwin' || process.env.KRAKI_INSTALL === '1') return;
  const app = findMacAppWithBuiltIn(homedir());
  if (!app) return;
  console.log(chalk.yellow(`  ⚠  Kraki for Mac is installed (${app}).`));
  console.log(chalk.dim('     It sets up Kraki and runs it in the background by itself, so this Mac'));
  console.log(chalk.dim('     doesn\'t need the command-line setup. Open Kraki from Applications instead.'));
  console.log('');
  const proceed = await confirm({
    message: 'Set up the command-line version anyway?',
    default: false,
    theme: promptTheme,
  });
  if (!proceed) {
    const cancelled = new Error('Setup cancelled');
    cancelled.name = 'ExitPromptError';
    throw cancelled;
  }
}

/** Step 1 — this computer: coding agents, then (macOS) Full Disk Access. */
async function runThisComputerStep(n: number, total: number): Promise<AgentCheckResult[]> {
  stepHeader(n, total, 'Set up this computer');
  console.log(chalk.dim('    Kraki runs the coding agents installed here, so you can use them from your'));
  console.log(chalk.dim('    phone, the web and your other computers.'));
  console.log('');
  const agents = await runAgentStep();
  if (platform() === 'darwin') {
    console.log('');
    await runFullDiskAccess();
  }
  return agents;
}

/** A first WebSocket connection can be slow on some networks: retry briefly before asking. */
async function reachRelay(relay: string, attempts = 3): Promise<RelayInfo> {
  for (let i = 1; ; i++) {
    try {
      return await queryRelayInfo(relay, 10_000);
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

/** Keep the device name across re-setup; a new device is named after the host. */
function deviceName(): string {
  return loadConfig()?.device.name ?? defaultDeviceName();
}

/** Windows' factory names ("DESKTOP-7Q2K9JX", "LAPTOP-…") say nothing on a
 *  phone; name those after the user instead. Other hostnames are kept. */
export function defaultDeviceName(host = hostname(), os = platform(), user = safeUsername()): string {
  const name = host.replace(/\.local$/, '');
  if (os === 'win32' && user && /^(DESKTOP|LAPTOP|PC|WIN)-[A-Z0-9]{5,}$/i.test(name)) return `${user}'s Windows PC`;
  return name;
}

function safeUsername(): string | undefined {
  try { return userInfo().username || undefined; } catch { return undefined; }
}

async function officialClientId(apiBase: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${apiBase}/api/config`, { signal: AbortSignal.timeout(5000) });
    const body = await res.json() as { githubClientId?: string };
    if (body.githubClientId) return body.githubClientId;
  } catch { /* fall back to the relay */ }
  try {
    return (await queryRelayInfo(OFFICIAL_RELAY)).githubClientId;
  } catch {
    return undefined;
  }
}

function printDone(lines: { user?: string; relay: string; region?: string; device: string; agents: AgentCheckResult[] }): void {
  const ready = SETUP_AGENTS.filter((a) => lines.agents.some((r) => r.id === a.id && r.status === 'ready')).map((a) => a.name);
  console.log('');
  printBox([
    `${chalk.green.bold('✔')} ${chalk.bold('Kraki is set up')}`,
    '',
    ...(lines.user ? [`${chalk.dim('Signed in')}  ${chalk.cyan(lines.user)}`] : []),
    `${chalk.dim('Agents')}     ${chalk.cyan(ready.length > 0 ? ready.join(', ') : 'none yet')}`,
    `${chalk.dim('Device')}     ${chalk.cyan(lines.device)}`,
    `${chalk.dim('Relay')}      ${chalk.cyan(lines.region ? `${lines.relay} (${lines.region})` : lines.relay)}`,
    '',
    chalk.dim(`Config saved to ${getConfigPath()}`),
  ]);
}

/**
 * First-run setup, in the same order as Kraki for Mac:
 *   1. Set up this computer — coding agents (installed, signed in, models)
 *      and, on macOS, Full Disk Access.
 *   2. Sign in — GitHub (GitHub CLI if signed in, else a device code); the
 *      relay for the account's region is resolved silently.
 * A self-hosted relay (KRAKI_RELAY_URL) adds a relay step first.
 */
export async function runSetup(): Promise<KrakiConfig> {
  await printAnimatedBanner();
  await confirmDespiteMacApp();

  // Self-hosted relay override — skip login-first routing
  const customRelay = process.env.KRAKI_RELAY_URL;
  if (customRelay) {
    return runSetupDirect(customRelay);
  }

  const apiBase = process.env.KRAKI_API_URL ?? OFFICIAL_API;
  const agents = await runThisComputerStep(1, 2);

  stepHeader(2, 2, 'Sign in');
  console.log(chalk.dim('    Sign in with GitHub. This computer then shows up in Kraki on your phone,'));
  console.log(chalk.dim('    the web and your other computers.'));
  console.log('');
  const { token, username } = await signInWithGitHub(() => officialClientId(apiBase));

  const connecting = ora({ text: 'Connecting to Kraki…', indent: 4 }).start();
  const resolved = await resolveRelay(token, apiBase);
  let relay = resolved.relayUrl;
  const region = resolved.region;
  try {
    await reachRelay(relay);
    connecting.succeed(`Connected${region ? ` (${region})` : ''}`);
  } catch (err) {
    connecting.fail(`Cannot reach ${relay.replace(/^wss?:\/\//, '')}: ${(err as Error).message}`);
    relay = await promptRelayUrl(relay);
  }

  const name = deviceName();
  const config: KrakiConfig = {
    relay,
    authMethod: 'github_token',
    device: { name, id: getOrCreateDeviceId() },
    logging: { verbosity: loadConfig()?.logging?.verbosity ?? DEFAULT_LOG_VERBOSITY },
  };
  saveConfig(config);
  installToPath();
  printDone({ user: username, relay, region, device: name, agents });
  return config;
}

/**
 * Self-hosted relay (KRAKI_RELAY_URL): relay, this computer, sign in.
 */
async function runSetupDirect(defaultRelay: string): Promise<KrakiConfig> {
  const total = 3;

  // 1. Relay URL (with retry loop)
  stepHeader(1, total, 'Relay');
  let relay: string = defaultRelay;
  let relayInfo: RelayInfo = { methods: ['open'], pairing: true };
  for (let confirmed = false; !confirmed;) {
    const relayHost = await input({
      message: 'Relay:',
      default: defaultRelay.replace(/^wss:\/\//, ''), // keep ws:// so the default isn't upgraded to TLS
      theme: promptTheme,
      validate: (v) => (v.includes(' ') ? 'Invalid URL' : true),
    });
    relay = relayHost.startsWith('wss://') || relayHost.startsWith('ws://') ? relayHost : `wss://${relayHost}`;

    while (true) {
      const connSpinner = ora({ text: 'Querying relay…', indent: 4 }).start();
      try {
        relayInfo = await queryRelayInfo(relay);
        connSpinner.succeed('Relay is reachable');
        confirmed = true;
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

  // 2. This computer
  const agents = await runThisComputerStep(2, total);

  // 3. Sign in (whatever the relay supports)
  stepHeader(3, total, 'Sign in');
  const cliAuthLabels: Record<string, string> = {
    github_token: '  GitHub (recommended)',
    apikey: '  API key',
    open: '  Open (no auth)',
  };
  const cliMethods = relayInfo.methods.filter((m) => cliAuthLabels[m]);
  let authMethod: string;
  let user: string | undefined;
  if (relayInfo.methods.includes('github_token')) {
    authMethod = 'github_token';
    user = (await signInWithGitHub(async () => relayInfo.githubClientId)).username;
  } else if (cliMethods.length === 1) {
    authMethod = cliMethods[0];
    console.log(chalk.dim(`    ${cliAuthLabels[authMethod]?.trim() ?? authMethod}`));
  } else if (cliMethods.length > 1) {
    authMethod = await select({
      message: 'Authentication:',
      theme: promptTheme,
      choices: cliMethods.map((m) => ({ name: cliAuthLabels[m], value: m })),
    });
  } else {
    throw new Error('No supported auth method found on this relay');
  }

  const name = deviceName();
  const config: KrakiConfig = {
    relay,
    authMethod: authMethod as KrakiConfig['authMethod'],
    device: { name, id: getOrCreateDeviceId() },
    logging: { verbosity: loadConfig()?.logging?.verbosity ?? DEFAULT_LOG_VERBOSITY },
  };
  saveConfig(config);
  installToPath();
  printDone({ user, relay, device: name, agents });
  return config;
}

/**
 * Prompt for relay URL with retry loop. Used as fallback when API is unreachable.
 */
async function promptRelayUrl(defaultRelay: string): Promise<string> {
  while (true) {
    const relayHost = await input({
      message: 'Relay URL:',
      default: defaultRelay.replace(/^wss:\/\//, ''), // keep ws:// so the default isn't upgraded to TLS
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
 * The credential this computer presents to the relay for a pairing request.
 * GitHub: only Kraki's own read:user token (~/.kraki/github-token). Installs
 * that predate this lived on the GitHub CLI token; when `interactive`, sign
 * in once with a device code instead, otherwise fail with what to run.
 */
export async function relayAuthToken(config: KrakiConfig, interactive: boolean): Promise<string | undefined> {
  if (config.authMethod === 'open') return 'dev';
  if (config.authMethod !== 'github_token') return undefined;
  const { loadGitHubToken } = await import('./config.js');
  const saved = loadGitHubToken();
  if (saved) return saved;
  if (!interactive) throw new Error('Sign in to GitHub again: run `kraki connect` in a terminal (one-time code).');
  console.log(chalk.dim('    Kraki now signs in with its own GitHub code instead of the GitHub CLI token.'));
  const apiBase = process.env.KRAKI_API_URL ?? OFFICIAL_API;
  const { token } = await signInWithGitHub(async () =>
    (await officialClientId(apiBase)) ?? (await queryRelayInfo(config.relay).catch(() => undefined))?.githubClientId);
  return token;
}

/**
 * Generate and display pairing QR code.
 * Called by CLI after daemon is started.
 */
export async function showPairingQr(config: KrakiConfig): Promise<void> {
  console.log('');
  const pairSpinner = ora({ text: 'Creating a connect code…', indent: 2 }).start();
  try {
    pairSpinner.stop();
    const token = await relayAuthToken(config, true);
    pairSpinner.start();

    const { requestPairingToken, buildPairingUrl, renderQrToTerminal } = await import('./pair.js');
    const info = await requestPairingToken(config.relay, token);
    const url = buildPairingUrl(info);
    const qr = await renderQrToTerminal(url);
    pairSpinner.stop();
    console.log(qr);
    console.log(chalk.dim('  The code works once and expires in 5 minutes (`kraki connect` makes a new one).\n'));
  } catch {
    pairSpinner.warn('Could not create a connect code.');
    console.log(chalk.dim('  Run `kraki connect` later to connect your phone.\n'));
  }
}
