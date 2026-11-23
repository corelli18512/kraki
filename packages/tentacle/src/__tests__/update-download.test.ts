/**
 * `downloadFile` against real local HTTP servers: a slow link's connection
 * that drops mid-body (Windows VM, 147 MB installer, `not updated: aborted`
 * after 47 minutes) resumes with `Range` instead of failing the update.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadFile, hashFile } from '../update.js';

const BODY = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => i % 251));
const FAST = { retryDelayMs: 1, maxRetryDelayMs: 5, stallTimeoutMs: 300 };

type Handler = (req: IncomingMessage, res: ServerResponse, n: number) => void;

const servers: Server[] = [];
const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];
const savedEnv: Record<string, string | undefined> = {};
let dir: string;

async function serve(handler: Handler): Promise<{ url: string; requests: IncomingMessage[] }> {
  const requests: IncomingMessage[] = [];
  const server = createServer((req, res) => { requests.push(req); handler(req, res, requests.length); });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests };
}

/** Byte offset a `Range: bytes=<n>-` asks for, or null without one. */
function rangeStart(req: IncomingMessage): number | null {
  const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
  return m ? Number(m[1]) : null;
}

/** Full body, 200. */
function sendFull(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Length': BODY.length });
  res.end(BODY);
}

/** Honour the Range header: 206 from the asked offset, else 200. */
function sendRanged(req: IncomingMessage, res: ServerResponse): void {
  const start = rangeStart(req);
  if (start === null) { sendFull(res); return; }
  res.writeHead(206, {
    'Content-Length': BODY.length - start,
    'Content-Range': `bytes ${start}-${BODY.length - 1}/${BODY.length}`,
  });
  res.end(BODY.subarray(start));
}

/** Declare the full length, send `bytes`, then drop the connection. */
function sendThenDrop(res: ServerResponse, bytes: number, from = 0): void {
  res.writeHead(from === 0 ? 200 : 206, {
    'Content-Length': BODY.length - from,
    ...(from > 0 ? { 'Content-Range': `bytes ${from}-${BODY.length - 1}/${BODY.length}` } : {}),
  });
  res.write(BODY.subarray(from, from + bytes), () => setTimeout(() => res.socket?.destroy(), 30));
}

function progressRecorder() {
  const calls: Array<[number, number]> = [];
  return { calls, onProgress: (received: number, total: number) => { calls.push([received, total]); } };
}

function expectMonotonic(calls: Array<[number, number]>): void {
  for (let i = 1; i < calls.length; i++) expect(calls[i][0]).toBeGreaterThanOrEqual(calls[i - 1][0]);
  expect(calls.at(-1)).toEqual([BODY.length, BODY.length]);
}

