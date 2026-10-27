/** The WebSocket auth handshake: token / challenge auth, pairing tokens, replacing an older connection. */

import { WebSocket } from 'ws';
import { metrics } from '../metrics.js';
import type { AuthMessage, AuthErrorCode, DeviceSummary } from '@kraki/protocol';
import { DEVICE_REPLACED_CLOSE_CODE } from '@kraki/protocol';
import { PULSE_ACK_EVERY_BYTES } from '../pulse-hub.js';
import { authLogField, getLogger } from '../logger.js';
import { trace } from '../trace.js';
import type { AuthBackend, AuthOutcome, AuthResult } from '../auth-backend.js';
import type { HeadServer } from '../server.js';
import { RemoteAuthBackend } from '../remote-auth-backend.js';
import { broadcastDeviceJoined, getDeviceSummaries } from './presence.js';
import { CHALLENGE_TTL_MS, HEAD_FEATURES, publicPreferences, type ClientState } from './shared.js';

export function sendAuthError(server: HeadServer, ws: WebSocket, code: AuthErrorCode, message: string, redirect?: string, deviceId?: string): void {
  metrics().authFailed(code);
  const state = server.clients.get(ws);
  const throttle = server.authFailureLog.take(state?.ip ?? 'unknown');
  if (throttle) {
    getLogger().info('Auth failed', {
      code,
      ip: authLogField(state?.ip),
      method: authLogField(state?.authMethod),
      deviceId: authLogField(deviceId ?? state?.deviceId ?? state?.authDeviceId),
      reason: authLogField(message),
      ...throttle,
    });
  }
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'auth_error', code, message, ...(redirect && { redirect }), ...(deviceId && { deviceId }) }));
  }
}

export async function handleAuth(server: HeadServer, ws: WebSocket, state: ClientState, msg: AuthMessage): Promise<void> {
  state.pulseProgressAck = msg.device?.pulseProgressAck === true;
  const logger = getLogger();
  const { auth } = msg;
  // One auth attempt per socket at a time: a second `auth` while the first
  // is awaiting its backend would register the device twice.
  if (state.authInFlight || state.pendingNonce) {
    // Ignored rather than answered with auth_error: clients treat auth
    // errors as credential failures, and this one is just a duplicate.
    logger.warn('Ignoring duplicate auth while one is in progress', { ip: authLogField(state.ip) });
    return;
  }
  state.authInFlight = true;
  state.authTiming = { startedAt: Date.now() };
  state.authMethod = auth.method;
  state.authDeviceId = auth.method === 'challenge' ? auth.deviceId : msg.device.deviceId;
  try {
    if (auth.method === 'challenge') {
      // Challenge is multi-step — start here, verify in handleChallengeResponse
      const challengeStart = performance.now();
      const result = await server.authBackend.startChallenge(
        auth.deviceId,
        msg.device.encryptionKey,
        server.options.region,
        msg.device.publicKey,
      );
      state.authTiming.challengeMs = Math.round(performance.now() - challengeStart);
      metrics().authStages.challenge.observe(state.authTiming.challengeMs);
      if (!socketStillAuthenticating(server, ws, state)) return;
      if (!result.ok) {
        sendAuthError(server, ws, result.code as AuthErrorCode, result.message,
          result.code === 'wrong_region' ? (result as { redirect?: string }).redirect : undefined);
        return;
      }
      state.pendingNonce = result.nonce;
      state.pendingNonceAt = Date.now();
      state.pendingDeviceId = result.deviceId;
      state.pendingDeviceInfo = { encryptionKey: msg.device.encryptionKey };
      state.pendingAuthMethod = 'challenge';
      logger.debug('Issuing auth challenge', { deviceId: authLogField(auth.deviceId) });
      ws.send(JSON.stringify({ type: 'auth_challenge', nonce: result.nonce }));
      state.authTiming.challengeSentAt = Date.now();
      return;
    }

    const renameClock = server.renameClock;
    const tokenStart = performance.now();
    const result = await server.authBackend.authenticate(auth, msg.device, server.options.region, state.ip, state.remoteClient);
    state.authTiming.tokenMs = Math.round(performance.now() - tokenStart);
    metrics().authStages.token.observe(state.authTiming.tokenMs);
    if (!socketStillAuthenticating(server, ws, state)) return;
    handleBackendAuthResult(server, ws, state, result, renameClock);
  } finally {
    state.authInFlight = false;
  }
}

