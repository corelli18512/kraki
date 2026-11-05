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

describe('ApnsProvider retries a push lost on our side (K-301)', () => {
  afterEach(() => silenceLogs());

  /** A session that records request headers; `answer` gets the stream, its
   *  headers and the timeout callback. */
  function recordingSession(
    seen: Array<Record<string, unknown>>,
    answer: (stream: EventEmitter, timeout: () => void) => void,
  ): ClientHttp2Session {
    const session = new EventEmitter() as EventEmitter & Record<string, unknown>;
    session.destroyed = false;
    session.closed = false;
    session.destroy = () => { session.destroyed = true; };
    session.request = (headers: Record<string, unknown>) => {
      seen.push(headers);
      const stream = new EventEmitter() as EventEmitter & Record<string, unknown>;
      let onTimeout = () => {};
      stream.setTimeout = (_ms: number, cb: () => void) => { onTimeout = cb; return stream; };
      stream.close = () => {};
      stream.end = () => { setImmediate(() => answer(stream, onTimeout)); };
      return stream;
    };
    return session as unknown as ClientHttp2Session;
  }
  const ok = (stream: EventEmitter) => { stream.emit('response', { ':status': 200, 'apns-id': 'ok-1' }); stream.emit('end'); };
  const reject = (reason: string, status = 400) => (stream: EventEmitter) => {
    stream.emit('response', { ':status': status });
    stream.emit('data', Buffer.from(JSON.stringify({ reason })));
    stream.emit('end');
  };
  function provider(sessions: ClientHttp2Session[]) {
    let opened = 0;
    const p = new ApnsProvider({
      keyPath: apnsKeyFile(), keyId: 'K', teamId: 'T', bundleId: 'chat.kraki',
      connect: () => { opened += 1; return sessions.shift()!; },
    });
    return { p, opened: () => opened };
  }

  it('retries a timed-out request on a fresh session with the same collapse id', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { p, opened } = provider([
      recordingSession(seen, (_s, timeout) => timeout()),
      recordingSession(seen, ok),
    ]);
    expect(await p.send('token-0123456789abcdef', { blob: 'b', key: 'k' })).toEqual({ success: true, id: 'ok-1', retried: true });
    expect(opened()).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen[0]!['apns-collapse-id']).toBeTruthy();
    expect(seen[1]!['apns-collapse-id']).toBe(seen[0]!['apns-collapse-id']);
  });

  it('retries when the session was dropped under the request', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const dropped = recordingSession(seen, ok);
    (dropped as unknown as { request: () => never }).request = () => { throw new Error('The session has been destroyed'); };
    const { p } = provider([dropped, recordingSession(seen, ok)]);
    expect(await p.send('token-0123456789abcdef', { blob: 'b', key: 'k' })).toMatchObject({ success: true, retried: true });
  });

  it('retries ExpiredProviderToken once with a newly signed token', async () => {
    const seen: Array<Record<string, unknown>> = [];
    let calls = 0;
    const session = recordingSession(seen, (stream) => (calls++ === 0 ? reject('ExpiredProviderToken', 403)(stream) : ok(stream)));
    const { p } = provider([session]);
    expect(await p.send('token-0123456789abcdef', { blob: 'b', key: 'k' })).toMatchObject({ success: true, retried: true });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.authorization).not.toBe(seen[0]!.authorization);
  });

  it('does not retry a refusal of the device token or payload', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { p } = provider([recordingSession(seen, reject('BadDeviceToken'))]);
    expect(await p.send('token-0123456789abcdef', { blob: 'b', key: 'k' })).toMatchObject({ success: false, gone: true });
    const seen2: Array<Record<string, unknown>> = [];
    const { p: p2 } = provider([recordingSession(seen2, reject('PayloadTooLarge', 413))]);
    expect(await p2.send('token-0123456789abcdef', { blob: 'b', key: 'k' })).toMatchObject({ success: false, error: 'PayloadTooLarge' });
    expect(seen.length + seen2.length).toBe(2);
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
