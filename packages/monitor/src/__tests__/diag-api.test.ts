import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DiagApi, diagSigningText } from '../diag-api.js';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const device = { id: 'device-1', userId: 'account-1', role: 'app', publicKey };
const resources: Array<{ dir: string; api: DiagApi; server: Server }> = [];
afterEach(async () => {
  for (const { dir, api, server } of resources.splice(0)) {
    api.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

async function fixture(options: { enabled?: boolean; dailyBytes?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'kraki-diag-test-'));
  const api = new DiagApi({ directory: options.enabled === false ? undefined : dir,
    getDevice: id => id === device.id ? device : undefined, dailyBytes: options.dailyBytes });
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
  function request(body = gzipSync(JSON.stringify(batch)), extra: Record<string, string> = {}, path = '/api/diag/v1/batch', method = 'POST') {
    const timestamp = String(Date.now());
    const signature = sign('sha256', Buffer.from(diagSigningText(method, path, device.id, timestamp, id, body)), key.privateKey).toString('base64');
    return fetch(url + path, { method, headers: {
      'content-type': 'application/json', 'content-encoding': 'gzip',
      'x-kraki-device': device.id, 'x-kraki-time': timestamp, 'x-kraki-request': id, 'x-kraki-signature': signature, ...extra,
    }, body: method === 'POST' ? new Uint8Array(body) : undefined });
  }
  return { api, dir, url, request, batch, id };
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
  it('rejects unallowlisted content, unknown events, fields and non-numeric timings', async () => {
    const f = await fixture();
    for (const event of [
      { ev: 'cmd.answer', seq: 1, m: 0, t: 0, d: { text: 'private text' } },
      { ev: 'raw.log', seq: 1, m: 0, t: 0, d: {} },
      { ev: 'cmd.answer', seq: 1, m: 0, t: 0, d: { textLength: 'secret' } },
      { ev: 'cmd.answer', seq: 1, m: 0, t: 0, d: { stack: '/Users/name/private/path' } },
    ]) {
      expect((await f.request(gzipSync(JSON.stringify({ ...f.batch, events: [event] })))).status).toBe(400);
    }
    expect((await f.request(gzipSync(JSON.stringify({ ...f.batch, token: 'secret' })))).status).toBe(400);
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
      firstContentMs: 0, wsOpenMs: 180, authedMs: 420, listFreshMs: 700, viewCurrentMs: 950 } };
    const outage = { ev: 'outage.summary', seq: 2, t: Date.now(), m: 11, d: {
      source: 'transport_error', code: '-1005', outcome: 'recovered', path: 'cellular', attempt: 2, detectMs: 1200,
      reconnectMs: 3100, catchupMs: 400, impactMs: 4700, visibleMs: 2600, pathChanged: true, afterWake: false } };
    const send = { ev: 'send.summary', seq: 3, t: Date.now(), m: 12, d: {
      kind: 'voice', outcome: 'delivered', shown: 'failed', shownMs: 4200, falseAlarm: false, manualRetries: 1,
      autoResends: 0, restored: 0, offline: false, attachments: 0, textLength: 478, background: true,
      confirmMs: 16_000, correctionMs: 2100, cause: 'correction' } };
    const voice = { ev: 'voice.summary', seq: 4, t: Date.now(), m: 13, d: {
      outcome: 'failed', stage: 'recording', cause: 'lease_denied_quota_exhausted', confirmed: false, textLength: 0,
      warm: true, count: 0, startMs: 120, recordMs: 5300, correctionOn: true } };
    const open = { ev: 'open.summary', seq: 5, t: Date.now(), m: 14, d: { outcome: 'current', gap: 2, firstContentMs: 40, viewCurrentMs: 600 } };
    const resend = { ev: 'outbox.state', seq: 6, t: Date.now(), m: 15, d: { clientId: randomUUID(), phase: 'resend_stalled' } };
    expect((await f.request(gzipSync(JSON.stringify({ ...f.batch, events: [ready, outage, send, voice, open, resend] })))).status).toBe(204);
    expect((await f.request(gzipSync(JSON.stringify({ ...f.batch, events: [{ ...voice, d: { ...voice.d, cause: 'The voice service timed out.' } }] })))).status).toBe(400);
    for (const bad of [
      { ...ready, d: { ...ready.d, kind: 'lukewarm' } },
      { ...outage, d: { ...outage.d, code: 'connection reset by peer' } },
      { ...outage, d: { ...outage.d, path: 'Home-WiFi-5G' } },
      { ...ready, d: { ...ready.d, source: 'x' } },
    ]) {
      expect((await f.request(gzipSync(JSON.stringify({ ...f.batch, events: [bad] })))).status).toBe(400);
    }
  });
  it('accepts the client unconfirmed outbox state without arbitrary phase strings', async () => {
    const f = await fixture();
    const event = { ev: 'outbox.state', seq: 1, t: Date.now(), m: 10, d: { clientId: randomUUID(), phase: 'unconfirmed' } };
    expect((await f.request(gzipSync(JSON.stringify({ ...f.batch, events: [event] })))).status).toBe(204);
    event.d.phase = 'unreviewed-phase';
    expect((await f.request(gzipSync(JSON.stringify({ ...f.batch, events: [event] })))).status).toBe(400);
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
  it('rate limits a device including replayed requests', async () => {
    const f = await fixture();
    for (let i = 0; i < 30; i++) expect((await f.request()).status).toBe(204);
    expect((await f.request()).status).toBe(429);
  });
});