/** After an awaited auth step: is this socket still open, still ours and
 *  still unauthenticated? The auth deadline may have closed it meanwhile;
 *  registering a dead socket would evict the device's live connection. */
export function socketStillAuthenticating(server: HeadServer, ws: WebSocket, state: ClientState): boolean {
  return ws.readyState === WebSocket.OPEN && server.clients.get(ws) === state && !state.authenticated;
}

export function handleChallengeResponse(server: HeadServer, ws: WebSocket, state: ClientState, msg: { deviceId: string; signature: string }): void {
  const logger = getLogger();
  const deviceId = state.pendingDeviceId;
  const nonce = state.pendingNonce;
  const pendingInfo = state.pendingDeviceInfo;
  const issuedAt = state.pendingNonceAt;

  state.pendingNonce = undefined;
  state.pendingNonceAt = undefined;
  state.pendingDeviceId = undefined;
  state.pendingDeviceInfo = undefined;

  if (!deviceId || !nonce) {
    sendAuthError(server, ws, 'no_pending_challenge', 'No pending challenge');
    return;
  }
  // A socket kept alive on the login screen must not answer an old
  // challenge. Retryable: the client signs in again with a fresh one.
  if (issuedAt !== undefined && Date.now() - issuedAt > CHALLENGE_TTL_MS) {
    sendAuthError(server, ws, 'service_unavailable', 'Challenge expired, sign in again');
    return;
  }

  state.authInFlight = true;
  const renameClock = server.renameClock;
  if (state.authTiming?.challengeSentAt) state.authTiming.signMs = Date.now() - state.authTiming.challengeSentAt;
  const verifyStart = performance.now();
  server.authBackend.verifyChallenge(
    deviceId, nonce, msg.signature,
    pendingInfo?.encryptionKey,
    server.options.region,
  ).then(result => {
    const verifyMs = Math.round(performance.now() - verifyStart);
    metrics().authStages.verify.observe(verifyMs);
    if (state.authTiming) state.authTiming.verifyMs = verifyMs;
    if (!socketStillAuthenticating(server, ws, state)) return;
    handleBackendAuthResult(server, ws, state, result, renameClock);
  }).catch(err => {
    // A thrown error means the auth backend itself was unreachable / timed
    // out (network, 5xx, abort) — NOT that the signature was invalid. A
    // deterministic auth failure comes back as a resolved AuthError outcome
    // above. Reporting this as auth_rejected made the arm treat a transient
    // backend outage as a permanent credential failure and wipe the paired
    // device, forcing a full re-pair. Surface it as auth_unavailable so the
    // client retries instead of destroying a valid session.
    logger.error('Auth backend verifyChallenge failed', { error: (err as Error).message });
    if (socketStillAuthenticating(server, ws, state)) {
      sendAuthError(server, ws, 'service_unavailable', 'Authentication service unavailable');
    }
  }).finally(() => {
    state.authInFlight = false;
  });
}

/**
 * Handle a result from AuthBackend — registers connection state and sends response.
 * Used for both initial auth and challenge-response verification.
 */
