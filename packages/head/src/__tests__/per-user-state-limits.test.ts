/** Per-user state the Head keeps for a client is bounded: outstanding pairing
 *  tokens, client-written preferences, and the device fields of `auth`. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { exportPublicKey, generateKeyPair } from '@kraki/crypto';
import { Storage, MAX_PREFERENCE_KEYS, MAX_PREFERENCES_BYTES } from '../storage.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { OpenAuthProvider } from '../auth.js';
import { isValidAuth, MAX_AUTH_DEVICE_KEY_LENGTH, MAX_AUTH_DEVICE_NAME_LENGTH } from '../server/shared.js';
import { createTestEnv, type TestEnv } from './integration-helpers.js';

describe('pairing tokens per user', () => {
  let storage: Storage;
  let backend: LocalAuthBackend;
  beforeEach(() => {
    storage = new Storage(':memory:');
    storage.upsertUser('u1', 'one', 'open');
    storage.upsertUser('u2', 'two', 'open');
    backend = new LocalAuthBackend({ storage, authProviders: new Map([['open', new OpenAuthProvider()]]) });
  });
  afterEach(() => storage.close());

  const pair = (token: string) => backend.authenticate({ method: 'pairing', token }, { name: 'Phone', role: 'app' });

  it('keeps the five newest outstanding tokens and voids older ones', async () => {
    const tokens = Array.from({ length: 7 }, () => backend.createPairingToken('u1').token);
    const other = backend.createPairingToken('u2').token;
    expect(await pair(tokens[0])).toMatchObject({ ok: false, code: 'invalid_pairing_token' });
    expect(await pair(tokens[1])).toMatchObject({ ok: false, code: 'invalid_pairing_token' });
    for (const token of tokens.slice(2)) expect((await pair(token)).ok).toBe(true);
    // Another user's tokens are not counted against this one.
    expect((await pair(other)).ok).toBe(true);
  });
});

describe('preferences size', () => {
  let storage: Storage;
  beforeEach(() => {
    storage = new Storage(':memory:');
    storage.upsertUser('u1', 'one', 'open');
  });
  afterEach(() => storage.close());

  it('stores the settings real clients write', () => {
    expect(storage.updatePreferences('u1', { theme: 'dark' })).toBe(true);
    expect(storage.updatePreferences('u1', { channel: 'beta', debugLogging: true })).toBe(true);
    expect(storage.getUser('u1')?.preferences).toEqual({ theme: 'dark', channel: 'beta', debugLogging: true });
  });

  it('refuses a patch that makes them too large or too many', () => {
    storage.updatePreferences('u1', { theme: 'dark' });
    expect(storage.updatePreferences('u1', { blob: 'x'.repeat(MAX_PREFERENCES_BYTES) })).toBe(false);
    const many = Object.fromEntries(Array.from({ length: MAX_PREFERENCE_KEYS }, (_, i) => [`k${i}`, 1]));
    expect(storage.updatePreferences('u1', many)).toBe(false);
    expect(storage.getUser('u1')?.preferences).toEqual({ theme: 'dark' });
  });

  it('does not count Custom Words against the limit', () => {
    const words = Array.from({ length: 100 }, (_, i) => ({ id: `w${i}`, text: 'y'.repeat(200) }));
    storage.updatePreferences('u1', { theme: 'dark' });
    // Custom Words live in the same column but are written by their own path.
    (storage as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db
      .prepare('UPDATE users SET preferences = ? WHERE user_id = ?')
      .run(JSON.stringify({ theme: 'dark', voiceVocabulary: { version: 1, words } }), 'u1');
    expect(storage.updatePreferences('u1', { theme: 'light' })).toBe(true);
  });
});

describe('auth device field lengths', () => {
  const key = exportPublicKey(generateKeyPair().publicKey);
  const auth = (device: Record<string, unknown>) => ({ type: 'auth', auth: { method: 'open' }, device: { role: 'tentacle', ...device } });

  it('accepts real names and keys', () => {
    expect(isValidAuth(auth({ name: 'corelli-mbp', publicKey: key, encryptionKey: key }))).toBe(true);
    expect(isValidAuth(auth({ name: 'n'.repeat(253) }))).toBe(true);
  });

  it('refuses an oversized name or key', () => {
    expect(isValidAuth(auth({ name: 'n'.repeat(MAX_AUTH_DEVICE_NAME_LENGTH + 1) }))).toBe(false);
    expect(isValidAuth(auth({ name: 'Mac', publicKey: 'k'.repeat(MAX_AUTH_DEVICE_KEY_LENGTH + 1) }))).toBe(false);
    expect(isValidAuth(auth({ name: 'Mac', encryptionKey: 'k'.repeat(MAX_AUTH_DEVICE_KEY_LENGTH + 1) }))).toBe(false);
  });

  describe('over the WebSocket', () => {
    let env: TestEnv;
    beforeEach(async () => { env = await createTestEnv(); });
    afterEach(async () => { await env.cleanup(); });

    it('registers no device for an oversized auth', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${env.port}`);
      await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      ws.send(JSON.stringify({ type: 'auth', auth: { method: 'open' }, device: { name: 'n'.repeat(MAX_AUTH_DEVICE_NAME_LENGTH + 1), role: 'tentacle' } }));
      const reply = await new Promise<Record<string, unknown>>((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
      expect(reply.type).toBe('server_error');
      expect(env.storage.getDeviceCount()).toBe(0);
      ws.close();
    });
  });
});
