import { safeEqual } from './auth.js';
import type { Storage } from './storage.js';
import { getLogger } from './logger.js';

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

/**
 * One line per settlement request: which lease (jti / activation prefixes,
 * device) and what happened. Routine no-change reports are debug; every
 * rejection is a warning (log audit 2026-10-22: they were not logged at all).
 */
export function logVoiceSettlement(storage: Storage, rawBody: string, response: VoiceSettlementResponse): void {
  const logger = getLogger();
  const request = settlementRequestForLog(rawBody);
  let deviceId: string | undefined;
  if (request) {
    try { deviceId = storage.getVoiceLease(request.jti)?.deviceId; } catch { /* storage may be closed */ }
  }
  const lease = request && {
    action: request.action,
    jti: request.jti.slice(0, 8),
    activation: request.activationId.slice(0, 8),
    ...(deviceId && { deviceId }),
    ...(request.reason && { reason: request.reason }),
  };
  if (response.status !== 200) {
    logger.warn('Voice settlement rejected', { httpStatus: response.status, error: response.body.error, ...lease });
    return;
  }
  const body = response.body;
  const status = (body.activationStatus ?? body.settlementStatus) as string | undefined;
  const fields = {
    ...lease,
    status,
    ...(body.usedSeconds !== undefined && { usedSeconds: body.usedSeconds }),
    ...(body.quotaSeconds !== undefined && { quotaSeconds: body.quotaSeconds }),
  };
  if (request?.action === 'settle' && status !== 'updated') logger.debug('Voice lease accounting updated', fields);
  else logger.info('Voice lease accounting updated', fields);
}

function settlementRequestForLog(rawBody: string): { action: string; jti: string; activationId: string; reason?: string } | undefined {
  try {
    const input = JSON.parse(rawBody) as Record<string, unknown>;
    if (typeof input?.action !== 'string' || typeof input.jti !== 'string' || typeof input.activationId !== 'string') return undefined;
    return {
      action: input.action.slice(0, 16),
      jti: input.jti,
      activationId: input.activationId,
      ...(typeof input.reason === 'string' && { reason: input.reason.slice(0, 64) }),
    };
  } catch {
    return undefined;
  }
}
