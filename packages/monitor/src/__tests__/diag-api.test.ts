import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type ClientRequest, type Server } from 'node:http';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DiagApi, diagSigningText, sanitizeDiagBatch } from '../diag-api.js';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const device = { id: 'device-1', userId: 'account-1', role: 'app', publicKey };
const otherDevice = { id: 'device-2', userId: 'account-2', role: 'app', publicKey };
const devices: Record<string, typeof device> = { [device.id]: device, [otherDevice.id]: otherDevice };
const resources: Array<{ dir: string; api: DiagApi; server: Server }> = [];
const stalls: ClientRequest[] = [];
afterEach(async () => {
  for (const req of stalls.splice(0)) req.destroy();
  for (const { dir, api, server } of resources.splice(0)) {
    api.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

async function fixture(options: { enabled?: boolean; dailyBytes?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'kraki-diag-test-'));
  const api = new DiagApi({ directory: options.enabled === false ? undefined : dir,
    getDevice: id => devices[id], dailyBytes: options.dailyBytes });
  const server = createServer(async (req, res) => {
    if (!await api.handleRequest(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  resources.push({ dir, api, server });
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const id = randomUUID();
  const batch = { schema: 1, batchId: id, processId: randomUUID(), platform: 'ios', version: '0.1.1', build: '1',
    events: [{ ev: 'cmd.answer', seq: 1, t: Date.now(), m: 30, sid: 'session-1', d: { questionId: 'q1', textLength: 12, duplicate: false } }] };
  function request(body = gzipSync(JSON.stringify(batch)), extra: Record<string, string> = {}, path = '/api/diag/v1/batch', method = 'POST', deviceId = device.id) {
    const timestamp = String(Date.now());
    const signature = sign('sha256', Buffer.from(diagSigningText(method, path, deviceId, timestamp, id, body)), key.privateKey).toString('base64');
    return fetch(url + path, { method, headers: {
      'content-type': 'application/json', 'content-encoding': 'gzip',
      'x-kraki-device': deviceId, 'x-kraki-time': timestamp, 'x-kraki-request': id, 'x-kraki-signature': signature, ...extra,
    }, body: method === 'POST' ? new Uint8Array(body) : undefined });
  }
  /** A POST that sends its headers and part of its body, then stalls. */
  function stalled(headers: Record<string, string>): Promise<ClientRequest> {
    const req = httpRequest(url + '/api/diag/v1/batch', { method: 'POST', headers: { 'content-length': '1000', ...headers } });
    req.on('error', () => {});
    req.write('x');
    stalls.push(req);
    // Let the collector reach its body read.
    return new Promise(resolve => setTimeout(() => resolve(req), 50));
  }
  function signedHeaders(deviceId: string): Record<string, string> {
    return { 'x-kraki-device': deviceId, 'x-kraki-time': String(Date.now()), 'x-kraki-request': randomUUID(), 'x-kraki-signature': 'c2ln' };
  }
  return { api, dir, url, request, batch, id, stalled, signedHeaders };
}

describe('off-band diagnostics', () => {
  it('is disabled by default, including config', async () => {
    const f = await fixture({ enabled: false });
    expect((await f.request()).status).toBe(410);
    expect(await readdir(f.dir)).toEqual([]);
  });
  it('authenticates device signatures; does not accept a service Bearer key', async () => {
    const f = await fixture();
    expect((await fetch(f.url + '/api/diag/v1/batch', { method: 'POST', headers: { authorization: 'Bearer a-service-key' } })).status).toBe(401);
    expect((await f.request(undefined, { 'x-kraki-signature': 'bad' })).status).toBe(401);
    expect((await f.request(undefined, { 'x-kraki-time': '1000000000000' })).status).toBe(401);
    expect((await f.request(undefined, { 'x-kraki-device': '../other' })).status).toBe(401);
    expect((await f.request(Buffer.alloc(0), {}, '/api/diag/v1/config', 'GET')).status).toBe(200);
  });
  it('stores one private idempotent batch and rejects reusing its id for another payload', async () => {
    const f = await fixture();
    const body = gzipSync(JSON.stringify(f.batch));
    expect((await f.request(body)).status).toBe(204);
    expect((await f.request(body)).status).toBe(204);
    const owners = await readdir(f.dir);
    expect(owners).toHaveLength(1);
    expect(owners[0]).toBe(createHash('sha256').update(`${device.userId}\n${device.id}`).digest('hex'));
    const files = await readdir(join(f.dir, owners[0]));
    expect(files).toEqual([`${f.id}.json.gz`]);
    expect(await readFile(join(f.dir, owners[0], files[0]))).toEqual(body);
    f.batch.events[0].d.textLength = 123;
    expect((await f.request(gzipSync(JSON.stringify(f.batch)))).status).toBe(409);
  });
  it('never stores a known field with a value outside its format (free text, paths, non-numeric timings), but keeps the batch', async () => {
    for (const event of [
      { ev: 'cmd.answer', seq: 1, m: 0, t: 0, d: { textLength: 'secret', duplicate: false } },
      { ev: 'cmd.answer', seq: 1, m: 0, t: 0, d: { stack: '/Users/name/private/path', duplicate: false } },
    ]) {
      const f = await fixture();
      expect((await f.request(gzipSync(JSON.stringify({ ...f.batch, events: [event, { ...f.batch.events[0], seq: 2 }] })))).status).toBe(204);
      const [owner] = await readdir(f.dir);
      const [file] = await readdir(join(f.dir, owner));
      const saved = gunzipSync(await readFile(join(f.dir, owner, file))).toString();
      expect(saved).not.toMatch(/secret|private/);
      expect(JSON.parse(saved).events.map((e: { seq: number; d: unknown }) => [e.seq, e.d])).toEqual([
        [1, { duplicate: false }], [2, f.batch.events[0].d]]);
    }
  });
  it('keeps the events of a batch where one sid is not an id (new-session voice draft), without that sid', async () => {
    const f = await fixture();
    const launch = { ev: 'app.launch', seq: 1, m: 1, t: 1, d: {} };
    const begin = { ev: 'voice.action', seq: 2, m: 2, t: 2, sid: 'kraki.new-session-draft', d: { source: 'recording.begin' } };
    expect((await f.request(gzipSync(JSON.stringify({ ...f.batch, events: [launch, begin] })))).status).toBe(204);
    const [owner] = await readdir(f.dir);
    const [file] = await readdir(join(f.dir, owner));
    const saved = JSON.parse(gunzipSync(await readFile(join(f.dir, owner, file))).toString());
    expect(saved.events).toEqual([launch, { ev: 'voice.action', seq: 2, m: 2, t: 2, d: { source: 'recording.begin' } }]);
  });
  it('drops an event with an unusable envelope, keeps the rest; still rejects a malformed batch envelope', async () => {
    const f = await fixture();
    const good = f.batch.events[0];
    const problems: string[] = [];
    const clean = sanitizeDiagBatch({ ...f.batch, events: [{ ...good, seq: 0 }, 'x', { ...good, seq: 3, d: 'text' }, { ...good, seq: 4 }] }, f.id, problems);
    expect(clean?.batch.events).toEqual([{ ...good, seq: 4 }]);
    expect(clean?.invalid).toBe(3);
    expect(problems).toEqual(['cmd.answer', 'event']);
    expect(sanitizeDiagBatch({ ...f.batch, version: '1.0 beta' }, f.id, problems)).toBeNull();
    expect(problems).toContain('batch.version');
    expect(sanitizeDiagBatch({ ...f.batch, events: [] }, f.id)).toBeNull();
  });
  it('logs what it dropped or rejected (event.field names, never values)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const f = await fixture();
      const bad = { ev: 'voice.summary', seq: 1, m: 0, t: 0, sid: 'a.b', d: { cause: 'The voice service timed out.', outcome: 'failed' } };
      expect((await f.request(gzipSync(JSON.stringify({ ...f.batch, events: [bad] })))).status).toBe(204);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toBe('diag dropped invalid values device=device-1 platform=ios version=0.1.1 build=1 fields=voice.summary.sid,voice.summary.cause');
      expect(line).not.toMatch(/timed out|a\.b/);
      warn.mockClear();
      expect((await f.request(gzipSync(JSON.stringify({ ...f.batch, platform: 'secret os' })))).status).toBe(400);
      expect(String(warn.mock.calls[0][0])).toBe('diag rejected invalid values device=device-1 platform=? version=0.1.1 build=1 fields=batch.platform');
      // A rejected token-shaped value is never echoed: only schema-valid values are logged.
      warn.mockClear();
      expect((await f.request(gzipSync(JSON.stringify({ ...f.batch, version: 'sk_live_0123456789abcdef', build: 'tok_abc' })))).status).toBe(400);
      const rejected = String(warn.mock.calls[0][0]);
      expect(rejected).toBe('diag rejected invalid values device=device-1 platform=ios version=? build=? fields=batch.version');
      expect(rejected).not.toMatch(/sk_live|tok_abc/);
      // A clean batch logs nothing.
      warn.mockClear();
      const g = await fixture();
      expect((await g.request()).status).toBe(204);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
  it('drops names it does not know (never stored) instead of rejecting the batch', async () => {
    const stored = async (f: Awaited<ReturnType<typeof fixture>>) => {
      const [owner] = await readdir(f.dir);
      if (!owner) return null;
      const files = await readdir(join(f.dir, owner));
      return files.length ? JSON.parse(gunzipSync(await readFile(join(f.dir, owner, files[0]))).toString()) : null;
    };
    // Unknown field of a known event (e.g. a field added by a newer client).
    let f = await fixture();
    const known = f.batch.events[0];
    let res = await f.request(gzipSync(JSON.stringify({ ...f.batch,
      events: [{ ...known, d: { ...known.d, text: 'private text', someNewerField: true } }] })));
    expect(res.status).toBe(204);
    let saved = await stored(f);
    expect(saved.events[0].d).toEqual(known.d);
    expect(JSON.stringify(saved)).not.toContain('private text');
    // Unknown event type next to known ones; unknown top-level / event keys.
    f = await fixture();
    res = await f.request(gzipSync(JSON.stringify({ ...f.batch, token: 'secret',
      events: [{ ev: 'raw.log', seq: 1, m: 0, t: 0, d: { line: 'secret' } }, { ...known, seq: 2, extra: 'x' }] })));
    expect(res.status).toBe(204);
    saved = await stored(f);
    expect(saved.events.map((e: { ev: string }) => e.ev)).toEqual(['cmd.answer']);
    expect(JSON.stringify(saved)).not.toMatch(/secret|extra|token/);
    // Same bytes again: still idempotent after re-encoding.
    expect((await f.request(gzipSync(JSON.stringify({ ...f.batch, token: 'secret',
      events: [{ ev: 'raw.log', seq: 1, m: 0, t: 0, d: { line: 'secret' } }, { ...known, seq: 2, extra: 'x' }] })))).status).toBe(204);
    // Only unknown events: accepted, nothing stored.
    f = await fixture();
    expect((await f.request(gzipSync(JSON.stringify({ ...f.batch, events: [{ ev: 'raw.log', seq: 1, m: 0, t: 0, d: {} }] })))).status).toBe(204);
    expect(await stored(f)).toBeNull();
  });
  it('keeps work.slow thread CPU time next to its wall time (inactive-Mac stalls: work vs waiting)', () => {
    const batchId = randomUUID();
    const event = { ev: 'work.slow', seq: 1, t: Date.now(), m: 10, d: { source: 'mac.list_update', durationMs: 2986, cpuMs: 41.5 } };
    const batch = { schema: 1, batchId, processId: randomUUID(), platform: 'mac', version: '0.2.91', build: '93', events: [event] };
    expect(sanitizeDiagBatch(batch, batchId)?.batch.events).toEqual([event]);
    // An out-of-format value costs only that field, never the batch.
    const bad = sanitizeDiagBatch({ ...batch, events: [{ ...event, d: { ...event.d, cpuMs: 'slow' } }] }, batchId);
    expect(bad?.batch.events[0].d).not.toHaveProperty('cpuMs');
  });
  it('stores ui.busy tagged phase=inactive (Mac hangs while not frontmost)', async () => {
    const f = await fixture();
    const busy = { ev: 'ui.busy', seq: 1, t: 1, m: 1, d: { durationMs: 1840.5, phase: 'inactive' } };
    expect(sanitizeDiagBatch({ ...f.batch, events: [busy] }, f.id)).toEqual({ batch: { ...f.batch, events: [busy] }, stripped: 0, invalid: 0 });
  });
  it('accepts metadata-only transport recovery reason and generation', async () => {
    const f = await fixture();
    const event = { ev: 'ws.state', seq: 1, t: Date.now(), m: 10, d: { source: 'pulse_progress_timeout', count: 3 } };
    expect((await f.request(gzipSync(JSON.stringify({ ...f.batch, events: [event] })))).status).toBe(204);
  });
  it('accepts metadata-only stability summaries and rejects free text in their tags', async () => {
    const f = await fixture();
    const ready = { ev: 'ready.summary', seq: 1, t: Date.now(), m: 10, d: {
      kind: 'warm', outcome: 'ready', path: 'wifi', attempt: 0, gap: 3, viewing: true, backgroundMs: 61000,
      firstContentMs: 0, wsOpenMs: 180, authedMs: 420, listFreshMs: 700, viewCurrentMs: 950, cause: 'peer_closed' } };
    const outage = { ev: 'outage.summary', seq: 2, t: Date.now(), m: 11, d: {
      source: 'transport_error', code: '-1005', outcome: 'recovered', path: 'cellular', attempt: 2, detectMs: 1200,
      reconnectMs: 3100, catchupMs: 400, impactMs: 4700, visibleMs: 2600, pathChanged: true, afterWake: false } };
    const send = { ev: 'send.summary', seq: 3, t: Date.now(), m: 12, d: {
      kind: 'voice', outcome: 'delivered', shown: 'failed', shownMs: 4200, falseAlarm: false, manualRetries: 1,
      autoResends: 0, restored: 0, offline: false, attachments: 0, textLength: 478, background: true,
      confirmMs: 16_000, correctionMs: 2100, cause: 'correction', handoffMs: 180, uploadMs: 2400 } };
    const voice = { ev: 'voice.summary', seq: 4, t: Date.now(), m: 13, d: {
      outcome: 'failed', stage: 'recording', cause: 'lease_denied_quota_exhausted', confirmed: false, textLength: 0,
      warm: true, count: 0, startMs: 120, recordMs: 5300, correctionOn: true } };
    const open = { ev: 'open.summary', seq: 5, t: Date.now(), m: 14, d: { outcome: 'current', gap: 2, firstContentMs: 40, viewCurrentMs: 600 } };
    const resend = { ev: 'outbox.state', seq: 6, t: Date.now(), m: 15, d: { clientId: randomUUID(), phase: 'resend_stalled' } };
    expect((await f.request(gzipSync(JSON.stringify({ ...f.batch, events: [ready, outage, send, voice, open, resend] })))).status).toBe(204);
    expect(sanitizeDiagBatch({ ...f.batch, events: [ready, outage, send, voice, open, resend] }, f.id)).toMatchObject({ stripped: 0, invalid: 0 });
    for (const [bad, field] of [
      [{ ...voice, d: { ...voice.d, cause: 'The voice service timed out.' } }, 'cause'],
      [{ ...ready, d: { ...ready.d, kind: 'lukewarm' } }, 'kind'],
      [{ ...outage, d: { ...outage.d, code: 'connection reset by peer' } }, 'code'],
      [{ ...outage, d: { ...outage.d, path: 'Home-WiFi-5G' } }, 'path'],
    ] as const) {
      const clean = sanitizeDiagBatch({ ...f.batch, events: [bad] }, f.id);
      const d = (clean?.batch.events as Array<{ d: Record<string, unknown> }>)[0].d;
      expect(d).not.toHaveProperty(field);
      expect(Object.keys(d)).toHaveLength(Object.keys(bad.d).length - 1);
    }
  });
  it('accepts the client unconfirmed outbox state without arbitrary phase strings', async () => {
    const f = await fixture();
    const event = { ev: 'outbox.state', seq: 1, t: Date.now(), m: 10, d: { clientId: randomUUID(), phase: 'unconfirmed' } };
    expect((await f.request(gzipSync(JSON.stringify({ ...f.batch, events: [event] })))).status).toBe(204);
    event.d.phase = 'unreviewed-phase';
    expect((sanitizeDiagBatch({ ...f.batch, events: [event] }, f.id)?.batch.events as Array<{ d: unknown }>)[0].d).toEqual({ clientId: event.d.clientId });
  });
  it('caps wire/decompressed size and rejects malformed gzip', async () => {
    const f = await fixture();
    expect((await f.request(Buffer.alloc(65537))).status).toBe(413);
    expect((await f.request(gzipSync(Buffer.alloc(300000)))).status).toBe(413);
    expect((await f.request(Buffer.from('not gzip'))).status).toBe(413);
    expect((await f.request(undefined, { 'content-encoding': 'identity' })).status).toBe(415);
  });
  it('enforces disk quota and retains inactive devices for at most 14 days', async () => {
    const f = await fixture({ dailyBytes: 1 });
    expect((await f.request()).status).toBe(429);
    const g = await fixture();
    expect((await g.request()).status).toBe(204);
    const owner = (await readdir(g.dir))[0];
    const file = join(g.dir, owner, `${g.id}.json.gz`);
    const old = new Date(Date.now() - 15 * 86400_000);
    await utimes(file, old, old);
    await g.api.sweep();
    expect(await readdir(join(g.dir, owner))).toEqual([]);
  });
  it('has an operator kill switch without a relay restart', async () => {
    const f = await fixture();
    await writeFile(join(f.dir, 'DISABLED'), '');
    const config = await f.request(Buffer.alloc(0), {}, '/api/diag/v1/config', 'GET');
    expect(await config.json()).toMatchObject({ enabled: false });
    expect((await f.request()).status).toBe(410);
    await rm(join(f.dir, 'DISABLED'));
    expect((await f.request()).status).toBe(204);
  });
  it('does not hold upload slots for requests whose headers do not authenticate', async () => {
    const f = await fixture();
    for (let i = 0; i < 4; i++) await f.stalled({});
    expect((await f.request()).status).toBe(204);
  });
  it('unsigned requests naming a device do not hold that device\'s upload slots', async () => {
    const f = await fixture();
    // Headers that pass the pre-body checks (the signature covers the body, so
    // it is checked after the body); anyone who knows the device id can send them.
    for (const ip of ['203.0.113.7', '203.0.113.8', '203.0.113.9']) {
      await f.stalled({ ...f.signedHeaders(otherDevice.id), 'x-forwarded-for': ip });
    }
    // The device's own signed upload still goes through.
    expect((await f.request(undefined, { 'x-forwarded-for': '203.0.113.10' }, '/api/diag/v1/batch', 'POST', otherDevice.id)).status).toBe(204);
    expect((await f.request(undefined, { 'x-forwarded-for': '203.0.113.11' })).status).toBe(204);
  });
  it('rate limits by the client address the proxy forwards', async () => {
    const f = await fixture();
    for (let i = 0; i < 120; i++) {
      expect((await f.request(Buffer.alloc(0), { 'x-kraki-signature': 'bad', 'x-forwarded-for': '203.0.113.1' })).status).toBe(401);
    }
    expect((await f.request(undefined, { 'x-forwarded-for': '203.0.113.1' })).status).toBe(429);
    // Only the rightmost entry is the proxy's; a client-supplied one is ignored.
    expect((await f.request(undefined, { 'x-forwarded-for': '203.0.113.1, 203.0.113.2' })).status).toBe(204);
  });
  it('rate limits a device including replayed requests', async () => {
    const f = await fixture();
    for (let i = 0; i < 30; i++) expect((await f.request()).status).toBe(204);
    expect((await f.request()).status).toBe(429);
  });
});
