/**
 * Kraki for Windows sends performance data through the Web client's own
 * DiagClient (packages/arm/web/src/lib/diag). Run that real client against
 * this real collector: same signature, headers, gzip batch and vocabulary as
 * the native apps, accepted with platform "windows" and stored unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DiagApi, fields, schemas } from '../diag-api.js';
import { DiagClient } from '../../../arm/web/src/lib/diag/client';
import { DIAG_EVENTS, DiagRecorder } from '../../../arm/web/src/lib/diag/recorder';
import { MemorySpoolStore } from '../../../arm/web/src/lib/diag/spool';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const device = { id: 'dev_win-1', userId: 'account-1', role: 'app', publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.splice(0)) await f(); });

const webRecorder = readFileSync(new URL('../../../arm/web/src/lib/diag/recorder.ts', import.meta.url), 'utf8');

describe('Windows (Web) diagnostics client', () => {
  it('every event and field the Web client can send is allowlisted', () => {
    const events = webRecorder.slice(webRecorder.indexOf('DIAG_EVENTS = {'), webRecorder.indexOf('} as const;'));
    const names = [...events.matchAll(/: '([\w.]+)'/g)].map((m) => m[1]);
    expect(names).toEqual(expect.arrayContaining(['voice.summary', 'reply.summary', 'ui.busy', 'work.slow', 'cmd.answer']));
    expect(names.filter((n) => !Object.hasOwn(schemas, n))).toEqual([]);
    const block = webRecorder.slice(webRecorder.indexOf('DIAG_FIELDS = ['), webRecorder.indexOf('] as const;', webRecorder.indexOf('DIAG_FIELDS')));
    const fieldNames = [...block.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(fieldNames.filter((n) => !Object.hasOwn(fields, n))).toEqual([]);
  });

  it('the real client uploads a batch the real collector accepts and stores', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kraki-diag-win-'));
    const api = new DiagApi({ directory: dir, getDevice: (id) => id === device.id ? device : undefined });
    const server: Server = createServer(async (req, res) => { if (!await api.handleRequest(req, res)) { res.writeHead(404); res.end(); } });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(async () => { api.close(); await new Promise<void>((r) => server.close(() => r())); await rm(dir, { recursive: true, force: true }); });
    const port = (server.address() as { port: number }).port;

    let now = Date.now();
    const statuses: number[] = [];
    const recorder = new DiagRecorder();
    const m = new Map<string, string>();
    const client = new DiagClient({
      recorder, store: new MemorySpoolStore(), platform: 'windows', version: '0.1.7', build: '39067976396', now: () => now,
      storage: { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } },
      http: async (req) => {
        const res = await fetch(`${req.base}/api/diag/v1/${req.path}`, { method: req.path === 'config' ? 'GET' : 'POST', headers: req.headers, body: req.body as Uint8Array | undefined });
        statuses.push(res.status);
        return { status: res.status, body: await res.text() };
      },
    });
    // One of each event the Web client emits, with realistic values.
    const clientId = crypto.randomUUID();
    recorder.record('app.launch', undefined);
    recorder.record('app.phase', undefined, { phase: 'authenticated', pending: 0 });
    recorder.record('ws.state', undefined, { state: 'disconnected', source: 'peer_closed', attempt: 2 });
    recorder.record('cmd.answer', 'sess-1', { questionId: 'q-1', textLength: 5, pending: 0, duplicate: false, source: 'web/outbox' });
    recorder.record('cmd.input', 'sess-1', { clientId, answerTo: 'q-1', textLength: 5, attachments: 1, source: 'web/outbox' });
    recorder.record('outbox.state', 'sess-1', { clientId, phase: 'resend_greeting' });
    recorder.record('echo.input', 'sess-1', { clientId, matched: true });
    recorder.record('diag.health', undefined, { dropped: 3 });
    recorder.record('diag.upload', undefined, { status: 503, bytes: 900 });
    recorder.record('ready.summary', undefined, { kind: 'cold', outcome: 'ready', path: 'unknown', attempt: 0, gap: 2, viewing: true, firstContentMs: 0, wsOpenMs: 80, authedMs: 140, listFreshMs: 300, viewCurrentMs: 420, previousExit: 'first' });
    recorder.record('outage.summary', undefined, { source: 'peer_closed', code: '1006', outcome: 'recovered', path: 'unknown', attempt: 1, detectMs: 12, visibleMs: 0, pathChanged: false, afterWake: false, reconnectMs: 500, catchupMs: 90, impactMs: 600 });
    recorder.record('open.summary', undefined, { outcome: 'current', gap: 0, firstContentMs: 5, viewCurrentMs: 40 });
    recorder.record('send.summary', undefined, { kind: 'answer', outcome: 'delivered', shown: 'none', shownMs: 0, falseAlarm: false, manualRetries: 0, autoResends: 0, restored: 0, offline: false, attachments: 1, textLength: 5, background: false, confirmMs: 800, cause: 'stalled' });

    recorder.record('voice.summary', undefined, { outcome: 'final', stage: 'finishing', cause: 'quota', confirmed: false, correctionOn: true, textLength: 5, warm: false, count: 1, startMs: 100, recordMs: 2000, finalizeMs: 300 });
    recorder.record('reply.summary', undefined, { kind: 'answer', outcome: 'completed', durationMs: 6600, firstActivityMs: 1200, firstTextMs: 2000, deltas: 4, maxGapMs: 3500, stalls: 1 });
    recorder.record('ui.busy', undefined, { durationMs: 80 });
    recorder.record('work.slow', 'sess-1', { source: 'web/session_list', durationMs: 12 });

    await client.configure(`ws://127.0.0.1:${port}`, device.id, async (msg) => sign('sha256', Buffer.from(msg), key.privateKey).toString('base64'));
    now += 5_000; await client.tick();   // config
    now += 15_000; await client.tick();  // batch
    expect(statuses).toEqual([200, 204]);

    const owner = (await readdir(dir))[0]!;
    const files = await readdir(join(dir, owner));
    expect(files).toHaveLength(1);
    const stored = JSON.parse(gunzipSync(await readFile(join(dir, owner, files[0]!))).toString());
    expect(stored).toMatchObject({ platform: 'windows', version: '0.1.7', build: '39067976396' });
    // Nothing the client sent was stripped as unknown.
    expect(stored.events.map((e: { ev: string }) => e.ev)).toEqual(Object.values(DIAG_EVENTS));
    expect(stored.events.find((e: { ev: string }) => e.ev === 'send.summary').d).toMatchObject({ kind: 'answer', confirmMs: 800, cause: 'stalled' });
    expect(stored.events.find((e: { ev: string }) => e.ev === 'cmd.answer').d).toEqual({ questionId: 'q-1', textLength: 5, pending: 0, duplicate: false, source: 'web/outbox' });
    expect(stored.events.find((e: { ev: string }) => e.ev === 'voice.summary').d).toEqual({ outcome: 'final', stage: 'finishing', cause: 'quota', confirmed: false, correctionOn: true, textLength: 5, warm: false, count: 1, startMs: 100, recordMs: 2000, finalizeMs: 300 });
    expect(stored.events.find((e: { ev: string }) => e.ev === 'reply.summary').d).toEqual({ kind: 'answer', outcome: 'completed', durationMs: 6600, firstActivityMs: 1200, firstTextMs: 2000, deltas: 4, maxGapMs: 3500, stalls: 1 });
    expect(stored.events.find((e: { ev: string }) => e.ev === 'ui.busy').d).toEqual({ durationMs: 80 });
    expect(stored.events.find((e: { ev: string }) => e.ev === 'work.slow').d).toEqual({ source: 'web/session_list', durationMs: 12 });
  });
});
