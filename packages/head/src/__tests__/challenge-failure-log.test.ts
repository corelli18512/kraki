/**
 * Log audit 2026-10-22 (i): a Mac got invalid_signature (Tokyo, 2026-10-16
 * 15:21:48Z, 0.4 s after launching a just-updated app) and the log said only
 * the device id. The failure line now carries key fingerprints, so a
 * signature made with another key (process-local keys swapped in during the
 * handshake) can be told from a rotated or corrupted stored key.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPair, exportPublicKey, signChallenge } from '@kraki/crypto';
import { Storage } from '../storage.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { keyFingerprint } from '../edge-auth-cache.js';
import { captureLogs, silenceLogs } from './log-capture.js';

describe('challenge failure log', () => {
  afterEach(() => silenceLogs());

  it('logs the stored and presented key fingerprints with the device', async () => {
    const storage = new Storage(':memory:');
    const registered = generateKeyPair();
    const ephemeral = generateKeyPair();
    const storedKey = exportPublicKey(registered.publicKey);
    const presentedKey = exportPublicKey(ephemeral.publicKey);
    storage.upsertUser('u1', 'alice', 'github');
    storage.upsertDevice('dev_mac', 'u1', 'Kraki Mac', 'app', 'desktop', storedKey, storedKey);
    const backend = new LocalAuthBackend({ storage, authProviders: new Map(), region: 'us' });
    const logs = captureLogs();

    const challenge = await backend.startChallenge('dev_mac');
    if (!challenge.ok) throw new Error('challenge failed');
    const result = await backend.verifyChallenge('dev_mac', challenge.nonce, signChallenge(challenge.nonce, ephemeral.privateKey), presentedKey, 'us');

    expect(result).toMatchObject({ ok: false, code: 'invalid_signature' });
    const [line] = logs.find('Challenge-response auth failed');
    expect(line.data).toMatchObject({
      deviceId: 'dev_mac',
      signingKeyFp: keyFingerprint(storedKey),
      storedEncryptionKeyFp: keyFingerprint(storedKey),
      presentedEncryptionKeyFp: keyFingerprint(presentedKey),
      headRegion: 'us',
    });
    expect(line.data.nonceFp).toHaveLength(12);
    expect(JSON.stringify(line.data)).not.toContain(storedKey.slice(20, 60));
    storage.close();
  });
});