export function handleBackendAuthResult(
  server: HeadServer, ws: WebSocket, state: ClientState, result: AuthOutcome,
  /** `server.renameClock` when this auth started. */
  renameClockAtStart = server.renameClock,
): void {
  const logger = getLogger();

  if (!result.ok) {
    const redirect = result.code === 'wrong_region' ? (result as { redirect?: string }).redirect : undefined;
    const deviceId = result.code === 'wrong_region' ? (result as { deviceId?: string }).deviceId : undefined;
    sendAuthError(server, ws, result.code as AuthErrorCode, result.message, redirect, deviceId);
    return;
  }

  // An account deleted through this edge tombstones its devices: an
  // account-service answer that was already on its way must not bring one
  // back (e.g. a first pairing completing right after the deletion).
  if (server.storage.isDeletedDevice(result.deviceId)) {
    sendAuthError(server, ws, 'account_deleted', 'This Kraki account was deleted.');
    return;
  }
  // The account service now says this device id belongs to another account
  // (removed and registered again elsewhere). This edge's mirror and Pulse
  // state are the old account's: retire them before the new owner is
  // registered, or routing would still treat it as the old account's device.
  retireForeignMirror(server, result.deviceId, result.userId);

  // Register connection
  state.authenticated = true;
  state.authenticatedAt = Date.now();
  if (state.authTimer) { clearTimeout(state.authTimer); state.authTimer = undefined; }
  state.deviceId = result.deviceId;
  state.userId = result.userId;
  evictPreviousConnection(server, result.deviceId, ws);
  server.connections.set(result.deviceId, ws);
  server.userByDevice.set(result.deviceId, result.userId);
  trace('DEV-CONNECT', { device: result.deviceId, user: result.userId, auth: 'backend' });
  metrics().inc('auth.ok');

  const timing = state.authTiming;
  const totalMs = timing ? Date.now() - timing.startedAt : undefined;
  if (totalMs !== undefined) metrics().authStages.total.observe(totalMs);
  const summary = result.devices?.find((d) => d.id === result.deviceId);
  const device = summary ?? server.storage.getDevice(result.deviceId);
  logger.info('Device authenticated (via backend)', {
    deviceId: result.deviceId,
    ...(device && { role: device.role, ...(device.kind && { kind: device.kind }) }),
    user: result.user.login,
    method: result.authMethod,
    ip: state.ip,
    ...(result.local && { local: true }),
    // Where the auth time went: backend steps vs the client's signing round trip.
    ...(timing && { ms: { total: totalMs, challenge: timing.challengeMs, sign: timing.signMs, verify: timing.verifyMs, token: timing.tokenMs } }),
  });
  state.authTiming = undefined;

  // Accepted from this edge's own copy: the local mirror is already what the
  // account service said at the last remote sign-in; re-mirroring the
  // cached list could revert a rename made here since.
  if (!result.local) mirrorAuthResult(server, result, renameClockAtStart);

  completeAuthHandshake(server, ws, {
    deviceId: result.deviceId,
    userId: result.userId,
    user: result.local ? withMirroredInternal(server, result.user) : result.user,
    authMethod: result.authMethod,
    devices: result.local ? undefined : result.devices,
    githubClientId: result.githubClientId,
    vapidPublicKey: result.vapidPublicKey,
  });
}

/**
 * A local (cached) answer's preferences carry `internal` as it was at this
 * device's last remote sign-in, up to a day ago. The edge's own row holds the
 * flag mirrored from the account service's latest answer for any device of
 * the account (mirrorAuthResult): report that one.
 */
function withMirroredInternal(server: HeadServer, user: AuthResult['user']): AuthResult['user'] {
  if (!user.preferences || typeof user.preferences !== 'object') return user;
  const { internal: _cached, ...rest } = user.preferences;
  const internal = server.storage.getUser(user.id)?.preferences?.internal === true;
  return { ...user, preferences: internal ? { ...rest, internal: true } : rest };
}

/** Mirror the account service's `internal` flag onto the edge's user row
 *  (missing preferences = unknown, leave as is). */
export function mirrorInternalFlag(server: HeadServer, result: AuthResult): void {
  if (!result.ok || !result.user.preferences || typeof result.user.preferences !== 'object') return;
  server.storage.setInternal(result.user.id, result.user.preferences.internal === true);
}

