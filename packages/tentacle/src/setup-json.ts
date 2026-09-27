/**
 * `kraki setup --json` — machine-driven first-time setup for Kraki for Mac.
 *
 * The Mac app embeds this tentacle binary and drives setup without a
 * terminal. Progress is streamed as NDJSON on stdout, one event per line:
 *
 *   {"event":"start","version":"0.34.0"}
 *   {"event":"device_code","userCode":"ABCD-1234","verificationUri":"https://github.com/login/device","expiresIn":899}
 *   {"event":"authenticated","username":"octocat","source":"device_flow"}
 *   {"event":"relay","relay":"wss://…","region":"us","fallback":false}
 *   {"event":"done","configPath":"/Users/me/.kraki/config.json","relay":"wss://…","username":"octocat","deviceName":"Mac"}
 *
 * or, on failure, a final `{"event":"error","code":"…","message":"…"}` and
 * exit code 1. The caller cancels by terminating the process; nothing is
 * written until the final step, so a cancelled run leaves no partial config.
 *
 * Flags:
 *   --device-name <name>   Device name (default: existing config, else hostname)
 *   --relay <url>          Use this relay (self-hosted); skips relay resolution
 *   --force-login          Ignore gh / saved tokens and run the device flow
 */

import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  DEFAULT_LOG_VERBOSITY,
  type KrakiConfig,
  getConfigPath,
  getOrCreateDeviceId,
  getVersion,
  loadConfig,
  loadGitHubToken,
  saveConfig,
  saveGitHubToken,
} from './config.js';
import { hydrateLoginShellEnv } from './shell-env.js';

export type SetupJsonEvent =
  | { event: 'start'; version: string }
  | { event: 'device_code'; userCode: string; verificationUri: string; expiresIn: number }
  | { event: 'authenticated'; username: string; source: 'gh' | 'saved' | 'device_flow' }
  | { event: 'relay'; relay: string; region: string | null; fallback: boolean }
  | { event: 'done'; configPath: string; relay: string; username: string; deviceName: string }
  | { event: 'error'; code: string; message: string };

export interface SetupJsonDeps {
  emit: (event: SetupJsonEvent) => void;
  fetch: typeof fetch;
  ghAuthToken: () => string | null;
  sleep: (ms: number) => Promise<void>;
  queryRelayInfo: (url: string) => Promise<{ githubClientId?: string }>;
  resolveRelay: (token: string) => Promise<{ ok: boolean; relayUrl: string; region?: string }>;
  apiBase: string;
  officialRelay: string;
}

class SetupJsonError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function githubUser(deps: SetupJsonDeps, token: string): Promise<string | null> {
  try {
    const res = await deps.fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'kraki-tentacle', Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = await res.json() as { login?: unknown };
    return typeof body.login === 'string' ? body.login : null;
  } catch {
    return null;
  }
}

async function resolveClientId(deps: SetupJsonDeps): Promise<string> {
  try {
    const res = await deps.fetch(`${deps.apiBase}/api/config`, { signal: AbortSignal.timeout(5000) });
    const body = await res.json() as { githubClientId?: string };
    if (body.githubClientId) return body.githubClientId;
  } catch { /* fall back to the relay */ }
  try {
    const info = await deps.queryRelayInfo(deps.officialRelay);
    if (info.githubClientId) return info.githubClientId;
  } catch { /* handled below */ }
  throw new SetupJsonError('client_id_unavailable', 'Could not reach Kraki to start GitHub sign-in. Check your network connection.');
}

