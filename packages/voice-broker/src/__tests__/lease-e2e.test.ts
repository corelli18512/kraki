/**
 * End-to-end tests for broker lease enforcement.
 *
 * Spins up: real broker (with a pinned pubkey) + mock Doubao + a WS client
 * acting as an arm device. Tests cover the user-visible paths:
 *
 *  - valid lease  → handshake succeeds, transcripts arrive, clean close
 *  - missing lease in start  → session_denied / 1008
 *  - wrong device in lease   → session_denied / 1008
 *  - mid-stream quota exhaustion → session_denied / 1008
 *  - devNoAuth=true bypasses the whole flow (back-compat with v0 web client)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { signChallenge, canonicalJson } from '@kraki/crypto';
import type { VoiceLease, VoiceLeasePayload } from '@kraki/protocol';
import { startMockDoubao, type MockDoubaoServer } from '../mock-doubao.js';
import { startBroker, type BrokerServer } from '../server.js';
import { createLogger } from '../logger.js';

const SILENT = createLogger('test', 'error');

const NOW = () => Math.floor(Date.now() / 1000);

function genKeys() {
  const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    pub: kp.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    priv: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function mintLease(privPem: string, opts: Partial<{ did: string; quota: number; ttl: number; userId: string; resource: VoiceLeasePayload['resource'] }> = {}): VoiceLease {
  const iat = NOW();
  const payload: VoiceLeasePayload = {
    ver: 1, iss: 'kraki-head',
    sub: opts.userId ?? 'u1',
    did: opts.did ?? 'dev_test',
    iat, exp: iat + (opts.ttl ?? 3600),
    quota_seconds: opts.quota ?? 1800,
    resource: opts.resource ?? 'voice/doubao',
    jti: randomUUID(),
  };
  const canonical = canonicalJson(payload as unknown as Record<string, unknown>);
  return { payload, signature: signChallenge(canonical, privPem), alg: 'RSA-SHA256' };
}

interface Recorder {
  events: Array<Record<string, unknown>>;
  closeCode?: number;
  closeReason?: string;
}

function attach(ws: WebSocket): Recorder {
  const rec: Recorder = { events: [] };
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try { rec.events.push(JSON.parse(data.toString('utf-8'))); } catch { /* ignore */ }
  });
  ws.on('close', (code, reason) => {
    rec.closeCode = code;
    rec.closeReason = reason?.toString('utf-8') ?? '';
  });
  return rec;
}

async function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
  return ws;
}

