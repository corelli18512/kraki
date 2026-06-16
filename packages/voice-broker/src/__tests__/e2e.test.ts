/**
 * End-to-end tests for DoubaoClient ↔ mock Doubao server.
 *
 * Exercises the whole wire pipeline without touching the real Doubao endpoint
 * or needing credentials. If these pass, you know:
 *   1. The codec is correct in both directions.
 *   2. The DoubaoClient lifecycle (connect / start / sendAudio / finish) works.
 *   3. The mock server's auth gating + happy-path responses behave.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DoubaoClient, type TranscriptUpdate } from '../doubao-client.js';
import { startMockDoubao, type MockDoubaoServer } from '../mock-doubao.js';
import { startBroker, type BrokerServer } from '../server.js';
import { createLogger } from '../logger.js';
import { WebSocket } from 'ws';

const SILENT_LOGGER = createLogger('test', 'error');

describe('DoubaoClient ↔ mock Doubao (direct)', () => {
  let mock: MockDoubaoServer;
  beforeEach(async () => {
    mock = await startMockDoubao({ port: 0, requireAuthHeaders: false, logger: SILENT_LOGGER });
  });
  afterEach(async () => {
    await mock.close();
  });

  it('streams audio and receives a final transcript', async () => {
    const updates: TranscriptUpdate[] = [];
    const client = new DoubaoClient({
      appKey: 'k',
      accessKey: 'k',
      resourceId: 'volc.bigasr.sauc.duration',
      endpoint: mock.url,
      logger: SILENT_LOGGER,
    });
    client.on('transcript', (u) => updates.push(u));

    await client.connect();
    client.start();
    for (let i = 0; i < 8; i++) {
      client.sendAudio(Buffer.alloc(6400, 0));
    }
    client.finish();

    const finalUpdate = await new Promise<TranscriptUpdate>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 4000);
      client.once('final', (u) => {
        clearTimeout(t);
        resolve(u);
      });
    });
    client.close();

    expect(finalUpdate.sessionFinal).toBe(true);
    expect(finalUpdate.text.length).toBeGreaterThan(0);
    // At least one partial before the final.
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates.at(-1)?.sessionFinal).toBe(true);
  });

  it('rejects connections that lack auth headers when requireAuthHeaders=true', async () => {
    const strict = await startMockDoubao({ port: 0, requireAuthHeaders: true, logger: SILENT_LOGGER });
    try {
      // Real DoubaoClient always sends headers, so we open a bare ws to prove the gate works.
      const ws = new WebSocket(strict.url);
      await new Promise<void>((resolve) => ws.once('open', () => resolve()));

      const code = await new Promise<number>((resolve) => {
        ws.once('close', (c) => resolve(c));
      });
      expect(code).toBe(1008);
    } finally {
      await strict.close();
    }
  });
});

describe('broker WSS ↔ mock Doubao (full stack)', () => {
  let mock: MockDoubaoServer;
  let broker: BrokerServer;

  beforeEach(async () => {
    mock = await startMockDoubao({ port: 0, requireAuthHeaders: false, logger: SILENT_LOGGER });
    broker = await startBroker({
      port: 0,
      doubaoEndpoint: mock.url,
      doubaoAppKey: 'k',
      doubaoAccessKey: 'k',
      doubaoResourceId: 'volc.bigasr.sauc.duration',
      logger: SILENT_LOGGER,
      devNoAuth: true,
    });
  });
  afterEach(async () => {
    await broker.close();
    await mock.close();
  });

  it('arm-style client receives ready + transcripts + closed', async () => {
    const events: Array<{ type: string; text?: string; finalSegment?: boolean; sessionFinal?: boolean }> = [];
    const ws = new WebSocket(broker.url);
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString('utf-8'));
      events.push(msg);
    });

    ws.send(JSON.stringify({ type: 'start', uid: 'test' }));
    await waitFor(() => events.some((e) => e.type === 'ready'), 2000);

    for (let i = 0; i < 6; i++) {
      ws.send(Buffer.alloc(6400, 0));
      await sleep(20);
    }
    ws.send(JSON.stringify({ type: 'finish' }));

    await waitFor(() => events.some((e) => e.type === 'transcript' && e.sessionFinal === true), 4000);

    const transcripts = events.filter((e) => e.type === 'transcript');
    expect(transcripts.length).toBeGreaterThanOrEqual(1);
    const finalT = transcripts.find((e) => e.sessionFinal === true);
    expect(finalT?.text?.length ?? 0).toBeGreaterThan(0);
    ws.close();
  });

  it('rejects audio before start with an error message', async () => {
    const ws = new WebSocket(broker.url);
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));

    const errPromise = new Promise<string>((resolve) => {
      ws.once('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8'));
        resolve(msg.message);
      });
    });

    ws.send(Buffer.alloc(64));
    const errMsg = await errPromise;
    expect(errMsg).toContain('audio sent before start');
    ws.close();
  });

  it('serves /healthz', async () => {
    const httpUrl = broker.url.replace('ws://', 'http://').replace('/voice', '/healthz');
    const res = await fetch(httpUrl);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, role: 'voice-broker' });
  });
});

// ── helpers ──

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
