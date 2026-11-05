/** config, connect, setup --json, resolve-relay, auth: configuring the relay and signing in. */

import chalk from 'chalk';
import { unlinkSync } from 'node:fs';
import { loadConfig, saveConfig, getConfigPath, getLogVerbosity, type KrakiConfig } from '../config.js';
import { isDaemonRunning } from '../daemon.js';
import { runSetup } from '../setup.js';
import { requestPairingToken, buildPairingUrl, renderQrToTerminal } from '../pair.js';
import type { AgentId } from '@kraki/protocol';
import { loadManagedBy } from '../managed.js';
import { gracefulExit } from './exit.js';
import { cmdRestart, restartManaged, silentStart } from './lifecycle.js';

export function cmdConfig(): void {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.yellow('No config found. Run `kraki` to set up.'));
    gracefulExit(1);
    return;
  }
  console.log(JSON.stringify(config, null, 2));
}

export function cmdConfigRemoteUpdate(value?: string): void {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.yellow('No config found. Run `kraki` to set up.'));
    gracefulExit(1);
    return;
  }
  if (!value) {
    console.log(`Remote update: ${config.remoteUpdate === false ? 'off' : 'on'}`);
    return;
  }
  if (value !== 'on' && value !== 'off') {
    console.log(chalk.red(`Invalid value: ${value}`));
    console.log(chalk.dim('Use `kraki config remote-update on` or `kraki config remote-update off`.'));
    gracefulExit(1);
    return;
  }
  saveConfig({ ...config, remoteUpdate: value === 'on' });
  console.log(value === 'on'
    ? chalk.green('Your apps can now update Kraki on this computer.')
    : chalk.green('Remote update is off. Update Kraki here with `kraki update`.'));
}

export function cmdConfigLog(verbosity?: string): void {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.yellow('No config found. Run `kraki` to set up.'));
    gracefulExit(1);
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

export async function cmdConfigReset(): Promise<void> {
  const configPath = getConfigPath();
  // This computer keeps its identity (device-id) through a reset, so it keeps
  // its name too: setup fell back to the hostname once the config was gone,
  // silently renaming it on every phone (K-270).
  const previousName = loadConfig()?.device.name;
  try {
    unlinkSync(configPath);
    console.log(chalk.dim('Config deleted.'));
  } catch {
    // Config may not exist
  }
  await runSetup(previousName ? { deviceName: previousName } : {});
  const managed = loadManagedBy();
  if (managed) {
    await restartManaged(managed);
    return;
  }
  // A `kraki start` daemon still runs on the old relay and sign-in; restart it
  // so it uses the new config (K-124). A stopped one stays stopped.
  if (isDaemonRunning()) await cmdRestart();
}

export async function cmdConnect(urlOnly = false, jsonOutput = false): Promise<void> {
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
    gracefulExit(1);
    return;
  }

  if (!urlOnly && !jsonOutput) {
    console.log(chalk.dim('  Requesting pairing token from relay...'));
  }

  try {
    const { relayAuthToken } = await import('../setup.js');
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
    gracefulExit(1);
  }
}

// ── kraki setup --headless — non-interactive setup ──────

/** Sign-in methods a computer can be set up with (the wizard offers the same). */
const HEADLESS_AUTH_METHODS = ['github_token', 'apikey', 'open'] as const;
type HeadlessAuthMethod = typeof HEADLESS_AUTH_METHODS[number];

function isRelayUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'ws:' || url.protocol === 'wss:') && url.hostname !== '';
  } catch {
    return false;
  }
}

export function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