/** See handleBackendAuthResult: a mirrored device now owned by another account. */
export function retireForeignMirror(server: HeadServer, deviceId: string, userId: string): void {
  const local = server.storage.getDevice(deviceId);
  if (!local || local.userId === userId) return;
  getLogger().warn('Device moved to another account; retiring the old mirror', { deviceId });
  const previous = server.connections.get(deviceId);
  if (previous) {
    // A socket still signed in as the old owner: close it outright.
    server.connections.delete(deviceId);
    server.userByDevice.delete(deviceId);
    server.clients.delete(previous);
    try { previous.terminate(); } catch { /* gone */ }
  }
  server.storage.deleteDevice(deviceId);
  server.storage.deletePushTokensForDevice(deviceId);
  server.pulseHub.forgetDevice(deviceId);
  server.deviceRenamedAt.delete(deviceId);
  if (server.authBackend instanceof RemoteAuthBackend) server.authBackend.forgetLocalTrustUnlessOwnedBy(deviceId, userId);
}

/**
 * Mirror user + devices into local storage so edge-local operations
 * (broadcastDeviceJoined, getDeviceSummaries, etc.) work even when auth is
 * delegated to a remote backend. May rewrite `result.devices` entries renamed
 * here after `renameClockAtStart`.
 */
export function mirrorAuthResult(server: HeadServer, result: AuthResult, renameClockAtStart: number): void {
  const logger = getLogger();
  try {
    server.storage.upsertUser(
      result.user.id, result.user.login, result.user.provider, result.user.email,
    );
    // The account service owns `internal` (dogfood account). An edge keeps
    // its own preferences row, which otherwise wins over the backend's in
    // completeAuthHandshake and in preferences_updated: mirror the flag so an
    // internal account is not dropped to stable builds by an edge, and a
    // revoked one does not stay on dogfood. Missing preferences = unknown.
    mirrorInternalFlag(server, result);
    for (const [i, d] of result.devices.entries()) {
      try {
        // The account service sends the name to show; when the user renamed
        // the device, `defaultName` is the device's own one. Mirror both, so
        // a rename (or clearing it) made on another edge shows here too.
        const renamed = typeof d.defaultName === 'string';
        server.storage.upsertDevice(
          d.id, result.userId, renamed ? d.defaultName! : d.name, d.role,
          d.kind ?? undefined, d.publicKey ?? undefined, d.encryptionKey ?? undefined,
        );
        // Renamed here after this auth started: the list predates that
        // rename, which this edge already stored at the account service and
        // applied. Keep (and report) the newer local name, never revert it.
        if ((server.deviceRenamedAt.get(d.id) ?? 0) > renameClockAtStart) {
          const local = server.storage.getDevice(d.id);
          if (local) {
            const { defaultName: _stale, ...rest } = d;
            result.devices[i] = { ...rest, name: local.name, ...(local.displayName != null && { defaultName: local.reportedName }) };
          }
          continue;
        }
        server.storage.setDeviceDisplayName(d.id, renamed ? d.name : null);
      } catch (err) {
        logger.warn('Failed to mirror device locally', { deviceId: d.id, error: (err as Error).message });
      }
    }
  } catch (err) {
    logger.warn('Failed to mirror user locally', { userId: result.userId, error: (err as Error).message });
  }
}

/**
 * Common post-auth completion logic, used by every auth path.
 *
 * Responsibilities:
 *  - Read user preferences from local storage and merge into the user object.
 *  - Flush any locally-queued pending messages for this device (offline-queue).
 *  - Build and send the `auth_ok` response.
 *  - Broadcast `device_joined` to the user's other connected devices.
 *
 * Each caller is responsible for path-specific work BEFORE calling this:
 * validating credentials, persisting user/device records, setting up
 * ClientState, populating `connections` / `userByDevice` maps, and logging
 * the path-specific "authenticated via X" line.
 *
 * Centralising the tail eliminates a class of bugs where new auth paths
 * (notably the multi-region delegated-backend path) silently diverge from
 * the established post-auth flow.
 */
