import { safeEqual } from './auth.js';
import type { Storage } from './storage.js';

export interface VoiceSettlementRequest {
  authorization?: string;
  body: string;
}

export interface VoiceSettlementResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface VoiceSettlementOptions {
  /** Per-user daily voice cap; activations and usage reports are granted against it. */
  dailyCapSec?: number;
}

export function handleVoiceSettlement(
  storage: Storage,
  settlementKey: string,
  request: VoiceSettlementRequest,
  options: VoiceSettlementOptions = {},
): VoiceSettlementResponse {
  const token = request.authorization?.startsWith('Bearer ')
    ? request.authorization.slice(7)
    : '';
  if (!token || !settlementKey || !safeEqual(token, settlementKey)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  let input: {
    action?: unknown;
    jti?: unknown;
    activationId?: unknown;
    audioSeconds?: unknown;
    reason?: unknown;
    /** The broker renews allowances through usage-report replies. */
    grants?: unknown;
  };
  try {
    input = JSON.parse(request.body) as typeof input;
  } catch {
    return { status: 400, body: { error: 'invalid_json' } };
  }
  if ((input.action !== 'activate' && input.action !== 'settle')
      || typeof input.jti !== 'string' || input.jti.length < 8 || input.jti.length > 128
      || typeof input.activationId !== 'string'
      || input.activationId.length < 8 || input.activationId.length > 128) {
    return { status: 400, body: { error: 'invalid_request' } };
  }

  if (input.action === 'activate') {
    const result = storage.activateVoiceLease({
      jti: input.jti,
      activationId: input.activationId,
      dailyCapSec: options.dailyCapSec,
      grants: input.grants === true,
    });
    if (result.status === 'not_found') return { status: 404, body: { error: 'not_found' } };
    if (result.status === 'expired') return { status: 409, body: { error: 'lease_expired' } };
    if (result.status === 'revoked') return { status: 409, body: { error: 'lease_revoked' } };
    if (result.status === 'quota_exhausted') return { status: 409, body: { error: 'quota_exhausted' } };
    if (result.status === 'grants_required') {
      return { status: 409, body: { error: 'broker_upgrade_required' } };
    }
    return {
      status: 200,
      body: {
        ok: true,
        activationStatus: result.status,
        reportedAudioSeconds: result.reportedAudioSeconds ?? 0,
        quotaSeconds: result.quotaSeconds,
      },
    };
  }

  if (typeof input.audioSeconds !== 'number' || !Number.isFinite(input.audioSeconds)
      || input.audioSeconds < 0) {
    return { status: 400, body: { error: 'invalid_request' } };
  }

  const result = storage.settleVoiceLease({
    jti: input.jti,
    activationId: input.activationId,
    audioSeconds: input.audioSeconds,
    reason: typeof input.reason === 'string' ? input.reason : undefined,
    dailyCapSec: options.dailyCapSec,
    grants: input.grants === true,
  });
  if (result.status === 'not_found') {
    return { status: 404, body: { error: 'not_found' } };
  }
  if (result.status === 'not_activated') {
    return { status: 409, body: { error: 'not_activated' } };
  }
  if (result.status === 'conflict') {
    return { status: 409, body: { error: 'settlement_conflict' } };
  }
  return {
    status: 200,
    body: {
      ok: true,
      usedSeconds: result.usedSeconds,
      reportedAudioSeconds: result.reportedAudioSeconds,
      settlementStatus: result.status,
      ...(result.quotaSeconds !== undefined ? { quotaSeconds: result.quotaSeconds } : {}),
    },
  };
}