export async function cmdSetupHeadless(args: string[]): Promise<void> {
  const fail = (code: string, message: string): void => {
    process.stdout.write(JSON.stringify({ ok: false, error: message, code }) + '\n');
    gracefulExit(1);
  };

  const relayArg = getArgValue(args, '--relay')?.trim();
  // `--auth github` is the relay's spelling (head README, docs/self-hosting.md).
  const authArg = getArgValue(args, '--auth') ?? 'github_token';
  const auth = authArg === 'github' ? 'github_token' : authArg;
  const apiKey = getArgValue(args, '--api-key')?.trim();
  const deviceName = getArgValue(args, '--device-name');
  const githubToken = getArgValue(args, '--github-token');
  const agentArg = getArgValue(args, '--agent'); // copilot | claude | codex | pi | both | auto
  const anthropicKey = getArgValue(args, '--anthropic-key');

  if (!relayArg) {
    return fail('missing_relay', '--relay is required');
  }
  // Same rule as the setup wizard: a bare host means wss://.
  const relay = /^[a-z][a-z0-9+.-]*:\/\//i.test(relayArg) ? relayArg : `wss://${relayArg}`;
  if (!isRelayUrl(relay)) {
    return fail('bad_relay', `--relay must be a ws:// or wss:// URL (got "${relayArg}")`);
  }
  if (!HEADLESS_AUTH_METHODS.includes(auth as HeadlessAuthMethod)) {
    return fail('bad_auth', `--auth must be one of: ${HEADLESS_AUTH_METHODS.join(', ')} (got "${auth}")`);
  }
  // An API-key relay registers this computer with the key (saved as the
  // channel key, which the daemon and `kraki connect` send).
  if (auth === 'apikey' && !apiKey) {
    const { loadChannelKey } = await import('../config.js');
    if (!loadChannelKey()) return fail('missing_api_key', '--auth apikey needs --api-key <key>');
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
    case 'pi':
      agents = ['pi'];
      break;
    case 'both':
      agents = ['copilot', 'claude'];
      break;
    default:
      return fail('bad_agent', `--agent must be one of: copilot, claude, codex, pi, both, auto (got "${agentArg}")`);
  }

  // Persist an Anthropic key into ~/.claude/settings.json so the daemon
  // (launched by launchd, no shell env) can read it.
  if (anthropicKey) {
    const { saveAnthropicKey } = await import('../checks.js');
    try {
      saveAnthropicKey(anthropicKey);
    } catch (err) {
      return fail('anthropic_key_write_failed', (err as Error).message);
    }
  }

  // Resolve GitHub token: explicit flag > gh CLI > saved token
  if (auth === 'github_token' && githubToken) {
    const { saveGitHubToken } = await import('../config.js');
    saveGitHubToken(githubToken);
  }
  if (auth === 'apikey' && apiKey) {
    const { saveChannelKey } = await import('../config.js');
    saveChannelKey(apiKey);
  }

  const { hostname } = await import('node:os');
  const { getOrCreateDeviceId, DEFAULT_LOG_VERBOSITY } = await import('../config.js');
  const deviceId = getOrCreateDeviceId();

  const config: KrakiConfig = {
    relay,
    authMethod: auth as HeadlessAuthMethod,
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

export async function cmdResolveRelay(args: string[]): Promise<void> {
  const jsonOutput = args.includes('--json');
  let token = getArgValue(args, '--github-token');

  // Fall back to Kraki's own saved token (never the GitHub CLI's).
  if (!token) {
    const { loadGitHubToken } = await import('../config.js');
    token = loadGitHubToken() ?? undefined;
  }

  const { resolveRelay } = await import('../setup.js');
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

// ── kraki auth — headless GitHub device flow ────────────

export async function cmdAuth(args: string[]): Promise<void> {
  const clientId = getArgValue(args, '--client-id');
  if (!clientId) {
    process.stderr.write('error: --client-id is required\n');
    gracefulExit(1);
    return;
  }

  // Step 1: Request device code
  let res: Response;
  try {
    res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, scope: 'read:user' }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const { githubUnreachableMessage } = await import('../network-errors.js');
    process.stderr.write(`error: ${githubUnreachableMessage(err)}\n`);
    gracefulExit(1);
    return;
  }
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

      const { saveGitHubToken } = await import('../config.js');
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