async function deviceFlow(deps: SetupJsonDeps): Promise<string> {
  const clientId = await resolveClientId(deps);
  const res = await deps.fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'read:user' }),
  });
  if (!res.ok) throw new SetupJsonError('device_code_failed', `GitHub device code request failed (${res.status})`);
  const code = await res.json() as {
    device_code: string; user_code: string; verification_uri: string; expires_in: number; interval?: number;
  };
  deps.emit({ event: 'device_code', userCode: code.user_code, verificationUri: code.verification_uri, expiresIn: code.expires_in });

  let interval = (code.interval ?? 5) * 1000;
  const deadline = Date.now() + code.expires_in * 1000;
  while (Date.now() < deadline) {
    await deps.sleep(interval);
    let body: Record<string, string>;
    try {
      const tokenRes = await deps.fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          device_code: code.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      body = await tokenRes.json() as Record<string, string>;
    } catch {
      continue; // transient network error: keep polling until the code expires
    }
    if (body.access_token) return body.access_token;
    if (body.error === 'slow_down') interval += 5000;
    else if (body.error === 'expired_token') throw new SetupJsonError('expired', 'The GitHub code expired. Try again.');
    else if (body.error === 'access_denied') throw new SetupJsonError('denied', 'GitHub sign-in was cancelled.');
  }
  throw new SetupJsonError('expired', 'The GitHub code expired. Try again.');
}

async function resolveToken(
  deps: SetupJsonDeps,
  forceLogin: boolean,
): Promise<{ token: string; username: string; source: 'gh' | 'saved' | 'device_flow' }> {
  if (!forceLogin) {
    const gh = deps.ghAuthToken();
    if (gh) {
      const username = await githubUser(deps, gh);
      if (username) return { token: gh, username, source: 'gh' };
    }
    const saved = loadGitHubToken();
    if (saved) {
      const username = await githubUser(deps, saved);
      if (username) return { token: saved, username, source: 'saved' };
    }
  }
  const token = await deviceFlow(deps);
  const username = await githubUser(deps, token);
  if (!username) throw new SetupJsonError('token_invalid', 'GitHub did not accept the new sign-in. Try again.');
  saveGitHubToken(token);
  return { token, username, source: 'device_flow' };
}

export async function runSetupJsonWith(args: string[], deps: SetupJsonDeps): Promise<number> {
  deps.emit({ event: 'start', version: getVersion() });
  try {
    const { token, username, source } = await resolveToken(deps, args.includes('--force-login'));
    deps.emit({ event: 'authenticated', username, source });

    const explicitRelay = getArg(args, '--relay') ?? process.env.KRAKI_RELAY_URL;
    let relay: string;
    let region: string | null = null;
    let fallback = false;
    if (explicitRelay) {
      relay = explicitRelay;
    } else {
      const resolved = await deps.resolveRelay(token);
      relay = resolved.relayUrl;
      region = resolved.region ?? null;
      fallback = !resolved.ok;
    }
    try {
      await deps.queryRelayInfo(relay);
    } catch (err) {
      throw new SetupJsonError('relay_unreachable', `Cannot reach the Kraki relay (${(err as Error).message}).`);
    }
    deps.emit({ event: 'relay', relay, region, fallback });

    const existing = loadConfig();
    const deviceName = getArg(args, '--device-name')
      ?? existing?.device.name
      ?? hostname().replace(/\.local$/, '');
    const config: KrakiConfig = {
      ...(existing ?? {}),
      relay,
      authMethod: 'github_token',
      device: { name: deviceName, id: getOrCreateDeviceId() },
      logging: existing?.logging ?? { verbosity: DEFAULT_LOG_VERBOSITY },
    };
    saveConfig(config);
    deps.emit({ event: 'done', configPath: getConfigPath(), relay, username, deviceName });
    return 0;
  } catch (err) {
    const code = err instanceof SetupJsonError ? err.code : 'unexpected';
    deps.emit({ event: 'error', code, message: (err as Error).message });
    return 1;
  }
}

export async function runSetupJson(args: string[]): Promise<number> {
  // Spawned by a GUI app with LaunchServices' minimal PATH: find `gh` the way
  // the user's terminal would.
  hydrateLoginShellEnv();
  const setup = await import('./setup.js');
  return runSetupJsonWith(args, {
    emit: (event) => process.stdout.write(JSON.stringify(event) + '\n'),
    fetch,
    ghAuthToken: () => {
      try {
        return execFileSync('gh', ['auth', 'token'], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
        }).trim() || null;
      } catch {
        return null;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    queryRelayInfo: (url) => setup.queryRelayInfo(url),
    resolveRelay: (token) => setup.resolveRelay(token),
    apiBase: process.env.KRAKI_API_URL ?? setup.OFFICIAL_API,
    officialRelay: setup.OFFICIAL_RELAY,
  });
}
