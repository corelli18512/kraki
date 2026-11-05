import { describe, it, expect } from 'vitest';
import { buildPairingPayload, buildPairingUrl, renderQrToTerminal, type PairingInfo } from '../pair.js';

describe('Pairing', () => {
  const info: PairingInfo = {
    relay: 'wss://relay.kraki.chat',
    pairingToken: 'pt_abc123def456',
    publicKey: 'MIIBIjANBgkqhkiG9w0BAQE...',
    expiresIn: 300,
  };

  describe('buildPairingUrl', () => {
    it('should create URL with relay and token params', () => {
      const url = buildPairingUrl(info);
      expect(url).toContain('https://app.kraki.chat');
      expect(url).toContain('relay=');
      expect(url).toContain('token=pt_abc123def456');
      // Public key is NOT in URL (too large for QR)
      expect(url).not.toContain('key=');
    });

    it('should use custom app base URL', () => {
      const url = buildPairingUrl(info, 'https://my-app.com');
      expect(url).toContain('https://my-app.com?');
    });
  });

  describe('buildPairingPayload', () => {
    it('should create JSON with relay, token, and key', () => {
      const payload = buildPairingPayload(info);
      const parsed = JSON.parse(payload);
      expect(parsed.r).toBe('wss://relay.kraki.chat');
      expect(parsed.t).toBe('pt_abc123def456');
      expect(parsed.k).toBe('MIIBIjANBgkqhkiG9w0BAQE...');
    });
  });

  describe('renderQrToTerminal', () => {
    it('should render output with pairing info', async () => {
      const output = await renderQrToTerminal('https://app.kraki.chat?token=test');
      expect(output).toContain('phone');
      // Clipboard message is conditional — only shown when copy succeeds
      expect(output.length).toBeGreaterThan(50);
    });
  });
});

describe('pairing QR key fingerprint (release review D4)', () => {
  it('adds a short fingerprint of the computer key', async () => {
    const { buildPairingUrl, keyFingerprint } = await import('../pair.js');
    const url = new URL(buildPairingUrl({ relay: 'wss://relay.kraki.chat', pairingToken: 'pt_1', publicKey: 'MIIBIjANBgkq', expiresIn: 300 }, 'https://app.kraki.chat'));
    expect(url.searchParams.get('fp')).toBe(keyFingerprint('MIIBIjANBgkq'));
    expect(keyFingerprint('MIIBIjANBgkq')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // Same algorithm as iOS DeviceKeyPins.fingerprint.
    expect(keyFingerprint('abc')).toBe('ungWv48Bz-pBQUDeXa4iIw');
  });
});

describe('requestPairingToken on a signed-out computer (K-277)', () => {
  it('asks the relay for nothing and re-creates no identity once config.json is gone', async () => {
    const { WebSocketServer } = await import('ws');
    const { existsSync, mkdirSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const home = process.env.KRAKI_HOME!;
    mkdirSync(home, { recursive: true });
    for (const f of ['config.json', 'device-id', 'keys']) rmSync(join(home, f), { recursive: true, force: true });
    const requests: unknown[] = [];
    const server = new WebSocketServer({ host: '127.0.0.1', port: 6010 });
    server.on('connection', (ws) => ws.on('message', (data) => {
      requests.push(JSON.parse(data.toString()));
      ws.send(JSON.stringify({ type: 'pairing_token_created', token: 'pt_1', expiresIn: 300 }));
    }));
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const { requestPairingToken } = await import('../pair.js');
      await expect(requestPairingToken('ws://127.0.0.1:6010', 'gho_token')).rejects.toThrow('signed out');
      expect(requests).toEqual([]);
      expect(existsSync(join(home, 'device-id'))).toBe(false);
      expect(existsSync(join(home, 'keys'))).toBe(false);

      // Signed in: the code is issued as before.
      const { saveConfig } = await import('../config.js');
      saveConfig({ relay: 'ws://127.0.0.1:6010', authMethod: 'open', device: { name: 'mac', id: 'dev_1' } });
      await expect(requestPairingToken('ws://127.0.0.1:6010', 'dev')).resolves.toMatchObject({ pairingToken: 'pt_1' });
      expect(requests).toHaveLength(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
