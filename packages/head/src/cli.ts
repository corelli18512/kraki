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
import { readFileSync } from 'fs';
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
import { GitHubAuthProvider, OpenAuthProvider, ApiKeyAuthProvider, ThrottledAuthProvider } from './auth.js';
import type { AuthProvider } from './auth.js';
import { Logger, setGlobalLogger } from './logger.js';

// --- CLI flags ---
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  🦑 @kraki/head v${VERSION} — CLI entry point for the Kraki relay server.

  Usage: kraki-relay [options]

  Options:
    --port <n>      Server port (default: 4000, env: PORT)
    --db <path>     SQLite database path (default: kraki-head.db, env: DB_PATH)
    --auth <mode>   Auth mode: open | github | apikey (default: open, env: AUTH_MODE)
    --log <level>   Log level: debug | info | warn | error (default: info)
    --help, -h      Show this help
    --version, -v   Show version

  GitHub OAuth (env only, for web login):
    GITHUB_CLIENT_ID      GitHub OAuth App client ID
    GITHUB_CLIENT_SECRET  GitHub OAuth App client secret
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
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const PAIRING = process.env.PAIRING_ENABLED !== 'false'; // default true
const LOG_LEVEL = flag('log', process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error';
const LOG_PATH = process.env.LOG_PATH;

function createAuthProviders(): Map<string, AuthProvider> {
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

logger.info('Kraki Head starting...');

const authProviders = createAuthProviders();
const storage = new Storage(DB_PATH);
const head = new HeadServer(storage, {
  authProviders,
  pairingEnabled: PAIRING,
  version: VERSION,
});

const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ name: '@kraki/head', version: VERSION, status: 'ok' }));
});

head.attach(httpServer);

httpServer.listen(PORT, () => {
  logger.info(`Kraki Head listening on port ${PORT}`, {
    ws: `ws://localhost:${PORT}`,
    auth: AUTH_MODES.join(', '),
    pairing: PAIRING,
    db: DB_PATH,
  });
});

async function shutdown() {
  logger.info('Shutting down...');
  head.close();
  storage.close();
  logger.close();
  httpServer.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
