import { describe, expect, it } from 'vitest';
import { assertSafeProductionRelayUrl, isLocalRelayUrl } from './build-env';

describe('build-env', () => {
  describe('isLocalRelayUrl', () => {
    it('detects localhost relay urls', () => {
      expect(isLocalRelayUrl('ws://localhost:4000')).toBe(true);
      expect(isLocalRelayUrl('ws://127.0.0.1:4000')).toBe(true);
      expect(isLocalRelayUrl('ws://0.0.0.0:4000')).toBe(true);
    });

    it('does not flag hosted relay urls', () => {
      expect(isLocalRelayUrl('wss://kraki.corelli.cloud')).toBe(false);
      expect(isLocalRelayUrl('wss://relay.example.com')).toBe(false);
      expect(isLocalRelayUrl(undefined)).toBe(false);
    });
  });

  describe('assertSafeProductionRelayUrl', () => {
    it('throws when production build points at localhost', () => {
      expect(() => assertSafeProductionRelayUrl('build', 'production', 'ws://localhost:4000'))
        .toThrow(/Refusing to build production web app/);
    });

    it('allows development builds to use localhost', () => {
      expect(() => assertSafeProductionRelayUrl('serve', 'development', 'ws://localhost:4000'))
        .not.toThrow();
    });

    it('allows production builds to use hosted relay urls', () => {
      expect(() => assertSafeProductionRelayUrl('build', 'production', 'wss://kraki.corelli.cloud'))
        .not.toThrow();
    });
  });
});
