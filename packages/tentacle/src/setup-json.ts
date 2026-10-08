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
 *   --force-login          Ignore the saved token and run the device flow
 *   --oauth                Sign in through the browser instead of a device code:
 *                          emits {"event":"oauth_url","url":…,"callbackScheme":"kraki"},
 *                          then reads the kraki://auth/callback?… URL the app
 *                          received from one line on stdin. The PKCE verifier
 *                          never leaves this process; the server adds the client
 *                          secret (POST /api/auth/github/token). Official
 *                          Kraki only; a self-hosted relay uses the device flow.
 *                          Fails with code "oauth_unavailable" on servers that
 *                          predate the exchange endpoint, so the app can fall back.
 */

import { hostname } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
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
  | { event: 'oauth_url'; url: string; callbackScheme: string }
  | { event: 'authenticated'; username: string; source: TokenSource }
  | { event: 'relay'; relay: string; region: string | null; fallback: boolean }
  | { event: 'done'; configPath: string; relay: string; username: string | null; deviceName: string }
  | { event: 'error'; code: string; message: string };

type TokenSource = 'saved' | 'device_flow' | 'oauth';

/** Where GitHub sends the browser; a sub-path of the registered /auth/callback. */
export const DESKTOP_OAUTH_CALLBACK_PATH = '/auth/callback/desktop';
export const DESKTOP_OAUTH_SCHEME = 'kraki';

export interface SetupJsonDeps {
  emit: (event: SetupJsonEvent) => void;
  fetch: typeof fetch;
  /** @deprecated Ignored: Kraki no longer reuses the GitHub CLI token. */
  ghAuthToken?: () => string | null;
  sleep: (ms: number) => Promise<void>;
  queryRelayInfo: (url: string) => Promise<{ githubClientId?: string; methods?: string[] }>;
  resolveRelay: (token: string) => Promise<{ ok: boolean; relayUrl: string; region?: string }>;
  apiBase: string;
  officialRelay: string;
  /** Kraki web origin that hosts the desktop OAuth bounce page. */
  webBase: string;
  /** One line from stdin (the OAuth callback URL); null on EOF. */
  readLine: () => Promise<string | null>;
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

const base64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function browserFlow(deps: SetupJsonDeps): Promise<string> {
  const clientId = await resolveClientId(deps);
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(16));
  const redirectUri = `${deps.webBase}${DESKTOP_OAUTH_CALLBACK_PATH}`;
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: clientId,
    scope: 'read:user',
    state,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  deps.emit({ event: 'oauth_url', url: url.toString(), callbackScheme: DESKTOP_OAUTH_SCHEME });

  const line = await deps.readLine();
  if (!line) throw new SetupJsonError('cancelled', 'GitHub sign-in was cancelled.');
  let callback: URL;
  try { callback = new URL(line.trim()); } catch { throw new SetupJsonError('bad_callback', 'Invalid sign-in callback.'); }
  const params = callback.searchParams;
  if (params.get('error') === 'access_denied') throw new SetupJsonError('denied', 'GitHub sign-in was cancelled.');
  const code = params.get('code');
  if (!code || params.get('state') !== state) {
    throw new SetupJsonError('bad_callback', 'GitHub sign-in could not be verified. Try again.');
  }

