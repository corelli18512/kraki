import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Storage } from '../storage.js';

describe('Storage: pairing tokens', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = new Storage(':memory:');
    storage.upsertUser('user1', 'testuser');
    storage.createChannel('ch_1', 'user1');
  });

  afterEach(() => { storage.close(); });

  it('should create and consume a valid token', () => {
    const expires = new Date(Date.now() + 300_000).toISOString();
    storage.createPairingToken('pt_abc', 'ch_1', expires);
    const channelId = storage.consumePairingToken('pt_abc');
    expect(channelId).toBe('ch_1');
  });

  it('should reject already used token (single-use)', () => {
    const expires = new Date(Date.now() + 300_000).toISOString();
    storage.createPairingToken('pt_once', 'ch_1', expires);

    expect(storage.consumePairingToken('pt_once')).toBe('ch_1');
    expect(storage.consumePairingToken('pt_once')).toBeNull();
  });

  it('should reject expired token', () => {
    const expired = new Date(Date.now() - 1000).toISOString();
    storage.createPairingToken('pt_old', 'ch_1', expired);
    expect(storage.consumePairingToken('pt_old')).toBeNull();
  });

  it('should reject non-existent token', () => {
    expect(storage.consumePairingToken('pt_nonexistent')).toBeNull();
  });

  it('should store hashed token (DB does not contain raw token)', () => {
    const expires = new Date(Date.now() + 300_000).toISOString();
    storage.createPairingToken('pt_secret123', 'ch_1', expires);

    // Direct DB query — the stored token should be a hash, not the raw value
    const rows = (storage as any).db.prepare('SELECT token FROM pairing_tokens').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].token).not.toBe('pt_secret123');
    expect(rows[0].token.length).toBe(64); // SHA-256 hex = 64 chars
  });

  it('should clean expired and used tokens', () => {
    const expired = new Date(Date.now() - 1000).toISOString();
    const valid = new Date(Date.now() + 300_000).toISOString();

    storage.createPairingToken('pt_expired', 'ch_1', expired);
    storage.createPairingToken('pt_used', 'ch_1', valid);
    storage.consumePairingToken('pt_used'); // mark as used
    storage.createPairingToken('pt_valid', 'ch_1', valid);

    const cleaned = storage.cleanExpiredPairingTokens();
    expect(cleaned).toBe(2); // expired + used

    // pt_valid should still work
    expect(storage.consumePairingToken('pt_valid')).toBe('ch_1');
  });
});
