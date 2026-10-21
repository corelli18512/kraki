import { describe, expect, it, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientHttp2Session } from 'node:http2';
import { ApnsProvider, buildApnsPayload } from '../push/apns.js';
import { captureLogs, silenceLogs } from './log-capture.js';

/** An HTTP/2 session whose requests fail or answer as scripted. */
function fakeSession(answer: (stream: EventEmitter) => void): ClientHttp2Session {
  const session = new EventEmitter() as EventEmitter & Record<string, unknown>;
  session.destroyed = false;
  session.closed = false;
  session.destroy = () => { session.destroyed = true; };
  session.request = () => {
    const stream = new EventEmitter() as EventEmitter & Record<string, unknown>;
    stream.setTimeout = () => stream;
    stream.close = () => {};
    stream.end = () => { setImmediate(() => answer(stream)); };
    return stream;
  };
  return session as unknown as ClientHttp2Session;
}

function apnsKeyFile(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const path = join(mkdtempSync(join(tmpdir(), 'kraki-apns-')), 'key.p8');
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return path;
}

describe('ApnsProvider connection reset (log audit 2026-10-22 d)', () => {
  afterEach(() => silenceLogs());

  it('an idle-session ECONNRESET is not an error; the retry outcome is logged', async () => {
    const logs = captureLogs();
    const sessions = [
      fakeSession((stream) => stream.emit('error', new Error('read ECONNRESET'))),
      fakeSession((stream) => {
        stream.emit('response', { ':status': 200, 'apns-id': 'apns-123' });
        stream.emit('end');
      }),
    ];
    const provider = new ApnsProvider({
      keyPath: apnsKeyFile(), keyId: 'K', teamId: 'T', bundleId: 'chat.kraki',
      connect: () => sessions.shift()!,
    });
    const result = await provider.send('token-0123456789abcdef', { blob: 'b', key: 'k' });
    expect(result).toEqual({ success: true, id: 'apns-123', retried: true });
    expect(logs.lines.filter((l) => l.level === 'error')).toEqual([]);
    expect(logs.find('APNs connection error, retrying with fresh session')[0].level).toBe('info');
    expect(logs.find('APNs retry succeeded')[0].data).toMatchObject({ tokenSuffix: '89abcdef', apnsId: 'apns-123' });
  });

  it('a retry that fails as well is a warning', async () => {
    const logs = captureLogs();
    const reset = () => fakeSession((stream) => stream.emit('error', new Error('read ECONNRESET')));
    const provider = new ApnsProvider({
      keyPath: apnsKeyFile(), keyId: 'K', teamId: 'T', bundleId: 'chat.kraki',
      connect: reset,
    });
    const result = await provider.send('token-0123456789abcdef', { blob: 'b', key: 'k' });
    expect(result).toMatchObject({ success: false, error: 'read ECONNRESET', retried: true });
    expect(logs.find('APNs retry failed')[0]).toMatchObject({ level: 'warn', data: { error: 'read ECONNRESET' } });
  });
});

describe('buildApnsPayload', () => {
  it('requests the notification service extension with sound and an attention badge', () => {
    const payload = JSON.parse(buildApnsPayload({ blob: 'ciphertext', key: 'wrapped-key' }));

    expect(payload).toEqual({
      aps: {
        alert: { title: 'Kraki', body: 'Open Kraki to view the update.' },
        sound: 'default',
        badge: 1,
        'mutable-content': 1,
      },
      kraki: { blob: 'ciphertext', key: 'wrapped-key' },
    });
  });

  it('keeps sound and badge in the privacy-preserving fallback', () => {
    const payload = JSON.parse(buildApnsPayload());

    expect(payload).toEqual({
      aps: {
        alert: { title: 'Kraki', body: 'Open Kraki to view the update.' },
        sound: 'default',
        badge: 1,
      },
    });
  });
});