async function waitFor(check: () => boolean, timeoutMs: number, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

describe('broker — startup interlock', () => {
  let mock: MockDoubaoServer;
  beforeEach(async () => {
    mock = await startMockDoubao({ port: 0, requireAuthHeaders: false, logger: SILENT });
  });
  afterEach(async () => { await mock.close(); });

  it('refuses to start with neither leasePublicKeyPem nor devNoAuth', async () => {
    await expect(startBroker({
      port: 0, doubaoEndpoint: mock.url, doubaoAccessKey: 'k', doubaoResourceId: 'r',
      logger: SILENT,
    })).rejects.toThrow(/no leasePublicKeyPem/);
  });

  it('refuses to start with BOTH devNoAuth and leasePublicKeyPem', async () => {
    const keys = genKeys();
    await expect(startBroker({
      port: 0, doubaoEndpoint: mock.url, doubaoAccessKey: 'k', doubaoResourceId: 'r',
      logger: SILENT, devNoAuth: true, leasePublicKeyPem: keys.pub,
    })).rejects.toThrow(/both devNoAuth/);
  });
});

describe('broker — lease enforcement', () => {
  let mock: MockDoubaoServer;
  let broker: BrokerServer;
  let keys: { pub: string; priv: string };

  beforeEach(async () => {
    keys = genKeys();
    mock = await startMockDoubao({ port: 0, requireAuthHeaders: false, logger: SILENT });
    broker = await startBroker({
      port: 0, doubaoEndpoint: mock.url,
      doubaoAccessKey: 'k', doubaoResourceId: 'volc.bigasr.sauc.duration',
      logger: SILENT, leasePublicKeyPem: keys.pub,
    });
  });
  afterEach(async () => {
    await broker.close();
    await mock.close();
  });

  it('accepts a valid lease and produces transcripts', async () => {
    const ws = await open(broker.url);
    const rec = attach(ws);

    const lease = mintLease(keys.priv, { did: 'dev_arm_1' });
    ws.send(JSON.stringify({ type: 'start', deviceId: 'dev_arm_1', lease }));

    await waitFor(() => rec.events.some((e) => e.type === 'ready'), 3000, 'ready');

    for (let i = 0; i < 4; i++) {
      ws.send(Buffer.alloc(6400, 0));
      await new Promise((r) => setTimeout(r, 15));
    }
    ws.send(JSON.stringify({ type: 'finish' }));

    await waitFor(
      () => rec.events.some((e) => e.type === 'transcript' && e.sessionFinal === true),
      4000, 'final transcript'
    );
    ws.close();
  });

  it('refuses connection with no lease in start (1008)', async () => {
    const ws = await open(broker.url);
    const rec = attach(ws);
    ws.send(JSON.stringify({ type: 'start', deviceId: 'dev_arm_1' }));

    await waitFor(() => rec.closeCode !== undefined, 2000, 'close');
    expect(rec.closeCode).toBe(1008);
    expect(rec.events.find((e) => e.type === 'session_denied')?.reason).toBe('missing_lease');
  });

  it('refuses lease bound to a different device (1008, wrong_device)', async () => {
    const ws = await open(broker.url);
    const rec = attach(ws);
    const lease = mintLease(keys.priv, { did: 'dev_other' });
    ws.send(JSON.stringify({ type: 'start', deviceId: 'dev_arm_1', lease }));

    await waitFor(() => rec.closeCode !== undefined, 2000, 'close');
    expect(rec.closeCode).toBe(1008);
    expect(rec.events.find((e) => e.type === 'session_denied')?.reason).toBe('wrong_device');
  });

  it('refuses an expired lease (1008, expired)', async () => {
    const ws = await open(broker.url);
    const rec = attach(ws);
    // Mint a lease with iat far in the past and ttl=60s.
    const iat = NOW() - 3600;
    const payload: VoiceLeasePayload = {
      ver: 1, iss: 'kraki-head', sub: 'u1', did: 'dev_arm_1',
      iat, exp: iat + 60,
      quota_seconds: 1800, resource: 'voice/doubao', jti: randomUUID(),
    };
    const lease: VoiceLease = {
      payload,
      signature: signChallenge(canonicalJson(payload as unknown as Record<string, unknown>), keys.priv),
      alg: 'RSA-SHA256',
    };
    ws.send(JSON.stringify({ type: 'start', deviceId: 'dev_arm_1', lease }));

    await waitFor(() => rec.closeCode !== undefined, 2000, 'close');
    expect(rec.closeCode).toBe(1008);
    expect(rec.events.find((e) => e.type === 'session_denied')?.reason).toBe('expired');
  });

  it('refuses a lease signed with a different key (1008, bad_signature)', async () => {
    const ws = await open(broker.url);
    const rec = attach(ws);
    const other = genKeys();
    const lease = mintLease(other.priv, { did: 'dev_arm_1' });
    ws.send(JSON.stringify({ type: 'start', deviceId: 'dev_arm_1', lease }));

    await waitFor(() => rec.closeCode !== undefined, 2000, 'close');
    expect(rec.closeCode).toBe(1008);
    expect(rec.events.find((e) => e.type === 'session_denied')?.reason).toBe('bad_signature');
  });

  it('closes mid-stream when audio exceeds the lease quota', async () => {
    const ws = await open(broker.url);
    const rec = attach(ws);
    // 1 second of audio at 16kHz mono int16 = 32_000 bytes. Set quota = 1s
    // and stream 2s worth (64_000 bytes).
    const lease = mintLease(keys.priv, { did: 'dev_arm_1', quota: 1 });
    ws.send(JSON.stringify({ type: 'start', deviceId: 'dev_arm_1', lease }));
    await waitFor(() => rec.events.some((e) => e.type === 'ready'), 3000, 'ready');

    // Stream 2 seconds of audio in 200ms chunks → should hit quota after ~1s.
    for (let i = 0; i < 10; i++) {
      ws.send(Buffer.alloc(6400, 0)); // 200ms each
      await new Promise((r) => setTimeout(r, 5));
    }

    await waitFor(() => rec.closeCode !== undefined, 3000, 'close');
    expect(rec.closeCode).toBe(1008);
    expect(rec.events.find((e) => e.type === 'session_denied')?.reason).toBe('quota_exhausted');
  });
});

describe('broker — devNoAuth bypasses lease checks', () => {
  let mock: MockDoubaoServer;
  let broker: BrokerServer;

  beforeEach(async () => {
    mock = await startMockDoubao({ port: 0, requireAuthHeaders: false, logger: SILENT });
    broker = await startBroker({
      port: 0, doubaoEndpoint: mock.url,
      doubaoAccessKey: 'k', doubaoResourceId: 'volc.bigasr.sauc.duration',
      logger: SILENT, devNoAuth: true,
    });
  });
  afterEach(async () => {
    await broker.close();
    await mock.close();
  });

  it('accepts a bare start with no lease', async () => {
    const ws = await open(broker.url);
    const rec = attach(ws);
    ws.send(JSON.stringify({ type: 'start', uid: 'test' }));
    await waitFor(() => rec.events.some((e) => e.type === 'ready'), 3000, 'ready');
    ws.send(JSON.stringify({ type: 'finish' }));
    ws.close();
  });
});