export function completeAuthHandshake(
  server: HeadServer,
  ws: WebSocket,
  params: {
    /** The authenticated device's ID. */
    deviceId: string;
    /** The authenticated user's ID. */
    userId: string;
    /** Identity fields from the auth source (local DB or remote backend).
     *  `preferences` and `region` are optional and only meaningful from the
     *  delegated-backend path — local paths leave them undefined and the
     *  helper reads preferences from local storage instead. */
    user: {
      id: string;
      login: string;
      provider: string;
      email?: string;
      preferences?: Record<string, unknown>;
      region?: string;
    };
    /** Auth method, echoed back in auth_ok. */
    authMethod: string;
    /** Devices list to include in auth_ok. If omitted, derived from local storage.
     *  Edge mode supplies this from the remote backend's view. */
    devices?: DeviceSummary[];
    /** Override of the backend's GitHub client id (used when delegated). */
    githubClientId?: string;
    /** Override of `getVapidPublicKey()` (used when delegated). */
    vapidPublicKey?: string;
  },
): void {
  // Merge preferences. Local storage takes precedence (it captures per-edge
  // overrides the backend might not know about), but fall back to the
  // backend-supplied preferences if local has none — e.g. on a user's very
  // first auth to this edge, before upsertUser has been called or when the
  // backend is the canonical source of truth.
  //
  // Why this matters: storage.upsertUser only writes username/provider/email,
  // NOT preferences. So a brand-new user record reads back with
  // preferences=undefined. Without this fallback, backend preferences would
  // be silently dropped at every first auth.
  //
  // Merged per key (local wins), so a local row holding only the mirrored
  // `internal` flag does not hide the backend's other preferences. `internal`
  // itself always comes from the backend when it answered with preferences:
  // the account service owns it.
  const fullUser = server.storage.getUser(params.userId);
  const backendPrefs = params.user.preferences;
  const localPrefs = fullUser?.preferences;
  let preferences = localPrefs || backendPrefs ? { ...(backendPrefs ?? {}), ...(localPrefs ?? {}) } : undefined;
  if (preferences && backendPrefs) {
    const { internal: _local, ...rest } = preferences;
    preferences = backendPrefs.internal === true ? { ...rest, internal: true } : rest;
  }
  const userResponse = {
    ...params.user,
    preferences: publicPreferences(preferences),
  };

  // Devices list. If the caller provided one (edge mode), recompute online
  // status against our current connections map. Otherwise derive locally.
  const devices = params.devices
    ? params.devices.map(d => ({ ...d, online: server.connections.has(d.id) }))
    : getDeviceSummaries(server, params.userId);
  const deviceRole = devices.find((device) => device.id === params.deviceId)?.role
    ?? server.storage.getDevice(params.deviceId)?.role;

  ws.send(JSON.stringify({
    type: 'auth_ok',
    deviceId: params.deviceId,
    authMethod: params.authMethod,
    user: userResponse,
    devices,
    githubClientId: params.githubClientId ?? server.authBackend.getAuthInfo().githubClientId,
    vapidPublicKey: params.vapidPublicKey ?? server.getVapidPublicKey(),
    relayVersion: server.options.version,
    pulseAckBytes: PULSE_ACK_EVERY_BYTES,
    features: HEAD_FEATURES,
    // Apps only: a tentacle has no use for the user's word list.
    ...(deviceRole === 'app' && { voiceVocabulary: server.storage.getVoiceVocabulary(params.userId) }),
    ...(server.getVoiceCapability() && { voice: server.getVoiceCapability() }),
  }));

  // Clients only accept Pulse envelopes after processing auth_ok. Starting
  // the endpoint before auth_ok loses the initial hello, leaving peerEpoch
  // empty and making a later relay restart indistinguishable from the first
  // connection. That stale recvCursor then drops the restarted seq=1..N as
  // duplicates. Keep this ordering centralized for every auth path.
  //
  // Apps have explicit reconnect authorities (fresh session_list,
  // subscription snapshot, and history ranges). If their HELLO carries a new
  // process epoch, fence the preceding process's non-durable downlink so the
  // new UI cannot animate through old live events. Tentacle downlinks carry
  // commands and retain ordinary Pulse resume semantics across process epochs.
  server.pulseHub.onDeviceConnected(params.deviceId, {
    discardPreviousProcessNonDurable: deviceRole === 'app',
  });
  broadcastDeviceJoined(server, params.userId, params.deviceId);
}

