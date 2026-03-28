/**
 * Pairing command — generates a QR code for mobile app pairing.
 *
 * Requests a one-time pairing token from the head,
 * then displays a QR code in the terminal containing:
 * - relay URL
 * - pairing token (expires in 5 min)
 * - tentacle's public key (for E2E)
 */

import { WebSocket } from 'ws';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { loadConfig } from './config.js';
import { KeyManager } from './key-manager.js';

export interface PairingInfo {
  relay: string;
  pairingToken: string;
  publicKey?: string;
  expiresIn: number;
}

/**
 * Request a pairing token from the head and return pairing info.
 */
export async function requestPairingToken(
  relayUrl: string,
  authToken?: string,
): Promise<PairingInfo> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Pairing request timed out'));
    }, 10_000);

    ws.on('open', () => {
      // One-shot: send token inline, no device registration
      ws.send(JSON.stringify({
        type: 'request_pairing_token',
        token: authToken,
      }));
    });

    ws.on('message', (data) => {
      let msg: { type: string; token?: string; expiresIn?: number; message?: string };
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === 'pairing_token_created') {
        clearTimeout(timeout);
        const km = new KeyManager();
        resolve({
          relay: relayUrl,
          pairingToken: msg.token!,
          publicKey: km.getCompactPublicKey(),
          expiresIn: msg.expiresIn!,
        });
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
      reject(new Error(`Connection failed: ${err.message}`));
    });
  });
}

/**
 * Generate the pairing URL that will be encoded in the QR code.
 * Phone camera scans → opens this URL → web app auto-pairs.
 */
export function buildPairingUrl(info: PairingInfo, appBaseUrl?: string): string {
  const base = appBaseUrl ?? process.env.KRAKI_APP_URL ?? 'https://kraki.corelli.cloud';
  const params = new URLSearchParams();
  params.set('relay', info.relay);
  params.set('token', info.pairingToken);
  // Don't include public key in URL — it makes the QR code too large.
  // The app will exchange keys through the relay after pairing.
  return `${base}?${params.toString()}`;
}

/**
 * Legacy: build compact JSON payload (for manual transfer).
 */
export function buildPairingPayload(info: PairingInfo): string {
  return JSON.stringify({
    r: info.relay,
    t: info.pairingToken,
    k: info.publicKey,
  });
}

/**
 * Render a QR code to the terminal. Copy link to clipboard.
 */
export async function renderQrToTerminal(url: string): Promise<string> {
  // Copy to clipboard silently
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      execSync('pbcopy', { input: url });
    } else if (platform === 'linux') {
      execSync('xclip -selection clipboard', { input: url });
    }
  } catch {
    // Clipboard not available — that's fine
  }

  const appBase = process.env.KRAKI_APP_URL ?? 'https://kraki.corelli.cloud';
  const appLink = `\u001b]8;;${appBase}\u0007${appBase.replace(/^https?:\/\//, '')}\u001b]8;;\u0007`;

  try {
    const qr = await import('qrcode-terminal');
    return new Promise((resolve) => {
      (qr.default ?? qr).generate(url, { small: true }, (qrString: string) => {
        // Indent each line of the QR code
        const indented = qrString.split('\n').map(line => '    ' + line).join('\n');
        resolve([
          '',
          `  Scan with your phone camera, or visit ${appLink} and sign in with GitHub.`,
          '  Link copied to clipboard.',
          '',
          indented,
        ].join('\n'));
      });
    });
  } catch {
    return [
      '',
      `  Open on your phone, or visit ${appLink} and sign in with GitHub.`,
      '  Link copied to clipboard.',
      '',
      `  ${url}`,
      '',
    ].join('\n');
  }
}
