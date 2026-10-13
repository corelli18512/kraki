/** Voice leases: short-lived credentials for the voice service, within the daily quota. */

import { WebSocket } from 'ws';
import type { VoiceResource } from '@kraki/protocol';
import { getLogger } from '../logger.js';
import type { HeadServer } from '../server.js';
import { type ClientState, DEFAULT_VOICE_LEASE_TTL_SEC, DEFAULT_VOICE_DAILY_QUOTA_SEC, MIN_VOICE_LEASE_GRANT_SEC, VALID_VOICE_RESOURCES } from './shared.js';

export function handleRequestVoiceLease(
  server: HeadServer,
  ws: WebSocket,
  state: ClientState,
  msg: Record<string, unknown>,
): void {
  const logger = getLogger();
  const userId = state.userId;
  const deviceId = state.deviceId;
  if (!userId || !deviceId) {
    ws.send(JSON.stringify({
      type: 'voice_lease_denied',
      reason: 'invalid_request',
      detail: 'Not authenticated',
    }));
    return;
  }

  const issuer = server.options.leaseIssuer;
  if (!issuer) {
    server.sendControlToDevice(deviceId, {
      type: 'voice_lease_denied',
      reason: 'not_entitled',
      detail: 'Voice lease issuance is not enabled on this head',
    });
    return;
  }

  // Validate request shape.
  const requestedDeviceId = typeof msg.deviceId === 'string' ? msg.deviceId : undefined;
  const requestedResource = typeof msg.resource === 'string' ? (msg.resource as VoiceResource) : undefined;
  if (!requestedDeviceId || !requestedResource) {
    server.sendControlToDevice(deviceId, {
      type: 'voice_lease_denied',
      reason: 'invalid_request',
      detail: 'Missing deviceId or resource',
    });
    return;
  }

  // Lease may only be requested for the authenticated device — no proxying.
  if (requestedDeviceId !== deviceId) {
    server.sendControlToDevice(deviceId, {
      type: 'voice_lease_denied',
      reason: 'invalid_request',
      detail: 'deviceId does not match authenticated device',
    });
    return;
  }

  if (!VALID_VOICE_RESOURCES.has(requestedResource)) {
    server.sendControlToDevice(deviceId, {
      type: 'voice_lease_denied',
      reason: 'invalid_request',
      detail: `Unknown resource: ${String(requestedResource)}`,
    });
    return;
  }

  // A lease is a long-lived credential for this device; the audio budget
  // is granted incrementally by usage reports, charged to the UTC day the
  // audio is used. So issuance only checks that anything is left today.
  const nowSec = Math.floor(Date.now() / 1000);
  const dailyCap = server.options.voiceDailyQuotaSec ?? DEFAULT_VOICE_DAILY_QUOTA_SEC;
  server.storage.revokePendingVoiceLeases(userId, deviceId, requestedResource, nowSec);
  const accountedToday = server.storage.voiceSecondsAccountedToday(userId, nowSec);
  if (dailyCap - accountedToday < MIN_VOICE_LEASE_GRANT_SEC) {
    logger.info('Voice lease denied: daily quota exhausted', {
      userId, deviceId, accountedToday, dailyCap,
    });
    server.sendControlToDevice(deviceId, {
      type: 'voice_lease_denied',
      reason: 'quota_exhausted',
      detail: `Daily quota reached (${accountedToday}/${dailyCap}s)`,
    });
    return;
  }
  const ttl = server.options.voiceLeaseTtlSec ?? DEFAULT_VOICE_LEASE_TTL_SEC;
  // Signed ceiling for one lease: all the UTC days it can span. The real
  // limit is the daily grant Head hands out on each usage report.
  const grant = dailyCap * (Math.ceil(ttl / 86_400) + 1);

  const lease = issuer.issue({
    userId,
    deviceId,
    quotaSeconds: grant,
    ttlSeconds: ttl,
    resource: requestedResource,
    nowUnixSec: nowSec,
  });

  try {
    server.storage.recordVoiceLease({
      jti: lease.payload.jti,
      userId,
      deviceId,
      resource: requestedResource,
      quotaSeconds: grant,
      issuedAtUnixSec: lease.payload.iat,
      expiresAtUnixSec: lease.payload.exp,
    });
  } catch (err) {
    logger.error('Voice lease persist failed', {
      userId, deviceId, jti: lease.payload.jti, error: (err as Error).message,
    });
    server.sendControlToDevice(deviceId, {
      type: 'voice_lease_denied',
      reason: 'invalid_request',
      detail: 'Lease persistence failed',
    });
    return;
  }

  logger.info('Voice lease issued', {
    userId, deviceId, jti: lease.payload.jti,
    quotaSeconds: grant, ttlSec: ttl, accountedToday, dailyCap,
  });
  server.sendControlToDevice(deviceId, { type: 'voice_lease_grant', lease });
}
