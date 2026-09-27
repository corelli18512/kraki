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
import { Storage } from '../storage.js';
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

  it('charges actual audio; only open or just-issued leases reserve their remainder', () => {
    storage.upsertUser('u1', 'a');
    const issued = Math.floor(new Date('2026-06-15T10:00:00Z').getTime() / 1000);
    const lease = (jti: string, offset = 0) => storage.recordVoiceLease({
      jti, userId: 'u1', deviceId: 'd', resource: 'voice/doubao',
      quotaSeconds: 300, issuedAtUnixSec: issued + offset, expiresAtUnixSec: issued + 3600,
    });
    lease('pending');
    lease('open', 1);
    lease('closed', 2);
    storage.activateVoiceLease({ jti: 'open', activationId: 'activation-open', activatedAtUnixSec: issued + 3 });
    storage.settleVoiceLease({ jti: 'open', activationId: 'activation-open', audioSeconds: 40.2, reason: 'checkpoint', settledAtUnixSec: issued + 20 });
    storage.activateVoiceLease({ jti: 'closed', activationId: 'activation-closed', activatedAtUnixSec: issued + 3 });
    storage.settleVoiceLease({ jti: 'closed', activationId: 'activation-closed', audioSeconds: 4.1, reason: 'session_final', settledAtUnixSec: issued + 10 });
    storage.settleVoiceLease({ jti: 'closed', activationId: 'activation-closed', audioSeconds: 4.1, reason: 'client_closed', settledAtUnixSec: issued + 11 });

    // pending 300 + open (41 used + 259.8 remaining) + closed 5 used
    expect(storage.voiceSecondsAccountedToday('u1', issued + 30)).toBe(606);
    // The just-issued lease stops reserving once the client never connected.
    expect(storage.voiceSecondsAccountedToday('u1', issued + 200)).toBe(306);
    // A closed socket stops reserving; the lease stays reusable.
    storage.settleVoiceLease({ jti: 'open', activationId: 'activation-open', audioSeconds: 40.2, reason: 'authorization_expired', settledAtUnixSec: issued + 300 });
    expect(storage.voiceSecondsAccountedToday('u1', issued + 300)).toBe(46);
    expect(storage.getVoiceLease('open')?.closedAt).not.toBeNull();
    // Reconnecting reopens (and re-budgets) it.
    expect(storage.activateVoiceLease({ jti: 'open', activationId: 'activation-again', activatedAtUnixSec: issued + 400, dailyCapSec: 7200 }))
      .toEqual({ status: 'replaced', reportedAudioSeconds: 40.2, quotaSeconds: 300 });
    expect(storage.voiceSecondsAccountedToday('u1', issued + 400)).toBe(306);
    // After expiry only actual audio remains.
    expect(storage.voiceSecondsAccountedToday('u1', issued + 4000)).toBe(46);
  });

  it('production repro: 24 short-lived warm leases with ~23 min of speech do not exhaust a 2h cap', () => {
    storage.upsertUser('u1', 'a');
    const day = Math.floor(new Date('2026-09-26T00:10:00Z').getTime() / 1000);
    const usage = [7, 48, 150, 147, 150, 150, 152, 150, 119, 150, 150, 150, 72, 0];
    let t = day;
    for (let i = 0; i < 24; i++) {
      const jti = `lease-${i}`;
      const deviceId = i % 2 === 0 ? 'iphone' : 'mac';
      storage.recordVoiceLease({
        jti, userId: 'u1', deviceId, resource: 'voice/doubao',
        quotaSeconds: 300, issuedAtUnixSec: t, expiresAtUnixSec: t + 86_400,
      });
      storage.activateVoiceLease({ jti, activationId: `activation-${i}`, activatedAtUnixSec: t + 1, dailyCapSec: 7200 });
      const seconds = usage[i] ?? 0;
      if (seconds > 0) {
        storage.settleVoiceLease({ jti, activationId: `activation-${i}`, audioSeconds: seconds, reason: 'session_final', settledAtUnixSec: t + 60 });
      }
      // App backgrounded / relaunched / rolled over: the socket closes.
      if (i < 22) {
        storage.settleVoiceLease({ jti, activationId: `activation-${i}`, audioSeconds: seconds, reason: 'client_closed', settledAtUnixSec: t + 120 });
      }
      t += 1800;
    }
    const used = usage.reduce((a, b) => a + b, 0);
    // actual audio + at most one open lease per device (lease-22, lease-23)
    expect(storage.voiceSecondsAccountedToday('u1', t)).toBe(used + 600);
    expect(used + 600).toBeLessThan(7200 - 300);
  });

  it('re-budgets at activation so concurrent devices never exceed the daily cap together', () => {
    storage.upsertUser('u1', 'a');
    const now = Math.floor(new Date('2026-06-15T10:00:00Z').getTime() / 1000);
    const open = (jti: string, deviceId: string, at: number) => {
      storage.recordVoiceLease({
        jti, userId: 'u1', deviceId, resource: 'voice/doubao',
        quotaSeconds: 300, issuedAtUnixSec: now, expiresAtUnixSec: now + 3600,
      });
      return storage.activateVoiceLease({ jti, activationId: `activation-${jti}`, activatedAtUnixSec: at, dailyCapSec: 700 });
    };
    expect(open('phone', 'd1', now + 1)).toMatchObject({ status: 'activated', quotaSeconds: 300 });
    expect(open('mac', 'd2', now + 1)).toMatchObject({ status: 'activated', quotaSeconds: 300 });
    expect(open('tablet', 'd3', now + 1)).toMatchObject({ status: 'activated', quotaSeconds: 100 });
    expect(open('watch', 'd4', now + 1)).toEqual({ status: 'quota_exhausted', reportedAudioSeconds: 0 });
    expect(storage.voiceSecondsAccountedToday('u1', now + 2)).toBe(700);

    // The phone speaks 30s and disconnects; its unused 270s are freed.
    storage.settleVoiceLease({ jti: 'phone', activationId: 'activation-phone', audioSeconds: 30, reason: 'client_closed', settledAtUnixSec: now + 60 });
    expect(storage.voiceSecondsAccountedToday('u1', now + 60)).toBe(430);
    // The refused lease is dead; the watch asks for a fresh one.
    expect(storage.activateVoiceLease({ jti: 'watch', activationId: 'activation-watch-retry', activatedAtUnixSec: now + 61, dailyCapSec: 700 }))
      .toEqual({ status: 'revoked' });
    expect(open('watch2', 'd4', now + 61)).toMatchObject({ status: 'activated', quotaSeconds: 270 });
    // Nothing is left for the phone to reconnect with.
    expect(storage.activateVoiceLease({ jti: 'phone', activationId: 'activation-phone2', activatedAtUnixSec: now + 62, dailyCapSec: 700 }))
      .toEqual({ status: 'quota_exhausted', reportedAudioSeconds: 30 });
    expect(storage.voiceSecondsAccountedToday('u1', now + 62)).toBe(700);
  });

  it('revokes a device\'s never-connected leases when it asks again', () => {
    storage.upsertUser('u1', 'a');
    const now = Math.floor(new Date('2026-06-15T10:00:00Z').getTime() / 1000);
    for (const jti of ['first', 'second']) {
      storage.recordVoiceLease({
        jti, userId: 'u1', deviceId: 'd', resource: 'voice/doubao',
        quotaSeconds: 300, issuedAtUnixSec: now, expiresAtUnixSec: now + 3600,
      });
    }
    storage.activateVoiceLease({ jti: 'second', activationId: 'activation-second', activatedAtUnixSec: now + 1 });
    expect(storage.revokePendingVoiceLeases('u1', 'd', 'voice/doubao', now + 2)).toBe(1);
    expect(storage.activateVoiceLease({ jti: 'first', activationId: 'late', activatedAtUnixSec: now + 3 }))
      .toEqual({ status: 'revoked' });
    expect(storage.voiceSecondsAccountedToday('u1', now + 3)).toBe(300);
  });

  it('migration stops abandoned older leases from reserving', () => {
    const dir = mkTmpLeaseDir();
    const dbPath = join(dir, 'v11.db');
    const now = Math.floor(Date.now() / 1000);
    const iso = (sec: number) => new Date(sec * 1000).toISOString();
    const v11 = new Storage(dbPath);
    v11.upsertUser('u1', 'a');
    for (const [jti, offset] of [['old', 0], ['newest', 10]] as const) {
      v11.recordVoiceLease({
        jti, userId: 'u1', deviceId: 'd', resource: 'voice/doubao',
        quotaSeconds: 300, issuedAtUnixSec: now - 100 + offset, expiresAtUnixSec: now + 86_000,
      });
      v11.activateVoiceLease({ jti, activationId: `activation-${jti}`, activatedAtUnixSec: now - 90 + offset });
    }
    v11.rawDb.exec(`UPDATE voice_leases SET closed_at = NULL, allowed_seconds = NULL; PRAGMA user_version = 11;`);
    v11.close();
    const migrated = new Storage(dbPath);
    try {
      expect(migrated.getVoiceLease('old')?.closedAt).toBe(iso(now - 90));
      expect(migrated.getVoiceLease('newest')?.closedAt).toBeNull();
      expect(migrated.voiceSecondsAccountedToday('u1', now)).toBe(300);
    } finally {
      migrated.close();
      rm(dir);
    }
  });

  it('rejects activation after expiry and replaces stale warm-connection owners', () => {
    storage.upsertUser('u1', 'a');
    const now = Math.floor(new Date('2026-06-15T10:00:00Z').getTime() / 1000);
    storage.recordVoiceLease({
      jti: 'expired', userId: 'u1', deviceId: 'd', resource: 'voice/doubao',
      quotaSeconds: 300, issuedAtUnixSec: now - 120, expiresAtUnixSec: now - 60,
    });
    expect(storage.activateVoiceLease({
      jti: 'expired', activationId: 'activation-expired', activatedAtUnixSec: now,
    })).toEqual({ status: 'expired' });

    storage.recordVoiceLease({
      jti: 'single-use', userId: 'u1', deviceId: 'd', resource: 'voice/doubao',
      quotaSeconds: 300, issuedAtUnixSec: now, expiresAtUnixSec: now + 60,
    });
    expect(storage.activateVoiceLease({
      jti: 'single-use', activationId: 'activation-first', activatedAtUnixSec: now + 1,
    })).toEqual({ status: 'activated', reportedAudioSeconds: 0, quotaSeconds: 300 });
    expect(storage.activateVoiceLease({
      jti: 'single-use', activationId: 'activation-first', activatedAtUnixSec: now + 2,
    })).toEqual({ status: 'unchanged', reportedAudioSeconds: 0, quotaSeconds: 300 });
    expect(storage.activateVoiceLease({
      jti: 'single-use', activationId: 'activation-replay', activatedAtUnixSec: now + 2,
    })).toEqual({ status: 'replaced', reportedAudioSeconds: 0, quotaSeconds: 300 });

    const beforeMidnight = Math.floor(new Date('2026-06-15T23:59:30Z').getTime() / 1000);
    const afterMidnight = Math.floor(new Date('2026-06-16T00:00:10Z').getTime() / 1000);
    storage.recordVoiceLease({
      jti: 'previous-day', userId: 'u1', deviceId: 'd', resource: 'voice/doubao',
      quotaSeconds: 300, issuedAtUnixSec: beforeMidnight, expiresAtUnixSec: afterMidnight + 300,
    });
    expect(storage.activateVoiceLease({
      jti: 'previous-day', activationId: 'activation-next-day', activatedAtUnixSec: afterMidnight,
    })).toEqual({ status: 'wrong_day' });
  });

  it('stores monotonic cumulative checkpoints; the open socket reserves only its remainder', () => {
    storage.upsertUser('u1', 'a');
    const now = Math.floor(new Date('2026-06-15T10:00:00Z').getTime() / 1000);
    storage.recordVoiceLease({
      jti: 'actual', userId: 'u1', deviceId: 'd', resource: 'voice/doubao',
      quotaSeconds: 300, issuedAtUnixSec: now, expiresAtUnixSec: now + 3600,
    });
    expect(storage.voiceSecondsAccountedToday('u1', now)).toBe(300);

    storage.activateVoiceLease({ jti: 'actual', activationId: 'activation-actual', activatedAtUnixSec: now + 2 });
    expect(storage.settleVoiceLease({ jti: 'actual', activationId: 'activation-actual', audioSeconds: 5.01, reason: 'checkpoint', settledAtUnixSec: now + 10 }))
      .toEqual({ status: 'updated', usedSeconds: 6, reportedAudioSeconds: 5.01 });
    expect(storage.voiceSecondsAccountedToday('u1', now + 10)).toBe(301);
    expect(storage.settleVoiceLease({ jti: 'actual', activationId: 'activation-actual', audioSeconds: 5.01, reason: 'checkpoint', settledAtUnixSec: now + 20 }))
      .toEqual({ status: 'unchanged', usedSeconds: 6, reportedAudioSeconds: 5.01 });
    expect(storage.settleVoiceLease({ jti: 'actual', activationId: 'activation-actual', audioSeconds: 7, reason: 'session_final', settledAtUnixSec: now + 20 }))
      .toEqual({ status: 'updated', usedSeconds: 7, reportedAudioSeconds: 7 });
    expect(storage.settleVoiceLease({ jti: 'actual', activationId: 'activation-actual', audioSeconds: 6, reason: 'checkpoint', settledAtUnixSec: now + 21 }))
      .toEqual({ status: 'stale', usedSeconds: 7, reportedAudioSeconds: 7 });
    expect(storage.getVoiceLease('actual')?.closedAt).toBeNull();
    // Final report for the closing socket, unchanged value, still closes it.
    expect(storage.settleVoiceLease({ jti: 'actual', activationId: 'activation-actual', audioSeconds: 7, reason: 'client_closed', settledAtUnixSec: now + 30 }).status)
      .toBe('unchanged');
    expect(storage.voiceSecondsAccountedToday('u1', now + 30)).toBe(7);
    expect(storage.voiceSecondsAccountedToday('u1', now + 4000)).toBe(7);
  });

  it('clamps settled usage to the signed lease quota', () => {
    storage.upsertUser('u1', 'a');
    const now = Math.floor(Date.now() / 1000);
    storage.recordVoiceLease({
      jti: 'clamp', userId: 'u1', deviceId: 'd', resource: 'voice/doubao',
      quotaSeconds: 300, issuedAtUnixSec: now, expiresAtUnixSec: now + 3600,
    });
    storage.activateVoiceLease({ jti: 'clamp', activationId: 'activation-clamp' });
    expect(storage.settleVoiceLease({ jti: 'clamp', activationId: 'activation-clamp', audioSeconds: 999 }))
      .toEqual({ status: 'updated', usedSeconds: 300, reportedAudioSeconds: 300 });
    expect(storage.settleVoiceLease({ jti: 'missing', activationId: 'activation-missing', audioSeconds: 1 }))
      .toEqual({ status: 'not_found' });
  });

  it('sums daily quota correctly across multiple leases', () => {
    storage.upsertUser('u1', 'a');
    const day0 = Math.floor(new Date('2026-06-15T10:00:00Z').getTime() / 1000);
    const day1 = Math.floor(new Date('2026-06-16T10:00:00Z').getTime() / 1000);

    storage.recordVoiceLease({
      jti: 'a', userId: 'u1', deviceId: 'd', resource: 'voice/doubao',
      quotaSeconds: 1000, issuedAtUnixSec: day0, expiresAtUnixSec: day0 + 60,
    });
    storage.recordVoiceLease({
      jti: 'b', userId: 'u1', deviceId: 'd', resource: 'voice/doubao',
      quotaSeconds: 500, issuedAtUnixSec: day0 + 3600, expiresAtUnixSec: day0 + 3660,
    });
    storage.recordVoiceLease({
      jti: 'c', userId: 'u1', deviceId: 'd', resource: 'voice/doubao',
      quotaSeconds: 2000, issuedAtUnixSec: day1, expiresAtUnixSec: day1 + 60,
    });

    expect(storage.voiceSecondsAccountedToday('u1', day0)).toBe(1500);
    expect(storage.voiceSecondsAccountedToday('u1', day1)).toBe(2000);
    expect(storage.voiceSecondsAccountedToday('u_other', day0)).toBe(0);
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
      voiceLeaseQuotaSec: 1800,
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
      resource: 'voice/doubao', quota_seconds: 1800,
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

  it('grants partial leases near the cap and denies once real usage reaches it', async () => {
    // 5400 daily, 1800 per lease chunk. Each lease is used, then its socket closes.
    const userId = env.storage.getAllUsers()[0].userId;
    const useLease = async (audioSeconds: number) => {
      device.send({ type: 'request_voice_lease', deviceId: device.deviceId, resource: 'voice/doubao' });
      const grant = await device.waitFor('voice_lease_grant');
      const lease = grant.lease as { payload: { jti: string; quota_seconds: number } };
      const activationId = `activation-${lease.payload.jti}`;
      expect(env.storage.activateVoiceLease({ jti: lease.payload.jti, activationId, dailyCapSec: 5400 }).status)
        .toBe('activated');
      env.storage.settleVoiceLease({ jti: lease.payload.jti, activationId, audioSeconds, reason: 'client_closed' });
      return lease.payload.quota_seconds;
    };
    // Idle warm leases cost nothing.
    for (let i = 0; i < 10; i++) expect(await useLease(0)).toBe(1800);
    expect(env.storage.voiceSecondsAccountedToday(userId, Math.floor(Date.now() / 1000))).toBe(0);
    expect(await useLease(1800)).toBe(1800);
    expect(await useLease(1800)).toBe(1800);
    expect(await useLease(1700)).toBe(1800);
    // 100 s left: a partial lease.
    expect(await useLease(100)).toBe(100);
    device.send({ type: 'request_voice_lease', deviceId: device.deviceId, resource: 'voice/doubao' });
    const denied = await device.waitFor('voice_lease_denied');
    expect(denied.reason).toBe('quota_exhausted');
    expect(String(denied.detail)).toContain('5400/5400');
  });

  it('never lets a lease outlive the UTC day it is charged to', async () => {
    device.send({ type: 'request_voice_lease', deviceId: device.deviceId, resource: 'voice/doubao' });
    const grant = await device.waitFor('voice_lease_grant');
    const { iat, exp } = (grant.lease as { payload: { iat: number; exp: number } }).payload;
    const nextMidnight = (Math.floor(iat / 86_400) + 1) * 86_400;
    expect(exp).toBeLessThanOrEqual(Math.max(nextMidnight, iat + 30));
    expect(exp - iat).toBeLessThanOrEqual(3600);
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
