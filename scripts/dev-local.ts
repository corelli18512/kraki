#!/usr/bin/env node

/**
 * Real local Kraki stack launcher.
 *
 * Boots:
 *   1. Local head relay (open auth, pairing enabled, E2E on)
 *   2. Real Kraki daemon using an isolated local KRAKI_HOME
 *   3. Real local web app with a stable pairing redirect URL
 *
 * Usage:
 *   pnpm dev
 *   pnpm dev -- --no-open
 *   pnpm dev:stop
 *   pnpm dev:logs
 *   pnpm dev:reset
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';

import { getOrCreateDeviceId, saveConfig, type KrakiConfig } from '../packages/tentacle/src/config.js';
import { startDaemon, stopDaemon } from '../packages/tentacle/src/daemon.js';

const ROOT_DIR = resolve(process.cwd(), '.tmp/kraki-local');
const LOG_DIR = join(ROOT_DIR, 'logs');
const RUN_DIR = join(ROOT_DIR, 'run');
const HEAD_DB_PATH = join(ROOT_DIR, 'kraki-head.db');
const HEAD_LOG_PATH = join(LOG_DIR, 'head.log');
const WEB_LOG_PATH = join(LOG_DIR, 'web.log');
const RELAY_PORT = 4000;
const RELAY_URL = `ws://localhost:${RELAY_PORT}`;
const REDIRECT_PORT = 3100;
const ENTRY_URL = `http://localhost:${REDIRECT_PORT}`;
const STATE_VERSION = 'thin-relay-v1';
const STATE_VERSION_PATH = join(ROOT_DIR, '.state-version');

const PID_FILES = {
  launcher: join(RUN_DIR, 'launcher.pid'),
  head: join(RUN_DIR, 'head.pid'),
  web: join(RUN_DIR, 'web.pid'),
};

process.env.KRAKI_HOME = ROOT_DIR;

let headProcess: ChildProcess | null = null;
let webProcess: ChildProcess | null = null;
let redirectServer: HttpServer | null = null;
let shuttingDown = false;

function ensureDirs(): void {
  mkdirSync(ROOT_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(RUN_DIR, { recursive: true });
}

function ensureLocalStateVersion(): void {
  let currentVersion: string | null = null;
  try {
    currentVersion = readFileSync(STATE_VERSION_PATH, 'utf8').trim() || null;
  } catch {
    currentVersion = null;
  }

  if (currentVersion !== STATE_VERSION && existsSync(ROOT_DIR)) {
    console.log(`♻️ Resetting local Kraki state for ${STATE_VERSION}`);
    rmSync(ROOT_DIR, { recursive: true, force: true });
  }

  ensureDirs();
  writeFileSync(STATE_VERSION_PATH, `${STATE_VERSION}\n`, 'utf8');
}

function readPid(pidPath: string): number | null {
  try {
    const raw = readFileSync(pidPath, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function writePid(pidPath: string, pid: number): void {
  writeFileSync(pidPath, `${pid}\n`, 'utf8');
}

function clearPidFiles(): void {
  for (const pidPath of Object.values(PID_FILES)) {
    try {
      unlinkSync(pidPath);
    } catch {
      // Already gone
    }
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isPidAlive(pid);
}

async function terminatePid(pid: number | null, label: string): Promise<void> {
  if (!pid || pid === process.pid) return;
  if (!isPidAlive(pid)) return;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  if (await waitForProcessExit(pid, 1500)) return;

  try {
    process.kill(pid, 'SIGKILL');
    await waitForProcessExit(pid, 500);
  } catch {
    console.warn(`⚠️  Failed to fully stop ${label} (PID ${pid})`);
  }
}

async function stopLocalStack(options: { includeLauncher: boolean; silent?: boolean } = { includeLauncher: true }): Promise<void> {
  const launcherPid = readPid(PID_FILES.launcher);
  const headPid = readPid(PID_FILES.head);
  const webPid = readPid(PID_FILES.web);

  if (options.includeLauncher) {
    await terminatePid(launcherPid, 'launcher');
  }

  await terminatePid(headPid, 'head');
  await terminatePid(webPid, 'web');
  stopDaemon();
  clearPidFiles();

  if (!options.silent) {
    console.log(`🧹 Local Kraki stack stopped (${ROOT_DIR})`);
  }
}

function waitForRelay(url: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Local relay did not start in time')), timeoutMs);

    const attempt = () => {
      const ws = new WebSocket(url);
      ws.on('open', () => {
        clearTimeout(deadline);
        ws.close();
        resolve();
      });
      ws.on('error', () => {
        ws.close();
        setTimeout(attempt, 300);
      });
    };

    attempt();
  });
}

function requestPairingToken(relayUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Pairing token request timed out'));
    }, 10_000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'request_pairing_token', token: 'dev' }));
    });

    ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === 'pairing_token_created') {
        clearTimeout(timeout);
        resolve(msg.token);
        ws.close();
        return;
      }

      if (msg.type === 'auth_error' || msg.type === 'server_error') {
        clearTimeout(timeout);
        reject(new Error(msg.message));
        ws.close();
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Relay connection failed: ${err.message}`));
    });
  });
}

function buildLocalConfig(): KrakiConfig {
  return {
    relay: RELAY_URL,
    authMethod: 'open',
    device: {
      name: `Local ${hostname()}`,
      id: getOrCreateDeviceId(),
    },
    logging: {
      verbosity: 'verbose',
    },
  };
}

function startHead(): ChildProcess {
  const headLog = createWriteStream(HEAD_LOG_PATH, { flags: 'w' });
  const child = spawn('pnpm', ['exec', 'tsx', 'packages/head/src/cli.ts', '--port', String(RELAY_PORT), '--db', HEAD_DB_PATH], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTH_MODE: 'open',
      E2E_MODE: 'true',
      PAIRING_ENABLED: 'true',
      LOG_LEVEL: 'debug',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.pipe(headLog);
  child.stderr?.pipe(headLog);

  if (!child.pid) {
    throw new Error('Failed to start local head process');
  }

  writePid(PID_FILES.head, child.pid);
  return child;
}

function startWeb(viteEnv: NodeJS.ProcessEnv): { child: ChildProcess; ready: Promise<string> } {
  const webLog = createWriteStream(WEB_LOG_PATH, { flags: 'w' });
  const child = spawn('pnpm', ['--filter', '@kraki/arm-web', 'dev'], {
    cwd: process.cwd(),
    env: viteEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (!child.pid) {
    throw new Error('Failed to start local web process');
  }

  writePid(PID_FILES.web, child.pid);

  const ready = new Promise<string>((resolve, reject) => {
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      webLog.write(chunk);
      const match = text.match(/Local:\s+http:\/\/localhost:(\d+)/);
      if (match) {
        settle(() => resolve(match[1]));
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      webLog.write(chunk);
    });

    child.once('error', (err) => settle(() => reject(err)));
    child.once('exit', (code) => {
      settle(() => reject(new Error(`Web dev server exited early (code ${code ?? 'null'})`)));
    });
  });

  return { child, ready };
}

async function openBrowser(url: string): Promise<void> {
  try {
    execSync(`open -a "Google Chrome" "${url}"`);
  } catch {
    execSync(`open "${url}"`);
  }
}

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  if (redirectServer) {
    await new Promise((resolve) => redirectServer?.close(() => resolve(undefined)));
    redirectServer = null;
  }

  await stopLocalStack({ includeLauncher: false, silent: true });
  clearPidFiles();
  process.exit(code);
}

function hookChildExit(child: ChildProcess, label: string): void {
  child.once('error', (err) => {
    if (shuttingDown) return;
    console.error(`❌ ${label} failed: ${err.message}`);
    void shutdown(1);
  });

  child.once('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`❌ ${label} exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
    void shutdown(typeof code === 'number' ? code : 1);
  });
}

async function start(args: string[]): Promise<void> {
  const noOpen = args.includes('--no-open');

  ensureDirs();
  await stopLocalStack({ includeLauncher: true, silent: true });
  ensureLocalStateVersion();
  writePid(PID_FILES.launcher, process.pid);

  console.log('🔨 Building protocol + crypto...');
  execSync('pnpm --filter @kraki/protocol build && pnpm --filter @kraki/crypto build', {
    cwd: process.cwd(),
    stdio: 'inherit',
  });

  console.log('🧠 Starting local head...');
  headProcess = startHead();
  hookChildExit(headProcess, 'Local head');

  await waitForRelay(RELAY_URL);

  const localConfig = buildLocalConfig();
  saveConfig(localConfig);

  console.log('🦑 Starting real Kraki daemon...');
  const daemonPid = await startDaemon(localConfig);

  let vitePort = '3000';
  let viteReady = false;
  redirectServer = createHttpServer(async (_req, res) => {
    if (!viteReady) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Web app is still starting. Try again in a moment.');
      return;
    }

    try {
      const token = await requestPairingToken(RELAY_URL);
      const params = new URLSearchParams({ relay: RELAY_URL, token });
      res.writeHead(302, { Location: `http://localhost:${vitePort}?${params.toString()}` });
      res.end();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Failed to get pairing token: ${(err as Error).message}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    redirectServer?.once('error', reject);
    redirectServer?.listen(REDIRECT_PORT, () => resolve());
  });

  console.log('🌐 Starting local web app...');
  const { child: webChild, ready } = startWeb({
    ...process.env,
    VITE_WS_URL: RELAY_URL,
    KRAKI_DEV_AUTH_PORT: String(REDIRECT_PORT),
  });
  webProcess = webChild;
  hookChildExit(webProcess, 'Local web app');
  vitePort = await ready;
  viteReady = true;
  const webUrl = `http://localhost:${vitePort}`;

  console.log('');
  console.log('✅ Local Kraki stack is ready');
  console.log(`   Entry URL:   ${ENTRY_URL}`);
  console.log(`   Web URL:     ${webUrl}`);
  console.log(`   Relay URL:   ${RELAY_URL}`);
  console.log(`   Daemon PID:  ${daemonPid}`);
  console.log(`   Kraki home:  ${ROOT_DIR}`);
  console.log(`   Logs:        ${LOG_DIR}`);
  console.log(`   Head DB:     ${HEAD_DB_PATH}`);
  console.log('');
  console.log('   Helpers:');
  console.log('     pnpm dev:logs');
  console.log('     pnpm dev:stop');
  console.log('     pnpm dev:reset');
  console.log('');

  if (!noOpen) {
    let openUrl = ENTRY_URL;
    try {
      const token = await requestPairingToken(RELAY_URL);
      const params = new URLSearchParams({ relay: RELAY_URL, token });
      openUrl = `${webUrl}?${params.toString()}`;
    } catch (err) {
      console.warn(`⚠️  Could not pre-pair browser automatically, falling back to entry URL: ${(err as Error).message}`);
    }

    console.log('🌐 Opening browser with fresh pairing...');
    try {
      await openBrowser(openUrl);
    } catch (err) {
      console.warn(`⚠️  Could not open browser automatically: ${(err as Error).message}`);
    }
  }
}

function showLogs(): void {
  if (!existsSync(LOG_DIR)) {
    console.log(`No local log directory found at ${LOG_DIR}`);
    return;
  }

  const child = spawn('tail', ['-n', '80', '-f', join(LOG_DIR, '*.log')], {
    stdio: 'inherit',
    shell: true,
  });

  child.on('error', (err) => {
    console.error(`Failed to tail logs: ${err.message}`);
    process.exit(1);
  });
}

async function reset(): Promise<void> {
  await stopLocalStack({ includeLauncher: true, silent: true });
  rmSync(ROOT_DIR, { recursive: true, force: true });
  console.log(`🧼 Reset local Kraki state at ${ROOT_DIR}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const command = args[0] ?? 'start';

  process.on('SIGINT', () => { void shutdown(0); });
  process.on('SIGTERM', () => { void shutdown(0); });

  if (command === 'stop') {
    await stopLocalStack({ includeLauncher: true });
    return;
  }

  if (command === 'logs') {
    showLogs();
    return;
  }

  if (command === 'reset') {
    await reset();
    return;
  }

  if (command === 'start' || command === '--no-open') {
    await start(args);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error('Usage: pnpm dev | pnpm dev:stop | pnpm dev:logs | pnpm dev:reset');
  process.exit(1);
}

main().catch((err) => {
  console.error(`❌ ${(err as Error).message}`);
  void shutdown(1);
});
