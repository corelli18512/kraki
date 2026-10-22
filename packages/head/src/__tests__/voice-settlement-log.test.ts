/**
 * Log audit 2026-10-22 (g): settlement lines did not say which lease or device
 * they were about, routine no-change reports were half of all non-health
 * lines, and rejected settlements were not logged at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Storage } from '../storage.js';
import { handleVoiceSettlement, logVoiceSettlement } from '../voice-settlement.js';
import { captureLogs, silenceLogs, type CapturingLogger } from './log-capture.js';

describe('voice settlement log lines', () => {
  let storage: Storage;
  let logs: CapturingLogger;

  beforeEach(() => {
    storage = new Storage(':memory:');
    storage.upsertUser('u1', 'alice');
    const now = Math.floor(Date.now() / 1000);
    storage.recordVoiceLease({
      jti: 'lease-12345678-abcd', userId: 'u1', deviceId: 'dev_phone',
      resource: 'voice/doubao', quotaSeconds: 300,
      issuedAtUnixSec: now - 5, expiresAtUnixSec: now + 3600,
    });
    logs = captureLogs();
  });

  afterEach(() => {
    silenceLogs();
    storage.close();
  });

  function settle(body: Record<string, unknown>) {
    const raw = JSON.stringify(body);
    const result = handleVoiceSettlement(storage, 'secret', { authorization: 'Bearer secret', body: raw }, { dailyCapSec: 7200 });
    logVoiceSettlement(storage, raw, result);
    return result;
  }

  it('names the lease and device; no-change reports are debug; rejections warn', () => {
    settle({ action: 'activate', jti: 'lease-12345678-abcd', activationId: 'activation-1111', grants: true });
    settle({ action: 'settle', jti: 'lease-12345678-abcd', activationId: 'activation-1111', audioSeconds: 12, reason: 'checkpoint', grants: true });
    settle({ action: 'settle', jti: 'lease-12345678-abcd', activationId: 'activation-1111', audioSeconds: 12, reason: 'checkpoint', grants: true });
    settle({ action: 'settle', jti: 'lease-12345678-abcd', activationId: 'someone-else', audioSeconds: 20, reason: 'checkpoint' });

    const lines = logs.lines.map((l) => ({ level: l.level, msg: l.msg, ...l.data }));
    expect(lines).toEqual([
      { level: 'info', msg: 'Voice lease accounting updated', action: 'activate', jti: 'lease-12', activation: 'activati', deviceId: 'dev_phone', status: 'activated', quotaSeconds: 60 },
      { level: 'info', msg: 'Voice lease accounting updated', action: 'settle', jti: 'lease-12', activation: 'activati', deviceId: 'dev_phone', reason: 'checkpoint', status: 'updated', usedSeconds: 12, quotaSeconds: 72 },
      { level: 'debug', msg: 'Voice lease accounting updated', action: 'settle', jti: 'lease-12', activation: 'activati', deviceId: 'dev_phone', reason: 'checkpoint', status: 'unchanged', usedSeconds: 12, quotaSeconds: 72 },
      { level: 'warn', msg: 'Voice settlement rejected', httpStatus: 409, error: 'settlement_conflict', action: 'settle', jti: 'lease-12', activation: 'someone-', deviceId: 'dev_phone', reason: 'checkpoint' },
    ]);
  });
});
