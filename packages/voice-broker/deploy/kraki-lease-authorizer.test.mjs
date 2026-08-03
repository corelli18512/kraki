import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import test from 'node:test';
import {
  canonicalLeasePayload,
  createKrakiLeaseAuthorizer,
  createKrakiOrLegacyAuthorizer,
  createKrakiSettlementClient,
  createKrakiUsageReporter,
} from './kraki-lease-authorizer.mjs';

const NOW = 1_800_000_000;
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function signedLease(overrides = {}) {
  const payload = {
    ver: 1,
    iss: 'kraki-head',
    sub: 'user-1',
    did: 'device-1',
    iat: NOW - 5,
    exp: NOW + 300,
    quota_seconds: 300,
    resource: 'voice/doubao',
    jti: 'lease-1',
    ...overrides,
  };
  const signer = createSign('SHA256');
  signer.update(canonicalLeasePayload(payload));
  return {
    payload,
    signature: signer.sign(keys.privateKey, 'base64'),
    alg: 'RSA-SHA256',
  };
}

function authorize(lease = signedLease(), start = {}) {
  return createKrakiLeaseAuthorizer(keys.publicKey, { now: () => NOW })({
    start: {
      type: 'start',
      uid: 'user-1',
      deviceId: 'device-1',
      lease,
      ...start,
    },
  });
}

test('accepts a Head-compatible signed lease and returns its audio quota', () => {
  const result = authorize();
  assert.equal(result.ok, true);
  assert.equal(result.quotaSeconds, 300);
  assert.equal(result.usageContext.jti, 'lease-1');
  assert.equal(typeof result.usageContext.activationId, 'string');
  assert.ok(result.usageContext.activationId.length > 8);
});

test('rejects a lease whose signed payload was tampered', () => {
  const lease = signedLease();
  lease.payload.quota_seconds = 7200;
  assert.equal(authorize(lease).reason, 'bad_signature');
});

test('rejects wrong user, device, resource and time window', () => {
  assert.equal(authorize(signedLease(), { uid: 'other' }).reason, 'wrong_user');
  assert.equal(authorize(signedLease(), { deviceId: 'other' }).reason, 'wrong_device');
  assert.equal(authorize(signedLease({ resource: 'voice/other' })).reason, 'malformed_lease');
  assert.equal(authorize(signedLease({ exp: NOW })).reason, 'expired');
  assert.equal(authorize(signedLease({ iat: NOW + 31 })).reason, 'not_yet_valid');
});

test('migration authorizer preserves legacy clients without allowing lease downgrade', () => {
  const mixed = createKrakiOrLegacyAuthorizer(keys.publicKey, 'legacy-secret', { now: () => NOW });
  assert.deepEqual(mixed({ start: { type: 'start', apiKey: 'legacy-secret' } }), { ok: true });
  assert.equal(mixed({ start: { type: 'start', apiKey: 'wrong' } }).reason, 'missing_authorization');
  const badLease = signedLease();
  badLease.payload.quota_seconds = 7200;
  assert.equal(mixed({
    start: {
      type: 'start', uid: 'user-1', deviceId: 'device-1',
      apiKey: 'legacy-secret', lease: badLease,
    },
  }).reason, 'bad_signature');
});

test('production activation precedes acceptance and settlement binds the activation id', async () => {
  const requests = [];
  const client = createKrakiSettlementClient('https://head/internal/voice/settle', 'secret', {
    wait: async () => {},
    fetch: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    },
  });
  const authorizer = createKrakiLeaseAuthorizer(keys.publicKey, {
    now: () => NOW,
    activate: client.activate,
  });
  const verdict = await authorizer({
    start: { type: 'start', uid: 'user-1', deviceId: 'device-1', lease: signedLease() },
  });
  assert.equal(verdict.ok, true);
  assert.equal(requests[0].body.action, 'activate');
  assert.equal(requests[0].body.jti, 'lease-1');
  assert.equal(requests[0].body.activationId, verdict.usageContext.activationId);

  await client.onUsage({ authorization: verdict, audioSeconds: 5.25, reason: 'asr closed' });
  assert.equal(requests[1].body.action, 'settle');
  assert.equal(requests[1].body.activationId, verdict.usageContext.activationId);
  assert.equal(requests[1].body.audioSeconds, 5.25);
});

test('usage reporter settles Kraki leases with retries and skips legacy sessions', async () => {
  const requests = [];
  let attempts = 0;
  const reporter = createKrakiUsageReporter('https://head/internal/voice/settle', 'secret', {
    wait: async () => {},
    fetch: async (url, init) => {
      attempts += 1;
      requests.push({ url, init });
      return { ok: attempts > 1, status: attempts > 1 ? 200 : 503 };
    },
  });
  await reporter({
    authorization: { usageContext: { jti: 'lease-1', activationId: 'activation-1' } },
    audioSeconds: 5.25,
    reason: 'asr closed',
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://head/internal/voice/settle');
  assert.equal(requests[0].init.headers.authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    action: 'settle', jti: 'lease-1', activationId: 'activation-1',
    audioSeconds: 5.25, reason: 'asr closed',
  });

  await reporter({ authorization: { ok: true }, audioSeconds: 10, reason: 'legacy' });
  assert.equal(requests.length, 2);
});

test('usage reporter rejects permanent settlement failures', async () => {
  let attempts = 0;
  const reporter = createKrakiUsageReporter('https://head/internal/voice/settle', 'secret', {
    wait: async () => {},
    fetch: async () => { attempts += 1; return { ok: false, status: 401 }; },
  });
  await assert.rejects(() => reporter({
    authorization: { usageContext: { jti: 'lease-1', activationId: 'activation-1' } },
    audioSeconds: 1,
    reason: 'done',
  }), /401/);
  assert.equal(attempts, 1);
});

test('rejects missing, zero-quota and unknown-algorithm leases', () => {
  const authorizer = createKrakiLeaseAuthorizer(keys.publicKey, { now: () => NOW });
  assert.equal(authorizer({ start: { type: 'start', uid: 'user-1', deviceId: 'device-1' } }).reason, 'malformed_lease');
  assert.equal(authorize(signedLease({ quota_seconds: 0 })).reason, 'malformed_lease');
  const lease = signedLease();
  lease.alg = 'none';
  assert.equal(authorize(lease).reason, 'malformed_lease');
});