beforeEach(() => {
  for (const k of PROXY_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  dir = mkdtempSync(join(tmpdir(), 'kraki-download-test-'));
});

afterEach(async () => {
  for (const k of PROXY_ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  rmSync(dir, { recursive: true, force: true });
});

describe('downloadFile resumes a dropped download', () => {
  it('resumes with Range after the connection drops mid-body and appends the 206', async () => {
    const { url, requests } = await serve((req, res, n) => {
      if (n === 1) sendThenDrop(res, 20_000);
      else sendRanged(req, res);
    });
    const dest = join(dir, 'asset');
    const p = progressRecorder();
    await downloadFile(`${url}/asset`, dest, p.onProgress, FAST);

    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0].headers.range).toBeUndefined();
    expect(rangeStart(requests[1])).toBeGreaterThan(0);
    expectMonotonic(p.calls);
  });

  it('restarts from scratch when the server ignores Range (200) and keeps progress monotonic', async () => {
    const { url, requests } = await serve((_req, res, n) => {
      if (n === 1) sendThenDrop(res, 30_000);
      else sendFull(res);
    });
    const dest = join(dir, 'asset');
    const p = progressRecorder();
    await downloadFile(`${url}/asset`, dest, p.onProgress, FAST);

    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(rangeStart(requests[1])).toBeGreaterThan(0);
    expectMonotonic(p.calls);
  });

  it('restarts from scratch when the 206 starts somewhere else', async () => {
    const { url, requests } = await serve((req, res, n) => {
      if (n === 1) { sendThenDrop(res, 10_000); return; }
      if (n === 2) {
        // Asked for bytes=<n>-, answers from 0.
        res.writeHead(206, { 'Content-Length': BODY.length, 'Content-Range': `bytes 0-${BODY.length - 1}/${BODY.length}` });
        res.end(BODY);
        return;
      }
      sendRanged(req, res);
    });
    const dest = join(dir, 'asset');
    await downloadFile(`${url}/asset`, dest, undefined, FAST);

    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(requests).toHaveLength(3);
    expect(requests[2].headers.range).toBeUndefined();
  });

  it('restarts from scratch when the 206 reports a different total size', async () => {
    const { url, requests } = await serve((req, res, n) => {
      if (n === 1) { sendThenDrop(res, 10_000); return; }
      if (n === 2) {
        // Continues at the right byte, but of a file of another size.
        const from = rangeStart(req) ?? 0;
        res.writeHead(206, {
          'Content-Length': BODY.length - from,
          'Content-Range': `bytes ${from}-${BODY.length - 1}/${BODY.length + 5}`,
        });
        res.end(BODY.subarray(from));
        return;
      }
      sendRanged(req, res);
    });
    const dest = join(dir, 'asset');
    await downloadFile(`${url}/asset`, dest, undefined, FAST);

    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(requests).toHaveLength(3);
    expect(rangeStart(requests[1])).toBeGreaterThan(0);
    expect(requests[2].headers.range).toBeUndefined();
  });

  it('appends a 206 whose Content-Range has an unknown total (…/*) and checks it against the first length', async () => {
    const { url, requests } = await serve((req, res, n) => {
      if (n === 1) { sendThenDrop(res, 20_000); return; }
      const from = rangeStart(req) ?? 0;
      res.writeHead(206, { 'Content-Range': `bytes ${from}-${BODY.length - 1}/*` });
      res.end(BODY.subarray(from));
    });
    const dest = join(dir, 'asset');
    const p = progressRecorder();
    await downloadFile(`${url}/asset`, dest, p.onProgress, FAST);

    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(rangeStart(requests[1])).toBeGreaterThan(0);
    expectMonotonic(p.calls);
  });

  it('aborts a stalled attempt and resumes it', async () => {
    const { url, requests } = await serve((req, res, n) => {
      if (n === 1) {
        res.writeHead(200, { 'Content-Length': BODY.length });
        res.write(BODY.subarray(0, 16_000)); // ...and never another byte
        return;
      }
      sendRanged(req, res);
    });
    const dest = join(dir, 'asset');
    const started = Date.now();
    await downloadFile(`${url}/asset`, dest, undefined, FAST);

    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(rangeStart(requests[1])).toBe(16_000);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('lets the stall timeout, not the request timeout, govern a pause in the body', async () => {
    const { url, requests } = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Length': BODY.length });
      res.write(BODY.subarray(0, 16_000));
      // Longer than the request timeout, shorter than the stall timeout.
      setTimeout(() => res.end(BODY.subarray(16_000)), 600);
    });
    const dest = join(dir, 'asset');
    const retries: Error[] = [];
    await downloadFile(`${url}/asset`, dest, undefined, {
      ...FAST, requestTimeoutMs: 200, stallTimeoutMs: 2_000, onRetry: (r) => retries.push(r.error),
    });

    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(retries).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('still times out a request whose response headers don\'t arrive', async () => {
    const { url, requests } = await serve((req, res, n) => {
      if (n === 1) return; // never answers
      sendRanged(req, res);
    });
    const dest = join(dir, 'asset');
    const retries: Error[] = [];
    await downloadFile(`${url}/asset`, dest, undefined, {
      ...FAST, requestTimeoutMs: 200, stallTimeoutMs: 2_000, onRetry: (r) => retries.push(r.error),
    });

    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(retries.map((e) => e.message)).toEqual(['Request timed out after 200ms']);
  });

  it('re-resolves the redirect each attempt (the signed CDN URL is single-use)', async () => {
    const cdnA = await serve((req, res) => {
      if (req.url !== '/signed?sig=1') { res.writeHead(403); res.end(); return; }
      sendThenDrop(res, 25_000);
    });
    const cdnB = await serve((req, res) => {
      if (req.url !== '/signed?sig=2') { res.writeHead(403); res.end(); return; }
      sendRanged(req, res);
    });
    const origin = await serve((_req, res, n) => {
      res.writeHead(302, { Location: `${n === 1 ? cdnA.url : cdnB.url}/signed?sig=${n}` });
      res.end();
    });
    const dest = join(dir, 'asset');
    await downloadFile(`${origin.url}/releases/download/win-v1/Kraki-Setup.exe`, dest, undefined, FAST);

    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(origin.requests).toHaveLength(2);
    expect(cdnA.requests).toHaveLength(1);
    expect(cdnB.requests).toHaveLength(1);
    expect(rangeStart(cdnB.requests[0])).toBeGreaterThan(0);
  });

  it('finishes on 416 when the file already has every byte', async () => {
    const { url, requests } = await serve((req, res, n) => {
      if (n === 1) {
        // Chunked (no length): every byte arrives, then the connection drops
        // before the final chunk.
        res.writeHead(200);
        res.write(BODY, () => setTimeout(() => res.socket?.destroy(), 30));
        return;
      }
      if (rangeStart(req) !== BODY.length) { sendRanged(req, res); return; }
      res.writeHead(416, { 'Content-Range': `bytes */${BODY.length}` });
      res.end();
    });
    const dest = join(dir, 'asset');
    await downloadFile(`${url}/asset`, dest, undefined, FAST);

    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(rangeStart(requests[1])).toBe(BODY.length);
  });

  it('retries a 5xx', async () => {
    const { url, requests } = await serve((req, res, n) => {
      if (n === 1) { res.writeHead(503); res.end(); return; }
      sendRanged(req, res);
    });
    const dest = join(dir, 'asset');
    await downloadFile(`${url}/asset`, dest, undefined, FAST);

    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it('fails at once on a 404 and leaves no file', async () => {
    const { url, requests } = await serve((_req, res) => { res.writeHead(404); res.end(); });
    const dest = join(dir, 'asset');
    await expect(downloadFile(`${url}/asset`, dest, undefined, FAST)).rejects.toThrow('Download failed: HTTP 404');
    expect(requests).toHaveLength(1);
    expect(existsSync(dest)).toBe(false);
  });

  it('fails at once when the file can\'t be written', async () => {
    const { url, requests } = await serve((_req, res) => sendFull(res));
    const dest = join(dir, 'missing-dir', 'asset');
    await expect(downloadFile(`${url}/asset`, dest, undefined, FAST)).rejects.toThrow(/ENOENT/);
    expect(requests).toHaveLength(1);
  });

  it('gives up after maxAttempts attempts in a row that add nothing', async () => {
    const { url, requests } = await serve((_req, res) => { res.socket?.destroy(); });
    const dest = join(dir, 'asset');
    await expect(downloadFile(`${url}/asset`, dest, undefined, { ...FAST, maxAttempts: 3 })).rejects.toThrow();
    expect(requests).toHaveLength(3);
    expect(existsSync(dest)).toBe(false);
  });

  it('keeps going while each attempt adds bytes, beyond maxAttempts drops', async () => {
    const step = 10_000;
    const { url, requests } = await serve((req, res) => {
      const from = rangeStart(req) ?? 0;
      if (from + step < BODY.length) sendThenDrop(res, step, from);
      else sendRanged(req, res);
    });
    const dest = join(dir, 'asset');
    const retries: number[] = [];
    await downloadFile(`${url}/asset`, dest, undefined, { ...FAST, maxAttempts: 2, onRetry: (r) => retries.push(r.received) });

    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(requests.length).toBeGreaterThan(3);
    expect(retries.length).toBe(requests.length - 1);
    for (let i = 1; i < retries.length; i++) expect(retries[i]).toBeGreaterThan(retries[i - 1]);
  });
});

describe('hashFile', () => {
  it('streams the file (a Promise) and returns its SHA-256', async () => {
    const path = join(dir, 'installer.exe');
    const data = Buffer.concat([BODY, BODY, BODY]);
    writeFileSync(path, data);
    const pending = hashFile(path);

    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toBe(createHash('sha256').update(data).digest('hex'));
  });

  it('rejects for a missing file', async () => {
    await expect(hashFile(join(dir, 'missing'))).rejects.toThrow(/ENOENT/);
  });
});
