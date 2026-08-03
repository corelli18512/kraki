import { createVerify, randomUUID, timingSafeEqual } from 'node:crypto';

const RESOURCE = 'voice/doubao';

export function canonicalLeasePayload(payload) {
  const sorted = {};
  for (const key of Object.keys(payload).sort()) sorted[key] = payload[key];
  return JSON.stringify(sorted);
}

function validLeaseShape(value) {
  if (!value || typeof value !== 'object') return false;
  const lease = value;
  const payload = lease.payload;
  return lease.alg === 'RSA-SHA256' &&
    typeof lease.signature === 'string' && lease.signature.length > 0 &&
    payload && typeof payload === 'object' &&
    payload.ver === 1 && payload.iss === 'kraki-head' &&
    typeof payload.sub === 'string' && payload.sub.length > 0 &&
    typeof payload.did === 'string' && payload.did.length > 0 &&
    Number.isInteger(payload.iat) && Number.isInteger(payload.exp) &&
    Number.isFinite(payload.quota_seconds) && payload.quota_seconds > 0 &&
    payload.resource === RESOURCE &&
    typeof payload.jti === 'string' && payload.jti.length > 0;
}

export function createKrakiLeaseAuthorizer(publicKeyPem, options = {}) {
  if (!publicKeyPem?.trim()) throw new Error('Kraki lease public key must not be empty');
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const clockSkewSec = options.clockSkewSec ?? 30;
  const activate = options.activate;
  return ({ start }) => {
    const lease = start?.lease;
    if (!validLeaseShape(lease)) {
      return { ok: false, reason: 'malformed_lease', detail: 'missing or malformed Kraki lease' };
    }
    if (typeof start.deviceId !== 'string' || start.deviceId !== lease.payload.did) {
      return { ok: false, reason: 'wrong_device', detail: 'lease does not match device' };
    }
    if (typeof start.uid !== 'string' || start.uid !== lease.payload.sub) {
      return { ok: false, reason: 'wrong_user', detail: 'lease does not match user' };
    }
    const current = now();
    if (lease.payload.iat > current + clockSkewSec) {
      return { ok: false, reason: 'not_yet_valid', detail: 'lease is not active yet' };
    }
    if (lease.payload.exp <= current) {
      return { ok: false, reason: 'expired', detail: 'lease expired' };
    }
    try {
      const verifier = createVerify('SHA256');
      verifier.update(canonicalLeasePayload(lease.payload));
      if (!verifier.verify(publicKeyPem, lease.signature, 'base64')) {
        return { ok: false, reason: 'bad_signature', detail: 'lease signature invalid' };
      }
    } catch {
      return { ok: false, reason: 'bad_signature', detail: 'lease signature invalid' };
    }
    const activationId = randomUUID();
    const success = () => ({
      ok: true,
      quotaSeconds: lease.payload.quota_seconds,
      usageContext: { jti: lease.payload.jti, activationId },
    });
    if (activate) {
      return Promise.resolve(activate({ jti: lease.payload.jti, activationId }))
        .then((activated) => activated.ok
          ? success()
          : { ok: false, reason: activated.reason ?? 'activation_failed', detail: activated.detail });
    }
    return success();
  };
}

export function createKrakiSettlementClient(settleUrl, settlementKey, options = {}) {
  if (!settleUrl?.trim()) throw new Error('Kraki settlement URL must not be empty');
  if (!settlementKey?.trim()) throw new Error('Kraki settlement key must not be empty');
  const request = options.fetch ?? globalThis.fetch;
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Kraki settlement timeout must be a positive number');
  }
  const post = async (payload) => {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await request(settleUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${settlementKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) return { ok: true };
        lastError = new Error(`settlement returned ${response.status}`);
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return { ok: false, reason: 'settlement_rejected', detail: lastError.message };
        }
      } catch (error) {
        lastError = error;
      }
      await wait(100 * 2 ** attempt);
    }
    throw lastError ?? new Error('voice settlement failed');
  };
  return {
    activate: ({ jti, activationId }) => post({ action: 'activate', jti, activationId }),
    async onUsage(input) {
      const jti = input?.authorization?.usageContext?.jti;
      const activationId = input?.authorization?.usageContext?.activationId;
      if (typeof jti !== 'string' || jti.length === 0
          || typeof activationId !== 'string' || activationId.length === 0) return;
      const result = await post({
        action: 'settle',
        jti,
        activationId,
        audioSeconds: input.audioSeconds,
        reason: input.reason,
      });
      if (!result.ok) throw new Error(result.detail ?? result.reason ?? 'voice settlement failed');
    },
  };
}

export function createKrakiUsageReporter(settleUrl, settlementKey, options = {}) {
  return createKrakiSettlementClient(settleUrl, settlementKey, options).onUsage;
}

function safeEqualSecret(actual, expected) {
  if (typeof actual !== 'string' || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Migration authorizer: Kraki lease frames never fall back to the legacy key;
 * frames without a lease may still serve existing VoiceType clients.
 */
export function createKrakiOrLegacyAuthorizer(publicKeyPem, legacyApiKey, options = {}) {
  const authorizeLease = createKrakiLeaseAuthorizer(publicKeyPem, options);
  return (input) => {
    if (input?.start?.lease !== undefined) return authorizeLease(input);
    return safeEqualSecret(input?.start?.apiKey, legacyApiKey)
      ? { ok: true }
      : { ok: false, reason: 'missing_authorization', detail: 'missing Kraki lease or legacy API key' };
  };
}
