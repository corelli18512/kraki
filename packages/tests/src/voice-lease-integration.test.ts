/**
 * Cross-package integration: real LeaseIssuer (head) ↔ real verifyLease (broker)
 * ↔ real broker WSS ↔ real mock Doubao. This is the path that ships to
 * production. The bug surfaced in the original review (broker required `alg`
 * but issuer didn't set it) would have failed this test loudly — keeping it
 * here as a regression guard.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { LeaseIssuer } from '@kraki/head';
import { startBroker, verifyLease, type BrokerServer } from '@kraki/voice-broker';
import { startMockDoubao, type MockDoubaoServer } from '@kraki/voice-broker/mock';
import { createLogger } from '@kraki/voice-broker/logger';
import type { VoiceLease } from '@kraki/protocol';

const SILENT = createLogger('test', 'error');

describe('voice lease: real head issuer ↔ real broker verifier', () => {
  let dir: string;
  let issuer: LeaseIssuer;
  let mock: MockDoubaoServer;
  let broker: BrokerServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kraki-int-lease-'));
    issuer = LeaseIssuer.loadOrGenerate(dir);
    mock = await startMockDoubao({ port: 0, requireAuthHeaders: false, logger: SILENT });
    broker = await startBroker({
      port: 0,
      doubaoEndpoint: mock.url,
      doubaoAccessKey: 'k',
      doubaoResourceId: 'volc.bigasr.sauc.duration',
      logger: SILENT,
      leasePublicKeyPem: issuer.getPublicKeyPem(),
    });
  });

  afterEach(async () => {
    await broker.close();
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('verifyLease accepts a lease produced by LeaseIssuer (direct, no wire)', () => {
    const lease = issuer.issue({
      userId: 'u1', deviceId: 'dev_1', quotaSeconds: 600, ttlSeconds: 3600,
      resource: 'voice/doubao',
    });
    const res = verifyLease(lease, issuer.getPublicKeyPem(), {
      resource: 'voice/doubao', deviceId: 'dev_1',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload.quota_seconds).toBe(600);
    }
  });

  it('lease survives JSON round-trip (the actual production wire path)', () => {
    const lease = issuer.issue({
      userId: 'u1', deviceId: 'dev_1', quotaSeconds: 600, ttlSeconds: 3600,
      resource: 'voice/doubao',
    });
    // Mimic what the head's WS handler does: ship inside an envelope.
    const envelope = JSON.stringify({ type: 'voice_lease_grant', lease });
    const parsed = JSON.parse(envelope) as { lease: VoiceLease };

    const res = verifyLease(parsed.lease, issuer.getPublicKeyPem(), {
      resource: 'voice/doubao', deviceId: 'dev_1',
    });
    expect(res.ok).toBe(true);
  });

  it('broker accepts a connection presenting a real head-issued lease', async () => {
    const lease = issuer.issue({
      userId: 'u1', deviceId: 'dev_arm_1', quotaSeconds: 600, ttlSeconds: 3600,
      resource: 'voice/doubao',
    });

    const ws = new WebSocket(broker.url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (e) => reject(e));
    });

    const events: Array<Record<string, unknown>> = [];
    let closeCode: number | undefined;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try { events.push(JSON.parse(data.toString('utf-8'))); } catch { /* ignore */ }
    });
    ws.on('close', (code) => { closeCode = code; });

    ws.send(JSON.stringify({ type: 'start', deviceId: 'dev_arm_1', lease }));

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (events.some((e) => e.type === 'ready')) break;
      if (events.some((e) => e.type === 'session_denied')) break;
      if (closeCode !== undefined) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const denied = events.find((e) => e.type === 'session_denied');
    if (denied) {
      throw new Error(`broker rejected head-issued lease: ${JSON.stringify(denied)}`);
    }
    expect(events.find((e) => e.type === 'ready')).toBeDefined();

    ws.close();
  });

  it('broker rejects a head-issued lease for a different device (wrong_device)', async () => {
    const lease = issuer.issue({
      userId: 'u1', deviceId: 'dev_arm_1', quotaSeconds: 600, ttlSeconds: 3600,
      resource: 'voice/doubao',
    });

    const ws = new WebSocket(broker.url);
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));

    const events: Array<Record<string, unknown>> = [];
    let closeCode: number | undefined;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try { events.push(JSON.parse(data.toString('utf-8'))); } catch { /* ignore */ }
    });
    ws.on('close', (code) => { closeCode = code; });

    ws.send(JSON.stringify({ type: 'start', deviceId: 'dev_arm_2', lease }));

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && closeCode === undefined) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(closeCode).toBe(1008);
    expect(events.find((e) => e.type === 'session_denied')?.reason).toBe('wrong_device');
  });
});
