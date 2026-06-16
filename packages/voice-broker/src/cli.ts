#!/usr/bin/env node
/**
 * Kraki voice-broker CLI dispatcher.
 *
 * Subcommands:
 *   mock      Start a local mock Doubao server. Useful for testing without creds.
 *   serve     Start the broker WSS server. Will spawn an internal mock if
 *             DOUBAO_MOCK=1 or no real creds are set.
 *   probe     Stream an audio file to Doubao (real or mock) and print transcripts.
 *   web       Serve the test mic-capture page (web/index.html).
 *   all       mock + broker + web in one process — full local end-to-end stack.
 */

import { config as dotenvConfig } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockDoubao } from './mock-doubao.js';
import { startBroker, type BrokerOptions } from './server.js';
import { startWebServer } from './web-server.js';
import { createLogger, levelFromEnv } from './logger.js';

// Load .env from the package dir (works regardless of cwd).
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '..', '.env') });

const pkgPath = resolve(__dirname, '..', 'package.json');
const VERSION: string = existsSync(pkgPath) ? (JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0') : '0.0.0';

const rawArgs = process.argv.slice(2);
const cmd = rawArgs[0] && !rawArgs[0].startsWith('-') ? rawArgs[0] : 'serve';
const args = cmd === rawArgs[0] ? rawArgs.slice(1) : rawArgs;

const log = createLogger('cli', levelFromEnv(process.env.LOG_LEVEL));

function usage(): void {
  process.stdout.write(
    [
      `kraki voice-broker v${VERSION}`,
      '',
      'Usage: kraki-voice-broker <command> [options]',
      '',
      'Commands:',
      '  mock       Start mock Doubao server (no creds needed)',
      '  serve      Start the broker WSS server',
      '  probe      Stream an audio file and print transcripts',
      '  web        Serve the mic-capture test page',
      '  all        mock + broker + web in one process (recommended for local dev)',
      '  --help     Show this help',
      '',
      'Env (see .env.example):',
      '  DOUBAO_APP_KEY, DOUBAO_ACCESS_KEY, DOUBAO_RESOURCE_ID, DOUBAO_ENDPOINT',
      '  DOUBAO_MOCK=1               force the in-process mock for serve/probe',
      '  BROKER_PORT (default 7800)  broker WSS port',
      '  MOCK_DOUBAO_PORT (def 7801) mock Doubao WS port',
      '  WEB_PORT (default 7802)     web test page port',
      '',
      'Lease auth (production):',
      '  BROKER_LEASE_PUBLIC_KEY_PEM   Pinned head pubkey PEM, inline (preferred for env-only deploys)',
      '  BROKER_LEASE_PUBLIC_KEY_PATH  Path to a PEM file containing the head pubkey',
      '  BROKER_DEV_NO_AUTH=1          (DEV ONLY) skip lease verification; broker logs a loud warning',
      '',
    ].join('\n'),
  );
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function loadLeaseAuth(): Pick<BrokerOptions, 'leasePublicKeyPem' | 'devNoAuth'> {
  const devNoAuth = process.env.BROKER_DEV_NO_AUTH === '1';
  const inline = process.env.BROKER_LEASE_PUBLIC_KEY_PEM?.trim();
  const path = process.env.BROKER_LEASE_PUBLIC_KEY_PATH?.trim();
  let pem: string | undefined;
  if (inline) {
    pem = inline.replace(/\\n/g, '\n');
  } else if (path) {
    if (!existsSync(path)) {
      log.error('BROKER_LEASE_PUBLIC_KEY_PATH does not exist', { path });
      process.exit(2);
    }
    pem = readFileSync(path, 'utf-8');
  }
  if (devNoAuth && pem) {
    log.error('BROKER_DEV_NO_AUTH=1 AND a lease pubkey are both set — refusing to start (pick one).');
    process.exit(2);
  }
  if (!devNoAuth && !pem) {
    log.error('voice-broker requires either BROKER_LEASE_PUBLIC_KEY_PEM/_PATH (production) or BROKER_DEV_NO_AUTH=1 (local dev).');
    process.exit(2);
  }
  return { leasePublicKeyPem: pem, devNoAuth };
}

function getDoubaoCreds(allowEmpty: boolean) {
  const appKey = process.env.DOUBAO_APP_KEY ?? '';
  const accessKey = process.env.DOUBAO_ACCESS_KEY ?? '';
  const resourceId = process.env.DOUBAO_RESOURCE_ID ?? 'volc.bigasr.sauc.duration';
  // New-console scheme: only DOUBAO_ACCESS_KEY (the API Key) is required.
  // Legacy: also need DOUBAO_APP_KEY.
  if (!allowEmpty && !accessKey) {
    log.error('missing DOUBAO_ACCESS_KEY (new-console API Key). Set DOUBAO_MOCK=1 to bypass.');
    process.exit(2);
  }
  return { appKey, accessKey, resourceId };
}

async function runMock(): Promise<void> {
  const port = envInt('MOCK_DOUBAO_PORT', 7801);
  const mock = await startMockDoubao({ port, requireAuthHeaders: true });
  log.info('mock Doubao listening', { url: mock.url });
  setupShutdown(async () => {
    await mock.close();
  });
}

async function runBroker(): Promise<void> {
  const useMock = process.env.DOUBAO_MOCK === '1';
  let endpoint = process.env.DOUBAO_ENDPOINT ?? 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
  const creds = getDoubaoCreds(useMock);

  let mock: Awaited<ReturnType<typeof startMockDoubao>> | null = null;
  if (useMock) {
    mock = await startMockDoubao({ port: envInt('MOCK_DOUBAO_PORT', 7801), requireAuthHeaders: false });
    endpoint = mock.url;
    log.info('broker will use in-process mock Doubao', { endpoint });
  }

  const broker = await startBroker({
    port: envInt('BROKER_PORT', 7800),
    doubaoEndpoint: endpoint,
    doubaoAppKey: creds.appKey, // empty for new-console scheme
    doubaoAccessKey: creds.accessKey || 'mock-access-key',
    doubaoResourceId: creds.resourceId,
    ...loadLeaseAuth(),
  });
  log.info('broker ready', { url: broker.url });

  setupShutdown(async () => {
    await broker.close();
    await mock?.close();
  });
}

async function runWeb(): Promise<void> {
  const web = await startWebServer({ port: envInt('WEB_PORT', 7802) });
  log.info('web ready', { url: web.url });
  setupShutdown(async () => {
    await web.close();
  });
}

async function runAll(): Promise<void> {
  // Force mock unless the user provided creds explicitly. In the new-console
  // scheme only DOUBAO_ACCESS_KEY is required.
  if (process.env.DOUBAO_MOCK !== '0' && !process.env.DOUBAO_ACCESS_KEY) {
    process.env.DOUBAO_MOCK = '1';
    log.info('no real Doubao creds detected — using mock');
  }
  // `all` is local dev convenience — default to no-auth unless the operator
  // has explicitly wired up a pubkey.
  if (!process.env.BROKER_LEASE_PUBLIC_KEY_PEM && !process.env.BROKER_LEASE_PUBLIC_KEY_PATH && !process.env.BROKER_DEV_NO_AUTH) {
    process.env.BROKER_DEV_NO_AUTH = '1';
    log.info('no lease pubkey wired — defaulting to BROKER_DEV_NO_AUTH=1 (local dev)');
  }

  const useMock = process.env.DOUBAO_MOCK === '1';
  let endpoint = process.env.DOUBAO_ENDPOINT ?? 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
  const creds = getDoubaoCreds(useMock);

  const mock = useMock
    ? await startMockDoubao({ port: envInt('MOCK_DOUBAO_PORT', 7801), requireAuthHeaders: false })
    : null;
  if (mock) endpoint = mock.url;

  const broker = await startBroker({
    port: envInt('BROKER_PORT', 7800),
    doubaoEndpoint: endpoint,
    doubaoAppKey: creds.appKey, // empty for new-console scheme
    doubaoAccessKey: creds.accessKey || 'mock-access-key',
    doubaoResourceId: creds.resourceId,
    ...loadLeaseAuth(),
  });
  const web = await startWebServer({ port: envInt('WEB_PORT', 7802) });

  log.info('full local stack ready');
  log.info(`  • mock Doubao:  ${mock?.url ?? '(disabled — using real Doubao)'}`);
  log.info(`  • broker WSS:   ${broker.url}`);
  log.info(`  • web test UI:  ${web.url}`);
  log.info('open the web URL in a browser to test mic capture → broker → Doubao');

  setupShutdown(async () => {
    await web.close();
    await broker.close();
    await mock?.close();
  });
}

function setupShutdown(close: () => Promise<void>): void {
  let shuttingDown = false;
  const handler = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { sig });
    try {
      await close();
    } catch (err) {
      log.warn('shutdown error', { error: (err as Error).message });
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void handler('SIGINT'));
  process.on('SIGTERM', () => void handler('SIGTERM'));
}

async function main(): Promise<void> {
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }

  if (cmd === 'probe') {
    // Hand off to the probe entry point; preserve the user's args.
    process.argv = [process.argv[0], process.argv[1], ...args];
    await import('./probe.js');
    return;
  }

  switch (cmd) {
    case 'mock':
      await runMock();
      break;
    case 'serve':
      await runBroker();
      break;
    case 'web':
      await runWeb();
      break;
    case 'all':
      await runAll();
      break;
    default:
      log.error('unknown command', { cmd });
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  log.error('fatal', { error: (err as Error).message });
  process.exit(1);
});
