/**
 * Dev helper: start the web app and open Chrome.
 *
 * Usage:
 *   pnpm dev:web              — auto-pair with prod relay (from ~/.kraki/config.json)
 *   pnpm dev:web --local-relay — point at ws://localhost:4000
 */

import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { WebSocket } from 'ws';

const LOCAL_RELAY = 'ws://localhost:4000';

interface KrakiConfig {
  relay: string;
  authMethod: 'github' | 'channel-key' | 'open';
}

function loadConfig(): KrakiConfig {
  const configPath = join(homedir(), '.kraki', 'config.json');
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error('No ~/.kraki/config.json found. Run `pnpm kraki` to set up first.');
  }
}

function getAuthToken(authMethod: string): string | undefined {
  if (authMethod === 'github') {
    try {
      return execSync('gh auth token 2>/dev/null', { encoding: 'utf8' }).trim() || undefined;
    } catch {
      return undefined;
    }
  }
  if (authMethod === 'channel-key') {
    try {
      return readFileSync(join(homedir(), '.kraki', 'channel.key'), 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function requestPairingToken(relayUrl: string, authToken?: string): Promise<{ relay: string; token: string; expiresIn: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Pairing request timed out (10s)'));
    }, 10_000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'request_pairing_token', token: authToken }));
    });

    ws.on('message', (data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === 'pairing_token_created') {
        clearTimeout(timeout);
        resolve({ relay: relayUrl, token: msg.token, expiresIn: msg.expiresIn });
        ws.close();
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

async function main(): Promise<void> {
  const localRelay = process.argv.includes('--local-relay');

  let relay: string;
  let authToken: string | undefined;

  if (localRelay) {
    relay = LOCAL_RELAY;
    authToken = 'dev'; // open auth accepts any token
    console.log(`🦑 Using local relay: ${relay}`);
  } else {
    const config = loadConfig();
    relay = config.relay;
    authToken = getAuthToken(config.authMethod);
    console.log(`🦑 Using relay: ${relay}`);
  }

  console.log('🔑 Requesting pairing token...');
  const info = await requestPairingToken(relay, authToken);
  console.log(`✅ Got pairing token (expires in ${info.expiresIn}s)`);

  const params = new URLSearchParams({ relay, token: info.token });

  // Start Vite
  const viteEnv = { ...process.env };
  if (localRelay) viteEnv.VITE_WS_URL = LOCAL_RELAY;

  const vite = spawn('pnpm', ['--filter', '@kraki/arm-web', 'dev'], {
    stdio: ['inherit', 'pipe', 'inherit'],
    cwd: process.cwd(),
    env: viteEnv,
  });

  let opened = false;
  vite.stdout!.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    process.stdout.write(text);

    if (!opened) {
      const match = text.match(/Local:\s+http:\/\/localhost:(\d+)/);
      if (match) {
        opened = true;
        const url = `http://localhost:${match[1]}?${params.toString()}`;
        console.log(`\n🌐 Opening Chrome: ${url}\n`);
        try { execSync(`open -a "Google Chrome" "${url}"`); } catch { execSync(`open "${url}"`); }
      }
    }
  });

  vite.on('close', (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
