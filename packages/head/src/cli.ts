#!/usr/bin/env node

/**
 * @kraki/head — CLI entry point for the Kraki relay server.
 *
 * Usage:
 *   npx @kraki/head
 *   npx @kraki/head --port 8080
 *
 * Environment variables:
 *   PORT         Server port (default: 4000)
 *   DB_PATH      SQLite database path (default: kraki-head.db)
 *   AUTH_MODE    Auth mode: open | github | apikey (default: open)
 *   API_KEY               API key for apikey auth mode
 *   GITHUB_CLIENT_ID      GitHub OAuth App client ID (for web login)
 *   GITHUB_CLIENT_SECRET  GitHub OAuth App client secret (for web login)
 *   LOG_LEVEL             Log level: debug | info | warn | error (default: info)
 *   LOG_PATH     Log file path (optional)
 */

import { config as dotenvConfig } from 'dotenv';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from the head package directory (works regardless of cwd)
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '..', '.env') });

const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));
const VERSION: string = pkg.version;

import { createServer } from 'http';
import { Storage } from './storage.js';
import { HeadServer } from './server.js';
import { GitHubAuthProvider, OpenAuthProvider, ApiKeyAuthProvider, ThrottledAuthProvider, safeEqual } from './auth.js';
import type { AuthProvider } from './auth.js';
import { Logger, setGlobalLogger } from './logger.js';
import { PushManager, ApnsProvider, WebPushProvider } from './push/index.js';
import type { PushProvider as IPushProvider } from './push/index.js';
import type { AuthBackend } from './auth-backend.js';
import { LocalAuthBackend } from './local-auth-backend.js';
import { RemoteAuthBackend } from './remote-auth-backend.js';
import { AccountApi } from './account-api.js';

// --- CLI flags / subcommands ---
const rawArgs = process.argv.slice(2);
const COMMAND = rawArgs[0] && !rawArgs[0].startsWith('-') ? rawArgs[0] : 'start';
const args = COMMAND === 'start' ? rawArgs : rawArgs.slice(1);
const ENV_PATH = resolve(__dirname, '..', '.env');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  🦑 @kraki/head v${VERSION} — CLI entry point for the Kraki relay server.

  Usage:
    kraki-relay start [options]
    kraki-relay register-edge
    kraki-relay join --main <https-url> --token <token> --region <code> --relay-url <wss-url>
    kraki-relay list-regions [--db <path>]

  Options:
    --port <n>        Server port (default: 4000, env: PORT)
    --db <path>       SQLite database path (default: kraki-head.db, env: DB_PATH)
    --auth <mode>     Auth mode: open | github | apikey (default: open, env: AUTH_MODE)
    --admin-key <key> Enable GET /admin/stats endpoint (env: ADMIN_KEY)
    --push <type>     Push providers: apns,web_push (comma-separated, env: PUSH_PROVIDERS)
    --log <level>     Log level: debug | info | warn | error (default: info)
    --help, -h        Show this help
    --version, -v     Show version

  Multi-region (connected mode):
    --mode <name>          main | edge (env: HEAD_MODE)
    --account-url <url>   Remote account service URL (env: ACCOUNT_URL)
                           When set, auth is delegated to the account service.
    --service-key <key>   Service API key for account service (env: SERVICE_KEY)
    --region <name>       This head's region identifier (env: REGION)
    --public-relay-url <url> Public relay URL for this head (env: PUBLIC_RELAY_URL)
    --region-urls <json>  Region → relay URL map, JSON (env: REGION_URLS, legacy fallback)
                           Example: '{"us":"wss://us.example.com","cn":"wss://cn.example.com"}'

  GitHub OAuth (env only, for web login):
    GITHUB_CLIENT_ID      GitHub OAuth App client ID
    GITHUB_CLIENT_SECRET  GitHub OAuth App client secret

  APNs push notifications (env only):
    APNS_KEY_PATH         Path to .p8 private key file
    APNS_KEY_ID           Key ID from Apple Developer
    APNS_TEAM_ID          Team ID from Apple Developer
    APNS_BUNDLE_ID        App bundle ID (APNs topic)
    APNS_ENVIRONMENT      production | sandbox (default: production)

  Web Push / VAPID (env only):
    VAPID_PUBLIC_KEY      VAPID public key (base64url, from web-push generate-vapid-keys)
    VAPID_PRIVATE_KEY     VAPID private key (base64url)
    VAPID_EMAIL           Contact email (e.g. mailto:admin@example.com)
  `);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION);
  process.exit(0);
}

function flag(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return args[i + 1] || fallback;
}

const PORT = parseInt(flag('port', process.env.PORT || '4000'), 10);
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid port: ${flag('port', process.env.PORT || '4000')}. Must be 1-65535.`);
  process.exit(1);
}
const DB_PATH = flag('db', process.env.DB_PATH || 'kraki-head.db');
const AUTH_MODES = flag('auth', process.env.AUTH_MODE || 'open').split(',').map(s => s.trim());
const API_KEY = process.env.API_KEY;
const ADMIN_KEY = flag('admin-key', process.env.ADMIN_KEY || '');
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const PAIRING = process.env.PAIRING_ENABLED !== 'false'; // default true
const LOG_LEVEL = flag('log', process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error';
const LOG_PATH = process.env.LOG_PATH;
const PUSH_PROVIDERS = flag('push', process.env.PUSH_PROVIDERS || '').split(',').map(s => s.trim()).filter(Boolean);

// --- Multi-region flags ---
const MODE = flag('mode', process.env.HEAD_MODE || process.env.MODE || '');
const ACCOUNT_URL = flag('account-url', process.env.ACCOUNT_URL || '');
const SERVICE_KEY = flag('service-key', process.env.SERVICE_KEY || '');
const REGION = flag('region', process.env.REGION || '');
const PUBLIC_RELAY_URL = flag('public-relay-url', process.env.PUBLIC_RELAY_URL || '');
const REGION_DISPLAY_NAME = flag('display-name', process.env.REGION_DISPLAY_NAME || '');
const MAIN_URL = flag('main-url', process.env.MAIN_URL || '');
const REGION_URLS_RAW = flag('region-urls', process.env.REGION_URLS || '');
let REGION_URLS: Record<string, string> = {};
if (REGION_URLS_RAW) {
  try { REGION_URLS = JSON.parse(REGION_URLS_RAW); } catch {
    console.error('Error: --region-urls must be valid JSON');
    process.exit(1);
  }
}
const IS_CONNECTED_MODE = MODE === 'edge' ? true : MODE === 'main' ? false : !!ACCOUNT_URL;

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function formatEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : JSON.stringify(value);
}

