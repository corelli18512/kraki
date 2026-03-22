/**
 * Dev helper: start the web app with auto-pairing to the production relay.
 *
 * Reads ~/.kraki/config.json, requests a pairing token from the relay,
 * starts Vite, and opens Chrome at localhost:3000 with the token in the URL.
 */

import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { WebSocket } from 'ws';

interface KrakiConfig {
  relay: string;
  authMethod: 'github' | 'channel-key' | 'open';
}

interface PairingInfo {
  relay: string;
  pairingToken: string;
  expiresIn: number;
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

function requestPairingToken(relayUrl: string, authToken?: string): Promise<PairingInfo> {
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
        resolve({ relay: relayUrl, pairingToken: msg.token, expiresIn: msg.expiresIn });
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
  const config = loadConfig();
  const relay = config.relay;

  console.log(`🦑 Requesting pairing token from ${relay}...`);
  const authToken = getAuthToken(config.authMethod);
  const info = await requestPairingToken(relay, authToken);
  console.log(`✅ Got pairing token (expires in ${info.expiresIn}s)`);

  const params = new URLSearchParams({ relay: info.relay, token: info.pairingToken });

  // Start Vite and capture its output to detect the actual port
  const vite = spawn('pnpm', ['--filter', '@kraki/arm-web', 'dev'], {
    stdio: ['inherit', 'pipe', 'inherit'],
    cwd: process.cwd(),
  });

  let opened = false;
  vite.stdout!.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    process.stdout.write(text);

    if (!opened) {
      // Match Vite's "Local: http://localhost:XXXX/" line
      const match = text.match(/Local:\s+http:\/\/localhost:(\d+)/);
      if (match) {
        opened = true;
        const port = match[1];
        const url = `http://localhost:${port}?${params.toString()}`;
        console.log(`\n🌐 Opening Chrome: ${url}\n`);
        try {
          execSync(`open -a "Google Chrome" "${url}"`);
        } catch {
          execSync(`open "${url}"`);
        }
      }
    }
  });

  vite.on('close', (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