  let res: Response;
  try {
    res = await deps.fetch(`${deps.apiBase}/api/auth/github/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, codeVerifier: verifier, redirectUri }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new SetupJsonError('network', `Could not reach Kraki (${(err as Error).message}).`);
  }
  if (res.status === 404 || res.status === 401) {
    // Server predates the exchange endpoint: the app falls back to a device code.
    throw new SetupJsonError('oauth_unavailable', 'Browser sign-in is not available yet.');
  }
  const body = await res.json().catch(() => ({})) as { ok?: boolean; token?: string; message?: string };
  if (!res.ok || !body.token) {
    throw new SetupJsonError('exchange_failed', body.message ?? `GitHub sign-in failed (${res.status}).`);
  }
  return body.token;
}

async function resolveToken(
  deps: SetupJsonDeps,
  forceLogin: boolean,
  useBrowser: boolean,
): Promise<{ token: string; username: string; source: TokenSource }> {
  // Never reuse `gh auth token`: its scopes (repo, workflow, …) are far wider
  // than the read:user Kraki asks for, and it would be handed to the relay.
  if (!forceLogin) {
    const saved = loadGitHubToken();
    if (saved) {
      const username = await githubUser(deps, saved);
      if (username) return { token: saved, username, source: 'saved' };
    }
  }
  const token = useBrowser ? await browserFlow(deps) : await deviceFlow(deps);
  const username = await githubUser(deps, token);
  if (!username) throw new SetupJsonError('token_invalid', 'GitHub did not accept the new sign-in. Try again.');
  // Persisted with the config at the very end, so a cancelled run writes nothing.
  return { token, username, source: useBrowser ? 'oauth' : 'device_flow' };
}

export async function runSetupJsonWith(args: string[], deps: SetupJsonDeps): Promise<number> {
  deps.emit({ event: 'start', version: getVersion() });
  try {
    const explicitRelay = getArg(args, '--relay') ?? process.env.KRAKI_RELAY_URL;
    if (explicitRelay) {
      // A self-hosted relay without accounts (`--auth open`) needs no GitHub
      // sign-in; signing in anyway left a config the relay refused, and the
      // app then said the sign-in had expired.
      let methods: string[] | undefined;
      try {
        methods = (await deps.queryRelayInfo(explicitRelay)).methods;
      } catch (err) {
        throw new SetupJsonError('relay_unreachable', `Cannot reach the Kraki relay (${(err as Error).message}).`);
      }
      if (methods?.length && !methods.includes('github_token')) {
        if (!methods.includes('open')) {
          throw new SetupJsonError('relay_auth_unsupported', "This relay doesn't accept GitHub sign-in. Pair this computer with a code from the relay's owner instead.");
        }
        deps.emit({ event: 'relay', relay: explicitRelay, region: null, fallback: false });
        const existing = loadConfig();
        const deviceName = getArg(args, '--device-name') ?? existing?.device.name ?? hostname().replace(/\.local$/, '');
        saveConfig({
          ...(existing ?? {}),
          relay: explicitRelay,
          authMethod: 'open',
          device: { name: deviceName, id: getOrCreateDeviceId() },
          logging: existing?.logging ?? { verbosity: DEFAULT_LOG_VERBOSITY },
        });
        deps.emit({ event: 'done', configPath: getConfigPath(), relay: explicitRelay, username: null, deviceName });
        return 0;
      }
    }
    // Browser sign-in goes through the official web + account API; a
    // self-hosted relay keeps the device flow it has always used.
    const useBrowser = args.includes('--oauth') && !explicitRelay;
    const { token, username, source } = await resolveToken(deps, args.includes('--force-login'), useBrowser);
    deps.emit({ event: 'authenticated', username, source });

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
    if (source !== 'saved') saveGitHubToken(token);
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
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    queryRelayInfo: (url) => setup.queryRelayInfo(url),
    resolveRelay: (token) => setup.resolveRelay(token),
    apiBase: process.env.KRAKI_API_URL ?? setup.OFFICIAL_API,
    officialRelay: setup.OFFICIAL_RELAY,
    webBase: process.env.KRAKI_WEB_URL ?? 'https://app.kraki.chat',
    readLine: () => readStdinLine(),
  });
}

function readStdinLine(): Promise<string | null> {
  return new Promise((resolve) => {
    let buf = '';
    const done = (value: string | null) => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl >= 0) done(buf.slice(0, nl));
    };
    const onEnd = () => done(buf.length > 0 ? buf : null);
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.resume();
  });
}