/**
 * A device is about to register `ws` as its connection. If the SAME device id
 * already had a socket, that older socket is now orphaned: once we overwrite
 * the map entry its close handler hits the reconnect-guard and skips cleanup,
 * and the ping timer (which only walks `connections`) never visits it again.
 * It would sit in `clients` holding its ClientState until TCP finally gives
 * up. Retire both the WebSocket and its Pulse link explicitly before the new
 * connection is installed.
 *
 * Must be called BEFORE `connections.set(deviceId, ws)`.
 */
export function evictPreviousConnection(server: HeadServer, deviceId: string, ws: WebSocket): void {
  const previous = server.connections.get(deviceId);
  if (!previous || previous === ws) return;
  getLogger().info('Replacing existing connection for device', { deviceId });
  // The old close callback will see the replacement in `connections` and skip
  // its guarded cleanup. Publish the Pulse disconnect here so capability and
  // connection-scoped state cannot leak across the replacement boundary.
  server.pulseHub.onDeviceDisconnected(deviceId);
  const previousState = server.clients.get(previous);
  if (previousState) previousState.evicted = true;
  server.clients.delete(previous);
  // Say why (a bare terminate() reads as a network drop, and a client that
  // reconnects on it evicts this new connection in turn). Force the TCP
  // teardown shortly after in case the old peer never completes the close.
  try { previous.close(DEVICE_REPLACED_CLOSE_CODE, 'replaced'); } catch { /* best effort */ }
  const force = setTimeout(() => { try { previous.terminate(); } catch { /* already gone */ } }, 2_000);
  force.unref?.();
  previous.once('close', () => clearTimeout(force));
}

export async function handleCreatePairingToken(server: HeadServer, ws: WebSocket, state: ClientState): Promise<void> {
  const logger = getLogger();
  if (!(server.options.pairingEnabled ?? true)) {
    server.sendError(ws, 'Pairing is disabled on this relay');
    return;
  }
  if (!state.userId) {
    server.sendError(ws, 'Not authenticated');
    return;
  }
  try {
    // A remote (edge) backend creates tokens on the account service.
    const backend = server.authBackend as AuthBackend & {
      createPairingTokenAsync?: (userId: string) => Promise<{ token: string; expiresIn: number }>;
    };
    const result = backend.createPairingTokenAsync
      ? await backend.createPairingTokenAsync(state.userId)
      : backend.createPairingToken(state.userId);
    if (!result?.token) throw new Error('no token returned');
    logger.info('Pairing token created', { userId: state.userId });
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'pairing_token_created', token: result.token, expiresIn: result.expiresIn }));
    }
  } catch (err) {
    logger.warn('Pairing token creation failed', { userId: state.userId, error: (err as Error).message });
    server.sendError(ws, 'Pairing is temporarily unavailable');
  }
}

export async function handleRequestPairingToken(server: HeadServer, ws: WebSocket, state: ClientState, msg: { token?: string }): Promise<void> {
  const logger = getLogger();
  if (!(server.options.pairingEnabled ?? true)) {
    server.sendError(ws, 'Pairing is disabled on this relay');
    return;
  }
  if (!msg.token) {
    server.sendError(ws, 'Token required for pairing request');
    return;
  }
  const result = await server.authBackend.requestPairingToken(msg.token, state.ip, state.remoteClient);
  if (ws.readyState !== WebSocket.OPEN) return;
  if (!result.ok) {
    sendAuthError(server, ws, result.code as AuthErrorCode, result.message);
    return;
  }
  logger.info('Pairing token created (one-shot)', { userId: result.userId });
  ws.send(JSON.stringify({
    type: 'pairing_token_created',
    token: result.pairingToken,
    expiresIn: result.expiresIn,
  }));
}