function upsertEnvFile(path: string, updates: Record<string, string>): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf-8').split(/\r?\n/) : [];
  const byKey = new Map(Object.entries(updates).filter(([, value]) => value !== ''));
  const seen = new Set<string>();

  const nextLines = existing.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;
    const key = match[1];
    const replacement = byKey.get(key);
    if (replacement === undefined) return line;
    seen.add(key);
    return `${key}=${formatEnvValue(replacement)}`;
  });

  for (const [key, value] of byKey.entries()) {
    if (!seen.has(key)) nextLines.push(`${key}=${formatEnvValue(value)}`);
  }

  writeFileSync(path, `${nextLines.filter(line => line.trim().length > 0).join('\n')}\n`, 'utf-8');
}

async function runSubcommand(): Promise<void> {
  if (COMMAND === 'start') return;

  if (COMMAND === 'register-edge') {
    if (IS_CONNECTED_MODE) {
      console.error('register-edge is only available on the main/standalone head');
      process.exit(1);
    }

    const storage = new Storage(DB_PATH);
    try {
      const issued = storage.issueEdgeJoinToken();
      console.log(JSON.stringify({
        token: issued.token,
        expiresIn: issued.expiresIn,
      }, null, 2));
    } finally {
      storage.close();
    }
    process.exit(0);
  }

  if (COMMAND === 'join') {
    const token = flag('token', process.env.JOIN_TOKEN || '');
    const main = flag('main', MAIN_URL);
    const joinRegion = flag('region', REGION);
    const joinRelayUrl = flag('relay-url', PUBLIC_RELAY_URL);
    const joinDisplayName = flag('display-name', REGION_DISPLAY_NAME);
    if (!token || !main || !joinRegion || !joinRelayUrl) {
      console.error('Usage: kraki-relay join --main <https-url> --token <token> --region <code> --relay-url <wss-url> [--display-name <name>]');
      process.exit(1);
    }

    let response: Response;
    let data: {
      ok?: boolean;
      code?: string;
      message?: string;
      region?: string;
      relayUrl?: string;
      serviceKey?: string;
    };
    try {
      response = await fetch(`${normalizeBaseUrl(main)}/api/edge/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, region: joinRegion, relayUrl: joinRelayUrl, displayName: joinDisplayName || undefined }),
        signal: AbortSignal.timeout(15_000),
      });
      data = await response.json() as typeof data;
    } catch (err) {
      console.error(`Edge join failed: ${(err as Error).message}`);
      process.exit(1);
    }

    if (!response.ok || !data.ok || !data.region || !data.relayUrl || !data.serviceKey) {
      console.error(`Edge join failed: ${data.message ?? `HTTP ${response.status}`}`);
      process.exit(1);
    }

    upsertEnvFile(ENV_PATH, {
      HEAD_MODE: 'edge',
      ACCOUNT_URL: normalizeBaseUrl(main),
      SERVICE_KEY: data.serviceKey,
      REGION: data.region,
      PUBLIC_RELAY_URL: data.relayUrl,
    });

    console.log(`Joined main at ${normalizeBaseUrl(main)} as region "${data.region}".`);
    console.log(`Saved ACCOUNT_URL, SERVICE_KEY, REGION, and PUBLIC_RELAY_URL to ${ENV_PATH}`);
    process.exit(0);
  }

  if (COMMAND === 'list-regions') {
    const storage = new Storage(DB_PATH);
    try {
      console.log(JSON.stringify({
        version: storage.getRegionVersion(),
        regions: storage.getRegions(false),
      }, null, 2));
    } finally {
      storage.close();
    }
    process.exit(0);
  }

  console.error(`Unknown command "${COMMAND}". Use --help for usage.`);
  process.exit(1);
}

await runSubcommand();

if (IS_CONNECTED_MODE && !ACCOUNT_URL) {
  console.error('Error: --account-url is required in edge/connected mode');
  process.exit(1);
}

async function createAuthProviders(): Promise<Map<string, AuthProvider>> {
  const providers = new Map<string, AuthProvider>();
  for (const mode of AUTH_MODES) {
    switch (mode) {
      case 'github': {
        if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
          console.warn('  ⚠ GitHub OAuth: GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET not set.');
          console.warn('    Web "Sign in with GitHub" will be disabled. Add them to .env or environment.');
          console.warn('    Token auth (gh auth token) and QR pairing still work.');
        }
        const ghProvider = new GitHubAuthProvider({
          clientId: GITHUB_CLIENT_ID,
          clientSecret: GITHUB_CLIENT_SECRET,
        });
        providers.set('github', new ThrottledAuthProvider(ghProvider));
        if (GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET) {
          console.log('  GitHub OAuth configured (web login enabled)');
        }
        break;
      }
      case 'apikey':
        if (!API_KEY) {
          console.error('Error: API_KEY environment variable required for apikey auth mode');
          process.exit(1);
        }
        providers.set('apikey', new ThrottledAuthProvider(new ApiKeyAuthProvider(API_KEY)));
        break;
      case 'open':
        providers.set('open', new OpenAuthProvider());
        break;
      default:
        console.error(`Error: Unknown auth mode '${mode}'. Use: github, apikey, open`);
        process.exit(1);
    }
  }
  return providers;
}

const logger = new Logger({
  level: LOG_LEVEL,
  filePath: LOG_PATH,
  stdout: true,
});
setGlobalLogger(logger);

logger.info('Kraki Head starting...', { mode: IS_CONNECTED_MODE ? 'connected' : 'standalone', region: REGION || '(none)' });

// --- Auth backend setup ---
let authBackend: AuthBackend | undefined;
let accountApi: AccountApi | undefined;
let storage: Storage | undefined;
let directAuthProviders: Map<string, AuthProvider> | undefined;

// --- Push providers (all modes — edges need to deliver push to offline devices) ---
let pushManager: PushManager | undefined;
if (PUSH_PROVIDERS.length > 0) {
  const pushProviderInstances: IPushProvider[] = [];
  for (const provider of PUSH_PROVIDERS) {
    switch (provider) {
      case 'apns': {
        const keyPath = process.env.APNS_KEY_PATH;
        const keyId = process.env.APNS_KEY_ID;
        const teamId = process.env.APNS_TEAM_ID;
        const bundleId = process.env.APNS_BUNDLE_ID;
        if (!keyPath || !keyId || !teamId || !bundleId) {
          console.error('Error: APNs requires APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID');
          process.exit(1);
        }
        pushProviderInstances.push(new ApnsProvider({
          keyPath, keyId, teamId, bundleId,
          environment: (process.env.APNS_ENVIRONMENT as 'production' | 'sandbox') ?? 'production',
        }));
        logger.info('APNs push provider configured', { bundleId, environment: process.env.APNS_ENVIRONMENT ?? 'production' });
        break;
      }
      case 'web_push': {
        const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
        const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
        const vapidEmail = process.env.VAPID_EMAIL;
        if (!vapidPublicKey || !vapidPrivateKey || !vapidEmail) {
          console.error('Error: Web Push requires VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL');
          process.exit(1);
        }
        pushProviderInstances.push(new WebPushProvider({ vapidPublicKey, vapidPrivateKey, vapidEmail }));
        logger.info('Web Push provider configured', { email: vapidEmail });
        break;
      }
      default:
        console.error(`Error: Unknown push provider '${provider}'. Use: apns, web_push`);
        process.exit(1);
    }
  }
  // Storage needed for push token lookups — create early if not yet initialized
  if (!storage) storage = new Storage(DB_PATH);
  pushManager = new PushManager(storage, pushProviderInstances);
}

if (IS_CONNECTED_MODE) {
  // Connected mode: delegate auth to remote account service
  if (!SERVICE_KEY) {
    console.error('Error: --service-key required when --account-url is set');
    process.exit(1);
  }
  const remoteBackend = new RemoteAuthBackend({ accountUrl: ACCOUNT_URL, serviceKey: SERVICE_KEY });
  authBackend = remoteBackend;
  // Fetch config from account service
  await remoteBackend.refreshConfig();
  logger.info('Connected to account service', { url: ACCOUNT_URL, region: REGION });

  // Connected mode still needs local storage for devices, pending, push tokens
  if (!storage) storage = new Storage(DB_PATH);
} else {
  // Standalone mode: local auth + expose account API
  const authProviders = await createAuthProviders();
  directAuthProviders = authProviders;
  if (!storage) storage = new Storage(DB_PATH);

  if (REGION && PUBLIC_RELAY_URL) {
    storage.upsertRegion(REGION, PUBLIC_RELAY_URL, REGION_DISPLAY_NAME || REGION, true);
  }

  const localBackend = new LocalAuthBackend({
    storage,
    authProviders,
    pairingEnabled: PAIRING,
    pushManager,
    region: REGION || undefined,
    regionUrls: REGION_URLS,
  });
  authBackend = localBackend;

  // Expose account API for public region discovery / login-first flows.
  // If SERVICE_KEY is configured it acts as an admin credential; registered
  // edges can also authenticate with their issued per-region service key.
  accountApi = new AccountApi({ authBackend: localBackend, serviceKey: SERVICE_KEY || undefined });
  logger.info('Account API enabled', { adminKeyConfigured: !!SERVICE_KEY });
}

const head = new HeadServer(storage!, {
  authProviders: IS_CONNECTED_MODE ? undefined : directAuthProviders,
  pairingEnabled: PAIRING,
  version: VERSION,
  pushManager,
  authBackend,
  region: REGION || undefined,
});

const startedAt = Date.now();

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Account API routes (standalone mode only)
  if (accountApi && url.pathname.startsWith('/api/')) {
    try {
      const handled = await accountApi.handleRequest(req, res);
      if (handled) return;
    } catch (err) {
      logger.error('Account API error', { error: (err as Error).message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
      return;
    }
  }

  if (url.pathname === '/admin/stats') {
    // CORS for cross-origin admin portal
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!ADMIN_KEY) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token || !safeEqual(token, ADMIN_KEY)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const stats = head.getStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      version: VERSION,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      ...stats,
    }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ name: '@kraki/head', version: VERSION, status: 'ok' }));
});

head.attach(httpServer);

httpServer.listen(PORT, () => {
  logger.info(`Kraki Head listening on port ${PORT}`, {
    ws: `ws://localhost:${PORT}`,
    mode: IS_CONNECTED_MODE ? 'connected' : 'standalone',
    auth: IS_CONNECTED_MODE ? '(delegated)' : AUTH_MODES.join(', '),
    pairing: PAIRING,
    db: DB_PATH,
    region: REGION || '(none)',
    publicRelayUrl: PUBLIC_RELAY_URL || '(none)',
    accountApi: !!accountApi,
  });
});

async function shutdown() {
  logger.info('Shutting down...');
  head.close();
  storage?.close();
  logger.close();
  httpServer.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
