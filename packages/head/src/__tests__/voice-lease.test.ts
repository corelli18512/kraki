/**
 * Tests for LeaseIssuer + voice_leases storage + the request_voice_lease
 * WebSocket handler.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';
import { verifyChallenge, canonicalJson } from '@kraki/crypto';
import { Storage, VOICE_EXPIRY_OVERRUN_SEC } from '../storage.js';
import { LeaseIssuer, _LEASE_KEY_FILENAMES } from '../lease-issuer.js';
import { handleVoiceSettlement } from '../voice-settlement.js';
import { createTestEnv, connectDevice, type TestEnv, type MockDevice } from './integration-helpers.js';

function mkTmpLeaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'kraki-lease-test-'));
}

function rm(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

describe('LeaseIssuer', () => {
  let dir: string;
  afterEach(() => dir && rm(dir));

  it('generates a keypair on first use and writes both PEM files', () => {
    dir = mkTmpLeaseDir();
    const issuer = LeaseIssuer.loadOrGenerate(dir);
    expect(issuer.getPublicKeyPem()).toContain('BEGIN PUBLIC KEY');
    expect(existsSync(join(dir, _LEASE_KEY_FILENAMES.private))).toBe(true);
    expect(existsSync(join(dir, _LEASE_KEY_FILENAMES.public))).toBe(true);
  });

  it('chmods the private key to 600 (POSIX)', () => {
    if (process.platform === 'win32') return; // skip on Windows
    dir = mkTmpLeaseDir();
    LeaseIssuer.loadOrGenerate(dir);
    const stat = statSync(join(dir, _LEASE_KEY_FILENAMES.private));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('reuses an existing keypair across reloads (no rotation surprises)', () => {
    dir = mkTmpLeaseDir();
    const first = LeaseIssuer.loadOrGenerate(dir);
    const second = LeaseIssuer.loadOrGenerate(dir);
    expect(second.getPublicKeyPem()).toBe(first.getPublicKeyPem());
  });

  it('issues a lease whose signature verifies with the public key', () => {
    dir = mkTmpLeaseDir();
    const issuer = LeaseIssuer.loadOrGenerate(dir);
    const lease = issuer.issue({
      userId: 'u1', deviceId: 'd1',
      quotaSeconds: 7200, ttlSeconds: 86400,
      resource: 'voice/doubao',
      nowUnixSec: 1_700_000_000,
      jti: 'jti-1',
    });
    expect(lease.payload).toMatchObject({
      ver: 1, iss: 'kraki-head', sub: 'u1', did: 'd1',
      iat: 1_700_000_000, exp: 1_700_000_000 + 86400,
      quota_seconds: 7200, resource: 'voice/doubao', jti: 'jti-1',
    });
    const canonical = canonicalJson(lease.payload as unknown as Record<string, unknown>);
    expect(verifyChallenge(canonical, lease.signature, issuer.getPublicKeyPem())).toBe(true);
  });

  it('issued lease is rejected by a different (rotated) keypair', () => {
    const dir1 = mkTmpLeaseDir();
    const dir2 = mkTmpLeaseDir();
    try {
      const issuerA = LeaseIssuer.loadOrGenerate(dir1);
      const issuerB = LeaseIssuer.loadOrGenerate(dir2);
      const lease = issuerA.issue({
        userId: 'u', deviceId: 'd', quotaSeconds: 1, ttlSeconds: 60,
        resource: 'voice/doubao',
      });
      const canonical = canonicalJson(lease.payload as unknown as Record<string, unknown>);
      expect(verifyChallenge(canonical, lease.signature, issuerB.getPublicKeyPem())).toBe(false);
    } finally {
      rm(dir1); rm(dir2);
    }
  });
});

describe('Storage voice_leases', () => {
  let storage: Storage;
  beforeEach(() => {
    storage = new Storage(':memory:');
  });
  afterEach(() => storage.close());

  it('migrates v8 leases into resumable cumulative warm-connection accounting', () => {
    const dir = mkTmpLeaseDir();
    const dbPath = join(dir, 'legacy.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE voice_leases (
        jti TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        resource TEXT NOT NULL,
        quota_seconds INTEGER NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
      INSERT INTO voice_leases (
        jti, user_id, device_id, resource, quota_seconds, issued_at, expires_at
      ) VALUES (
        'legacy-lease', 'u1', 'd1', 'voice/doubao', 300,
        '2026-06-15T10:00:00.000Z', '2026-06-15T10:05:00.000Z'
      );
      PRAGMA user_version = 8;
    `);
    legacy.close();

    const migrated = new Storage(dbPath);
    try {
      expect(migrated.rawDb.pragma('user_version', { simple: true })).toBe(12);
      expect(migrated.getVoiceLease('legacy-lease')).toMatchObject({
        activationId: 'legacy:legacy-lease',
        activatedAt: '2026-06-15T10:00:00.000Z',
        usedSeconds: null,
        reportedAudioSeconds: 0,
      });
      expect(migrated.voiceSecondsAccountedToday(
        'u1', Math.floor(new Date('2026-06-15T23:00:00Z').getTime() / 1000)
      )).toBe(0);
      expect(migrated.activateVoiceLease({
        jti: 'legacy-lease', activationId: 'activation-replay',
        activatedAtUnixSec: Math.floor(new Date('2026-06-15T10:01:00Z').getTime() / 1000),
      })).toEqual({ status: 'replaced', reportedAudioSeconds: 0, quotaSeconds: 300 });
    } finally {
      migrated.close();
      rm(dir);
    }
  });

  it('records and reads back a single lease', () => {
    storage.upsertUser('u1', 'alice');
    storage.recordVoiceLease({
      jti: 'j1', userId: 'u1', deviceId: 'd1',
      resource: 'voice/doubao', quotaSeconds: 3600,
      issuedAtUnixSec: 1_700_000_000,
      expiresAtUnixSec: 1_700_086_400,
    });
    const got = storage.getVoiceLease('j1');
    expect(got).toMatchObject({
      jti: 'j1', userId: 'u1', deviceId: 'd1',
      resource: 'voice/doubao', quotaSeconds: 3600,
    });
  });

  it('rejects duplicate jti (UUID-collision guard)', () => {
    storage.upsertUser('u1', 'a');
    storage.recordVoiceLease({
      jti: 'j', userId: 'u1', deviceId: 'd', resource: 'voice/doubao',
      quotaSeconds: 1, issuedAtUnixSec: 1, expiresAtUnixSec: 2,
    });
    expect(() => storage.recordVoiceLease({
      jti: 'j', userId: 'u1', deviceId: 'd', resource: 'voice/doubao',
      quotaSeconds: 1, issuedAtUnixSec: 1, expiresAtUnixSec: 2,
    })).toThrow();
  });

  const T = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
  const record = (jti: string, deviceId: string, issued: number, ttl = 86_400, quota = 14_400) =>
    storage.recordVoiceLease({
      jti, userId: 'u1', deviceId, resource: 'voice/doubao',
      quotaSeconds: quota, issuedAtUnixSec: issued, expiresAtUnixSec: issued + ttl,
    });
  const activate = (jti: string, at: number, cap = 7200) =>
    storage.activateVoiceLease({ jti, activationId: `act-${jti}`, activatedAtUnixSec: at, dailyCapSec: cap, grants: true });
  const report = (jti: string, seconds: number, at: number, reason = 'checkpoint', cap = 7200) =>
    storage.settleVoiceLease({
      jti, activationId: `act-${jti}`, audioSeconds: seconds, reason,
      settledAtUnixSec: at, dailyCapSec: cap, grants: true,
    });

  it('grants one chunk at activation and renews it with every usage report', () => {
    storage.upsertUser('u1', 'a');
    const t = T('2026-06-15T10:00:00Z');
    record('phone', 'd1', t);
    expect(activate('phone', t + 1)).toEqual({ status: 'activated', reportedAudioSeconds: 0, quotaSeconds: 60 });
    // Idle but connected: only the chunk is reserved.
    expect(storage.voiceSecondsAccountedToday('u1', t + 2)).toBe(60);
    // A 10-minute recording: each 15 s checkpoint moves the allowance ahead.
    let reply;
    for (let second = 15; second <= 600; second += 15) {
      reply = report('phone', second, t + 10 + second);
      expect(reply.quotaSeconds).toBe(second + 60);
    }
    expect(report('phone', 603.4, t + 620, 'session_final').quotaSeconds).toBe(663.4);
    expect(storage.voiceSecondsAccountedToday('u1', t + 620)).toBe(664);
    // Socket closes: only real audio remains charged.
    expect(report('phone', 603.4, t + 700, 'client_closed').quotaSeconds).toBeUndefined();
    expect(storage.voiceSecondsAccountedToday('u1', t + 700)).toBe(604);
    expect(storage.getVoiceLease('phone')?.closedAt).not.toBeNull();
  });

  it('production repro: many warm leases with ~23 min of speech do not exhaust a 2h cap', () => {
    storage.upsertUser('u1', 'a');
    const usage = [7, 48, 150, 147, 150, 150, 152, 150, 119, 150, 150, 150, 72, 0];
    let t = T('2026-09-26T00:10:00Z');
    for (let i = 0; i < 24; i++) {
      const jti = `lease-${i}`;
      record(jti, i % 2 === 0 ? 'iphone' : 'mac', t);
      activate(jti, t + 1);
      const seconds = usage[i] ?? 0;
      if (seconds > 0) report(jti, seconds, t + 60, 'session_final');
      if (i < 22) report(jti, seconds, t + 120, 'client_closed');
      t += 1800;
    }
    const used = usage.reduce((a, b) => a + b, 0);
    // Real audio + one chunk per still-connected device.
    expect(storage.voiceSecondsAccountedToday('u1', t)).toBe(used + 120);
  });

  it('concurrent devices can never jointly exceed the daily cap', () => {
    storage.upsertUser('u1', 'a');
    const t = T('2026-06-15T10:00:00Z');
    for (const d of ['d1', 'd2', 'd3']) record(d, d, t);
    expect(activate('d1', t + 1, 100).quotaSeconds).toBe(60);
    expect(activate('d2', t + 1, 100).quotaSeconds).toBe(40);
    expect(activate('d3', t + 1, 100)).toEqual({ status: 'quota_exhausted', reportedAudioSeconds: 0 });
    expect(storage.getVoiceLease('d3')?.revokedAt).not.toBeNull();
    // d1 speaks 50 s; its renewal only gets what d2's reservation leaves.
    expect(report('d1', 50, t + 60, 'checkpoint', 100).quotaSeconds).toBe(60);
    // d2 disconnects unused: its 40 s return to d1.
    report('d2', 0, t + 61, 'client_closed', 100);
    expect(report('d1', 55, t + 75, 'checkpoint', 100).quotaSeconds).toBe(100);
    expect(report('d1', 100, t + 130, 'checkpoint', 100).quotaSeconds).toBe(100);
    expect(storage.voiceSecondsAccountedToday('u1', t + 130)).toBe(100);
  });

  it('a recording across UTC midnight is charged to each day and never stopped for the cap of the old day', () => {
    storage.upsertUser('u1', 'a');
    const evening = T('2026-06-15T23:40:00Z');
    record('late', 'd1', evening);
    activate('late', evening + 1, 1200);
    // 1170 s already spoken on the 15th.
    expect(report('late', 1170, T('2026-06-15T23:59:40Z'), 'checkpoint', 1200).quotaSeconds).toBe(1200);
    // Next checkpoint lands after midnight: the new day's budget renews it.
    expect(report('late', 1185, T('2026-06-16T00:00:05Z'), 'checkpoint', 1200).quotaSeconds).toBe(1245);
    expect(report('late', 1260, T('2026-06-16T00:01:20Z'), 'session_final', 1200).quotaSeconds).toBe(1320);
    report('late', 1260, T('2026-06-16T00:02:00Z'), 'client_closed', 1200);
    expect(storage.voiceSecondsAccountedToday('u1', T('2026-06-15T23:59:59Z'))).toBe(1170);
    expect(storage.voiceSecondsAccountedToday('u1', T('2026-06-16T12:00:00Z'))).toBe(90);
  });

  it('keeps granting a recording past lease expiry, but only for the overrun window', () => {
    storage.upsertUser('u1', 'a');
    const t = T('2026-06-15T10:00:00Z');
    record('old', 'd1', t, 3600);
    activate('old', t + 1);
    expect(report('old', 30, t + 3600 + 30).quotaSeconds).toBe(90);
    expect(report('old', 40, t + 3600 + VOICE_EXPIRY_OVERRUN_SEC + 1).quotaSeconds).toBe(40);
    expect(storage.activateVoiceLease({ jti: 'old', activationId: 'late', activatedAtUnixSec: t + 3601 }))
      .toEqual({ status: 'expired' });
  });

  it('revoked leases stop being renewed but their usage is still charged', () => {
    storage.upsertUser('u1', 'a');
    const t = T('2026-06-15T10:00:00Z');
    record('r', 'd1', t);
    activate('r', t + 1);
    storage.rawDb.prepare('UPDATE voice_leases SET revoked_at = ? WHERE jti = ?').run(new Date().toISOString(), 'r');
    expect(report('r', 20, t + 20)).toMatchObject({ status: 'updated', quotaSeconds: 20 });
    expect(storage.voiceSecondsAccountedToday('u1', t + 20)).toBe(20);
  });

  it('review: a grant just before the overrun limit stays reserved (no double spend)', () => {
    storage.upsertUser('u1', 'a');
    const t = T('2026-06-15T10:00:00Z');
    record('a', 'd1', t, 3600);
    record('b', 'd2', t, 3600);
    activate('a', t + 1, 120);
    const boundary = t + 3600 + VOICE_EXPIRY_OVERRUN_SEC;
    expect(report('a', 60, boundary - 1, 'checkpoint', 120).quotaSeconds).toBe(120);
    // Past the boundary A still holds its last grant: B must not get it too.
    expect(storage.activateVoiceLease({ jti: 'b', activationId: 'act-b', activatedAtUnixSec: boundary + 1, dailyCapSec: 120, grants: true }).status)
      .toBe('expired');
    record('b2', 'd2', boundary + 1, 3600);
    expect(activate('b2', boundary + 2, 120)).toEqual({ status: 'quota_exhausted', reportedAudioSeconds: 0 });
  });

  it('review: a stale checkpoint after close neither reopens nor re-reserves', () => {
    storage.upsertUser('u1', 'a');
    const t = T('2026-06-15T10:00:00Z');
    record('a', 'd1', t);
    activate('a', t + 1);
    report('a', 15, t + 20, 'checkpoint');
    report('a', 15, t + 30, 'client_closed');
    expect(storage.voiceSecondsAccountedToday('u1', t + 31)).toBe(15);
    const late = report('a', 0, t + 32, 'checkpoint');
    expect(late.quotaSeconds).toBe(15);
    expect(storage.getVoiceLease('a')?.closedAt).not.toBeNull();
    expect(storage.voiceSecondsAccountedToday('u1', t + 33)).toBe(15);
  });

  it('review: a replaced activation cannot charge or obtain grants (no double count on takeover)', () => {
    storage.upsertUser('u1', 'a');
    const t = T('2026-06-15T10:00:00Z');
    record('a', 'd1', t);
    activate('a', t + 1);
    report('a', 15, t + 16);
    expect(storage.activateVoiceLease({ jti: 'a', activationId: 'act-a2', activatedAtUnixSec: t + 20, dailyCapSec: 7200, grants: true }))
      .toMatchObject({ status: 'replaced', reportedAudioSeconds: 15 });
    // The old owner's in-flight checkpoint is rejected…
    expect(report('a', 29, t + 21).status).toBe('conflict');
    // …because the new owner reports the transferred audio itself.
    storage.settleVoiceLease({ jti: 'a', activationId: 'act-a2', audioSeconds: 34, reason: 'client_closed', settledAtUnixSec: t + 40, dailyCapSec: 7200, grants: true });
    expect(storage.voiceSecondsAccountedToday('u1', t + 41)).toBe(34);
  });

  it('review: migration orders leases activated in the same second', () => {
    const dir = mkTmpLeaseDir();
    const dbPath = join(dir, 'v11-same-second.db');
    const now = Math.floor(Date.now() / 1000);
    const v11 = new Storage(dbPath);
    v11.upsertUser('u1', 'a');
    for (const jti of ['x', 'y']) {
      v11.recordVoiceLease({ jti, userId: 'u1', deviceId: 'd', resource: 'voice/doubao', quotaSeconds: 300, issuedAtUnixSec: now - 50, expiresAtUnixSec: now + 86_000 });
      v11.activateVoiceLease({ jti, activationId: `act-${jti}`, activatedAtUnixSec: now - 40 });
    }
    v11.rawDb.exec(`UPDATE voice_leases SET closed_at = NULL, allowed_seconds = NULL; DROP TABLE voice_usage_daily; PRAGMA user_version = 11;`);
    v11.close();
    const migrated = new Storage(dbPath);
    try {
      const open = ['x', 'y'].filter((jti) => migrated.getVoiceLease(jti)?.closedAt === null);
      expect(open).toEqual(['y']);
      expect(migrated.voiceSecondsAccountedToday('u1', now)).toBe(300);
    } finally {
      migrated.close();
      rm(dir);
    }
  });

  it('review: a broker without grants cannot activate a day-scale lease', () => {
    storage.upsertUser('u1', 'a');
    const t = T('2026-06-15T10:00:00Z');
    record('big', 'd1', t);
    expect(storage.activateVoiceLease({ jti: 'big', activationId: 'x', activatedAtUnixSec: t, dailyCapSec: 7200 }))
      .toEqual({ status: 'grants_required', reportedAudioSeconds: 0 });
  });

  it('review: migration keeps reserving a lease whose successor never connected', () => {
    const dir = mkTmpLeaseDir();
    const dbPath = join(dir, 'v11-pending.db');
    const now = Math.floor(Date.now() / 1000);
    const v11 = new Storage(dbPath);
    v11.upsertUser('u1', 'a');
    v11.recordVoiceLease({ jti: 'live', userId: 'u1', deviceId: 'd', resource: 'voice/doubao', quotaSeconds: 300, issuedAtUnixSec: now - 100, expiresAtUnixSec: now + 86_000 });
    v11.activateVoiceLease({ jti: 'live', activationId: 'act-live', activatedAtUnixSec: now - 90 });
    v11.recordVoiceLease({ jti: 'pending', userId: 'u1', deviceId: 'd', resource: 'voice/doubao', quotaSeconds: 300, issuedAtUnixSec: now - 10, expiresAtUnixSec: now + 86_000 });
    v11.rawDb.exec(`UPDATE voice_leases SET closed_at = NULL, allowed_seconds = NULL; DROP TABLE voice_usage_daily; PRAGMA user_version = 11;`);
    v11.close();
    const migrated = new Storage(dbPath);
    try {
      expect(migrated.getVoiceLease('live')?.closedAt).toBeNull();
      expect(migrated.voiceSecondsAccountedToday('u1', now)).toBe(300);
    } finally {
      migrated.close();
      rm(dir);
    }
  });

  it('legacy brokers (no grants) get all that is left today at activation', () => {
    storage.upsertUser('u1', 'a');
    const t = T('2026-06-15T10:00:00Z');
    record('legacy', 'd1', t, 3600, 300);
    expect(storage.activateVoiceLease({ jti: 'legacy', activationId: 'a', activatedAtUnixSec: t, dailyCapSec: 7200 }))
      .toEqual({ status: 'activated', reportedAudioSeconds: 0, quotaSeconds: 300 });
    expect(storage.settleVoiceLease({ jti: 'legacy', activationId: 'a', audioSeconds: 12, reason: 'checkpoint', settledAtUnixSec: t + 20, dailyCapSec: 7200 }))
      .toEqual({ status: 'updated', usedSeconds: 12, reportedAudioSeconds: 12 });
  });

  it('revokes a device\'s never-connected leases when it asks again', () => {
    storage.upsertUser('u1', 'a');
    const t = T('2026-06-15T10:00:00Z');
    record('first', 'd', t);
    record('second', 'd', t);
    activate('second', t + 1);
    expect(storage.revokePendingVoiceLeases('u1', 'd', 'voice/doubao', t + 2)).toBe(1);
    expect(storage.activateVoiceLease({ jti: 'first', activationId: 'late', activatedAtUnixSec: t + 3 }))
      .toEqual({ status: 'revoked' });
  });

  it('migration seeds daily usage and stops abandoned older leases from reserving', () => {
    const dir = mkTmpLeaseDir();
    const dbPath = join(dir, 'v11.db');
    const now = Math.floor(Date.now() / 1000);
    const v11 = new Storage(dbPath);
    v11.upsertUser('u1', 'a');
    for (const [jti, offset] of [['old', 0], ['newest', 10]] as const) {
      v11.recordVoiceLease({
        jti, userId: 'u1', deviceId: 'd', resource: 'voice/doubao',
        quotaSeconds: 300, issuedAtUnixSec: now - 100 + offset, expiresAtUnixSec: now + 86_000,
      });
      v11.activateVoiceLease({ jti, activationId: `activation-${jti}`, activatedAtUnixSec: now - 90 + offset });
    }
    v11.settleVoiceLease({ jti: 'old', activationId: 'activation-old', audioSeconds: 40, reason: 'session_final', settledAtUnixSec: now - 80 });
    v11.rawDb.exec(`
      UPDATE voice_leases SET closed_at = NULL, allowed_seconds = NULL;
      DROP TABLE voice_usage_daily;
      PRAGMA user_version = 11;
    `);
    v11.close();
    const migrated = new Storage(dbPath);
    try {
      expect(migrated.getVoiceLease('old')?.closedAt).not.toBeNull();
      expect(migrated.getVoiceLease('newest')?.closedAt).toBeNull();
      // 40 s spoken + the newest lease's legacy reservation (300).
      expect(migrated.voiceSecondsAccountedToday('u1', now)).toBe(340);
    } finally {
      migrated.close();
      rm(dir);
    }
  });

  it('rejects activation after expiry and replaces stale warm-connection owners', () => {
    storage.upsertUser('u1', 'a');
    const now = T('2026-06-15T10:00:00Z');
    record('expired', 'd', now - 120, 60, 300);
    expect(storage.activateVoiceLease({ jti: 'expired', activationId: 'x', activatedAtUnixSec: now }))
      .toEqual({ status: 'expired' });
    record('single-use', 'd', now, 60, 300);
    expect(storage.activateVoiceLease({ jti: 'single-use', activationId: 'first', activatedAtUnixSec: now + 1 }))
      .toEqual({ status: 'activated', reportedAudioSeconds: 0, quotaSeconds: 300 });
    expect(storage.activateVoiceLease({ jti: 'single-use', activationId: 'first', activatedAtUnixSec: now + 2 }))
      .toEqual({ status: 'unchanged', reportedAudioSeconds: 0, quotaSeconds: 300 });
    expect(storage.activateVoiceLease({ jti: 'single-use', activationId: 'replay', activatedAtUnixSec: now + 2 }))
      .toEqual({ status: 'replaced', reportedAudioSeconds: 0, quotaSeconds: 300 });
    // Leases are no longer bound to their issuance day.
    record('previous-day', 'd', T('2026-06-15T23:59:30Z'), 3600, 300);
    expect(storage.activateVoiceLease({ jti: 'previous-day', activationId: 'next-day', activatedAtUnixSec: T('2026-06-16T00:00:10Z') }).status)
      .toBe('activated');
  });

  it('stores monotonic cumulative checkpoints', () => {
    storage.upsertUser('u1', 'a');
    const now = T('2026-06-15T10:00:00Z');
    record('actual', 'd', now, 3600, 300);
    storage.activateVoiceLease({ jti: 'actual', activationId: 'a', activatedAtUnixSec: now + 2 });
    const settle = (audioSeconds: number, at: number, reason = 'checkpoint') =>
      storage.settleVoiceLease({ jti: 'actual', activationId: 'a', audioSeconds, reason, settledAtUnixSec: at });
    expect(settle(5.01, now + 10)).toEqual({ status: 'updated', usedSeconds: 6, reportedAudioSeconds: 5.01 });
    expect(settle(5.01, now + 20)).toEqual({ status: 'unchanged', usedSeconds: 6, reportedAudioSeconds: 5.01 });
    expect(settle(7, now + 20, 'session_final')).toEqual({ status: 'updated', usedSeconds: 7, reportedAudioSeconds: 7 });
    expect(settle(6, now + 21)).toEqual({ status: 'stale', usedSeconds: 7, reportedAudioSeconds: 7 });
    expect(settle(7, now + 30, 'client_closed').status).toBe('unchanged');
    expect(storage.voiceSecondsAccountedToday('u1', now + 30)).toBe(7);
  });

  it('clamps settled usage to the signed lease quota', () => {
    storage.upsertUser('u1', 'a');
    const now = Math.floor(Date.now() / 1000);
    record('clamp', 'd', now, 3600, 300);
    storage.activateVoiceLease({ jti: 'clamp', activationId: 'activation-clamp' });
    expect(storage.settleVoiceLease({ jti: 'clamp', activationId: 'activation-clamp', audioSeconds: 999 }))
      .toEqual({ status: 'updated', usedSeconds: 300, reportedAudioSeconds: 300 });
    expect(storage.settleVoiceLease({ jti: 'missing', activationId: 'activation-missing', audioSeconds: 1 }))
      .toEqual({ status: 'not_found' });
  });

  it('keeps daily usage per user and per UTC day', () => {
    storage.upsertUser('u1', 'a');
    const day0 = T('2026-06-15T10:00:00Z');
    const day1 = T('2026-06-16T10:00:00Z');
    record('a', 'd', day0);
    activate('a', day0);
    report('a', 100, day0 + 60, 'client_closed');
    record('b', 'd', day1);
    activate('b', day1);
    report('b', 30, day1 + 60, 'client_closed');
    expect(storage.voiceSecondsAccountedToday('u1', day0 + 100)).toBe(100);
    expect(storage.voiceSecondsAccountedToday('u1', day1 + 100)).toBe(30);
    expect(storage.voiceSecondsAccountedToday('u_other', day0)).toBe(0);
    // Issued but never connected leases cost nothing.
    record('idle', 'd', day1);
    expect(storage.voiceSecondsAccountedToday('u1', day1 + 100)).toBe(30);
  });
});

describe('Voice settlement endpoint contract', () => {
  let storage: Storage;
  beforeEach(() => {
    storage = new Storage(':memory:');
    storage.upsertUser('u1', 'alice');
    const now = Math.floor(Date.now() / 1000);
    storage.recordVoiceLease({
      jti: 'lease-12345678', userId: 'u1', deviceId: 'd1',
      resource: 'voice/doubao', quotaSeconds: 300,
      issuedAtUnixSec: now - 5, expiresAtUnixSec: now + 3600,
    });
  });
  afterEach(() => storage.close());

  it('authenticates, activates once and idempotently settles actual usage', () => {
    const activation = JSON.stringify({
      action: 'activate', jti: 'lease-12345678', activationId: 'activation-12345678',
    });
    const body = JSON.stringify({
      action: 'settle', jti: 'lease-12345678', activationId: 'activation-12345678',
      audioSeconds: 5.2, reason: 'done',
    });
    expect(handleVoiceSettlement(storage, 'secret', { authorization: 'Bearer wrong', body }).status).toBe(401);
    expect(handleVoiceSettlement(storage, 'secret', { authorization: 'Bearer secret', body: '{' }).status).toBe(400);
    expect(handleVoiceSettlement(storage, 'secret', {
      authorization: 'Bearer secret',
      body: JSON.stringify({
        action: 'settle', jti: 'missing-123456', activationId: 'activation-missing', audioSeconds: 1,
      }),
    }).status).toBe(404);

    expect(handleVoiceSettlement(storage, 'secret', {
      authorization: 'Bearer secret', body: activation,
    })).toEqual({
      status: 200,
      body: { ok: true, activationStatus: 'activated', reportedAudioSeconds: 0, quotaSeconds: 300 },
    });
    expect(handleVoiceSettlement(storage, 'secret', {
      authorization: 'Bearer secret', body: activation,
    }).body.activationStatus).toBe('unchanged');
    expect(handleVoiceSettlement(storage, 'secret', {
      authorization: 'Bearer secret',
      body: JSON.stringify({
        action: 'activate', jti: 'lease-12345678', activationId: 'different-activation',
      }),
    }).body.activationStatus).toBe('replaced');

    storage.recordVoiceLease({
      jti: 'expired-12345678', userId: 'u1', deviceId: 'd1',
      resource: 'voice/doubao', quotaSeconds: 300,
      issuedAtUnixSec: 1_700_000_000, expiresAtUnixSec: 1_700_000_100,
    });
    const expired = handleVoiceSettlement(storage, 'secret', {
      authorization: 'Bearer secret',
      body: JSON.stringify({
        action: 'activate', jti: 'expired-12345678', activationId: 'activation-expired',
      }),
    });
    expect(expired).toEqual({ status: 409, body: { error: 'lease_expired' } });

    // The replacement activation above owns the lease now, so stale usage from
    // the original connection is rejected.
    expect(handleVoiceSettlement(storage, 'secret', { authorization: 'Bearer secret', body }).status).toBe(409);

    const replacementBody = JSON.stringify({
      action: 'settle', jti: 'lease-12345678', activationId: 'different-activation',
      audioSeconds: 5.2, reason: 'done',
    });
    const first = handleVoiceSettlement(storage, 'secret', {
      authorization: 'Bearer secret', body: replacementBody,
    });
    expect(first).toEqual({
      status: 200,
      body: {
        ok: true,
        usedSeconds: 6,
        reportedAudioSeconds: 5.2,
        settlementStatus: 'updated',
      },
    });
    const retry = handleVoiceSettlement(storage, 'secret', {
      authorization: 'Bearer secret', body: replacementBody,
    });
    expect(retry.body.settlementStatus).toBe('unchanged');
    const advanced = handleVoiceSettlement(storage, 'secret', {
      authorization: 'Bearer secret',
      body: JSON.stringify({
        action: 'settle', jti: 'lease-12345678', activationId: 'different-activation', audioSeconds: 8,
      }),
    });
    expect(advanced.body.settlementStatus).toBe('updated');
  });
});

describe('request_voice_lease handler (integration)', () => {
  let dir: string;
  let env: TestEnv;
  let device: MockDevice;

  beforeEach(async () => {
    dir = mkTmpLeaseDir();
    const issuer = LeaseIssuer.loadOrGenerate(dir);
    env = await createTestEnv({
      leaseIssuer: issuer,
      voiceLeaseTtlSec: 3600,
      voiceDailyQuotaSec: 5400,
    });
    device = await connectDevice(env.port, 'arm-test', 'app', { kind: 'web' });
  });

  afterEach(async () => {
    try { device?.close(); } catch { /* ignore */ }
    await env.cleanup();
    rm(dir);
  });

  it('grants a lease on first request and signature verifies offline', async () => {
    device.send({ type: 'request_voice_lease', deviceId: device.deviceId, resource: 'voice/doubao' });
    const grant = await device.waitFor('voice_lease_grant');
    expect(grant.lease).toBeDefined();

    const lease = grant.lease as { payload: Record<string, unknown>; signature: string };
    expect(lease.payload).toMatchObject({
      ver: 1, iss: 'kraki-head', did: device.deviceId,
      resource: 'voice/doubao', quota_seconds: 10_800,
    });

    // Pull the issuer's pubkey directly (out-of-band — like deployment).
    const issuer = LeaseIssuer.loadOrGenerate(dir);
    const canonical = canonicalJson(lease.payload);
    expect(verifyChallenge(canonical, lease.signature, issuer.getPublicKeyPem())).toBe(true);
  });

  it('denies leases for a deviceId that does not match the authenticated device', async () => {
    device.send({ type: 'request_voice_lease', deviceId: 'someone-else', resource: 'voice/doubao' });
    const denied = await device.waitFor('voice_lease_denied');
    expect(denied.reason).toBe('invalid_request');
    expect(String(denied.detail)).toMatch(/deviceId/);
  });

  it('denies leases for unknown resources', async () => {
    device.send({ type: 'request_voice_lease', deviceId: device.deviceId, resource: 'voice/whisper' });
    const denied = await device.waitFor('voice_lease_denied');
    expect(denied.reason).toBe('invalid_request');
  });

  it('keeps issuing leases while real usage is below the cap and denies once it is reached', async () => {
    const userId = env.storage.getAllUsers()[0].userId;
    const useLease = async (audioSeconds: number) => {
      device.send({ type: 'request_voice_lease', deviceId: device.deviceId, resource: 'voice/doubao' });
      const grant = await device.waitFor('voice_lease_grant');
      const jti = (grant.lease as { payload: { jti: string } }).payload.jti;
      const activationId = `activation-${jti}`;
      expect(env.storage.activateVoiceLease({ jti, activationId, dailyCapSec: 5400, grants: true }).status)
        .toBe('activated');
      let reported = 0;
      while (reported < audioSeconds) {
        reported = Math.min(audioSeconds, reported + 15);
        env.storage.settleVoiceLease({ jti, activationId, audioSeconds: reported, reason: 'checkpoint', dailyCapSec: 5400, grants: true });
      }
      env.storage.settleVoiceLease({ jti, activationId, audioSeconds: reported, reason: 'client_closed' });
    };
    // Idle leases (relaunches, reconnects) cost nothing.
    for (let i = 0; i < 10; i++) await useLease(0);
    expect(env.storage.voiceSecondsAccountedToday(userId, Math.floor(Date.now() / 1000))).toBe(0);
    await useLease(3000);
    await useLease(2400);
    device.send({ type: 'request_voice_lease', deviceId: device.deviceId, resource: 'voice/doubao' });
    const denied = await device.waitFor('voice_lease_denied');
    expect(denied.reason).toBe('quota_exhausted');
    expect(String(denied.detail)).toContain('5400/5400');
  });

  it('issues long-lived leases independent of the UTC day', async () => {
    device.send({ type: 'request_voice_lease', deviceId: device.deviceId, resource: 'voice/doubao' });
    const grant = await device.waitFor('voice_lease_grant');
    const { iat, exp } = (grant.lease as { payload: { iat: number; exp: number } }).payload;
    expect(exp - iat).toBe(3600);
  });
});

describe('request_voice_lease without issuer configured', () => {
  let env: TestEnv;
  let device: MockDevice;
  beforeEach(async () => {
    env = await createTestEnv({}); // no leaseIssuer
    device = await connectDevice(env.port, 'arm-test', 'app', { kind: 'web' });
  });
  afterEach(async () => {
    try { device?.close(); } catch { /* ignore */ }
    await env.cleanup();
  });

  it('responds with not_entitled', async () => {
    device.send({ type: 'request_voice_lease', deviceId: device.deviceId, resource: 'voice/doubao' });
    const denied = await device.waitFor('voice_lease_denied');
    expect(denied.reason).toBe('not_entitled');
  });
});
