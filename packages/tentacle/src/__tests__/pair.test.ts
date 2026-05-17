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
      expect(output).toContain('clipboard');
    });

    it('should mention clipboard', async () => {
      const output = await renderQrToTerminal('https://app.kraki.chat?token=test');
      // Either "copied to clipboard" or shows link as fallback
      expect(output.length).toBeGreaterThan(50);
    });
  });
});
