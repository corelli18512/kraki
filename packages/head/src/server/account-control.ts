/** Account control messages: preferences, Custom Words, push tokens and previews, renaming and removing devices, deleting the account. */

import { RemoteAuthBackend } from '../remote-auth-backend.js';
import { WebSocket } from 'ws';
import type { BlobPayload } from '@kraki/protocol';
import { ACCOUNT_DELETED_CLOSE_CODE, normalizeDeviceName } from '@kraki/protocol';
import { parseVoiceWordOps, type VoiceWord } from '../voice-vocabulary.js';
import { getLogger } from '../logger.js';
import { parseWebPushSubscription } from '../push/web-push.js';
import { trace } from '../trace.js';
import type { HeadServer } from '../server.js';
import { broadcastDeviceRemoved, broadcastDeviceRenamed } from './presence.js';
import { publicPreferences, type ClientState } from './shared.js';

/** The relay-terminated control ops, callable from BOTH the raw-WS dispatch
 *  (onMessage) and the pulse deliver-to-self path. Returns true if handled. */
export function handleControlMessage(server: HeadServer, ws: WebSocket, state: ClientState, msg: Record<string, unknown>): boolean {
  switch (msg.type) {
    case 'update_preferences':    handleUpdatePreferences(server, ws, state, msg); return true;
    case 'update_voice_vocabulary': handleUpdateVoiceVocabulary(server, state, msg); return true;
    case 'remove_device':         handleRemoveDevice(server, ws, state, msg.deviceId as string); return true;
    case 'rename_device':         void handleRenameDevice(server, ws, state, msg); return true;
    case 'delete_account':        void handleDeleteAccount(server, ws, state); return true;
    case 'register_push_token':   handleRegisterPushToken(server, ws, state, msg); return true;
    case 'unregister_push_token': handleUnregisterPushToken(server, ws, state, msg); return true;
    case 'dispatch_push': {
      const sender = state.deviceId ? server.storage.getDevice(state.deviceId) : undefined;
      const payload = msg.payload as { preview?: BlobPayload } | undefined;
      if (sender?.role !== 'tentacle' || !payload?.preview) return true;
      firePushPreview(server, state, payload.preview);
      return true;
    }
    default: return false;
  }
}

/** Persist a preferences update and echo the merged result to the sender + the
 *  user's other online devices. */
export function handleUpdatePreferences(server: HeadServer, ws: WebSocket, state: ClientState, msg: Record<string, unknown>): void {
  if (!state.userId) return;
  const prefs = msg.preferences as Record<string, unknown> | undefined;
  if (!prefs || typeof prefs !== 'object') return;
  server.storage.updatePreferences(state.userId, prefs);
  // Read back the full merged preferences
  const fullUser = server.storage.getUser(state.userId);
  const merged = publicPreferences(fullUser?.preferences ?? prefs);
  const confirmation = { type: 'preferences_updated', preferences: merged };
  // Confirm to the sender + fan out to the user's other devices — all over pulse.
  if (state.deviceId) server.sendControlToDevice(state.deviceId, confirmation);
  const userDevices = (() => {
    try { return server.storage.getDevicesByUser(state.userId!); } catch { return []; }
  })();
  for (const d of userDevices) {
    if (d.id === state.deviceId) continue;
    const other = server.connections.get(d.id);
    if (!other || other.readyState !== WebSocket.OPEN) continue;
    server.sendControlToDevice(d.id, confirmation);
  }
}

/** Account data, not session data: no tentacle is involved. The sender
 *  always gets the resulting list back (its acknowledgement); other online
 *  apps of the account get it only when something was applied. */
export function handleUpdateVoiceVocabulary(server: HeadServer, state: ClientState, msg: Record<string, unknown>): void {
  if (!state.userId || !state.deviceId) return;
  const requestId = typeof msg.requestId === 'string' ? msg.requestId.slice(0, 64) : undefined;
  const ops = parseVoiceWordOps(msg.ops);
  let words: VoiceWord[];
  try {
    words = ops?.length
      ? server.storage.updateVoiceVocabulary(state.userId, ops)
      : server.storage.getVoiceVocabulary(state.userId);
  } catch (err) {
    // Pulse self-delivery has no outer try/catch. No reply: the client keeps
    // the ops in its outbox and retries.
    getLogger().warn('Voice vocabulary update failed', { error: (err as Error).message });
    return;
  }
  server.sendControlToDevice(state.deviceId, { type: 'voice_vocabulary_updated', requestId, words });
  if (!ops?.length) return;
  for (const d of server.storage.getDevicesByUser(state.userId)) {
    if (d.id !== state.deviceId && d.role === 'app' && server.connections.get(d.id)?.readyState === WebSocket.OPEN) {
      server.sendControlToDevice(d.id, { type: 'voice_vocabulary_updated', words });
    }
  }
}

/** Notify offline devices from a pushPreview side-channel. The preview rides the
 *  same pulse broadcast envelope as the reliable message. */
export function firePushPreview(server: HeadServer, state: ClientState, pushPreview: BlobPayload | undefined): void {
  const senderUserId = state.userId;
  const senderDeviceId = state.deviceId;
  if (!senderUserId || !senderDeviceId || !pushPreview) {
    trace('PUSH-SKIP', { reason: !senderUserId ? 'no-user' : !senderDeviceId ? 'no-device' : 'no-preview' });
    return;
  }
  // Online native clients that post their own notifications (macOS) get the
  // same encrypted preview over their live connection.
  for (const token of server.storage.getPushTokensForOfflineDevices(senderUserId, [])) {
    if (token.provider !== 'local' || token.deviceId === senderDeviceId) continue;
    if (!server.connections.has(token.deviceId)) continue;
    const key = pushPreview.keys[token.deviceId];
    if (!key) continue;
    server.sendControlToDevice(token.deviceId, { type: 'notification_preview', payload: { blob: pushPreview.blob, key } });
    trace('PUSH-LOCAL', { deviceId: token.deviceId });
  }
  if (!server.options.pushManager) {
    trace('PUSH-SKIP', { reason: 'no-pushmgr' });
    return;
  }
  const onlineDeviceIds: string[] = [senderDeviceId];
  let offlineCount = 0;
  for (const device of server.storage.getDevicesByUser(senderUserId)) {
    if (device.id === senderDeviceId) continue;
    if (server.connections.get(device.id)) onlineDeviceIds.push(device.id);
    else offlineCount++;
  }
  trace('PUSH-FIRE', { sender: senderDeviceId, onlineCount: onlineDeviceIds.length, offlineCount, previewKeys: Object.keys(pushPreview.keys) });
  server.options.pushManager.sendToOfflineDevices(senderUserId, onlineDeviceIds, pushPreview)
    .catch(err => getLogger().warn('Push notification send failed', { error: (err as Error).message }));
}

/**
 * Give a device of the account a custom name (empty clears it). Any app may
 * rename any device of its account, online or not. In edge mode the account
 * service owns the device list and every auth re-mirrors it, so the rename is
 * stored there first; only then is it applied here and broadcast.
 */
export async function handleRenameDevice(server: HeadServer, ws: WebSocket, state: ClientState, msg: Record<string, unknown>): Promise<void> {
  const logger = getLogger();
  if (!state.userId || !state.deviceId) {
    server.sendError(ws, 'Not authenticated');
    return;
  }
  const userId = state.userId;
  if (server.storage.getDevice(state.deviceId)?.role !== 'app') {
    server.sendError(ws, 'Only apps can rename devices');
    return;
  }
  const targetDeviceId = msg.deviceId;
  if (typeof targetDeviceId !== 'string' || !targetDeviceId || typeof msg.name !== 'string') {
    server.sendError(ws, 'Missing deviceId or name');
    return;
  }
  const name = normalizeDeviceName(msg.name);
  if (name === null) {
    server.sendError(ws, 'Device name is too long');
    return;
  }
  const target = server.storage.getDevice(targetDeviceId);
  if (!target || target.userId !== userId) {
    server.sendError(ws, 'Device not found');
    return;
  }
  const displayName = name || null;

  const remote = server.authBackend;
  if (remote instanceof RemoteAuthBackend) {
    let stored = false;
    try {
      stored = await remote.renameDevice(userId, targetDeviceId, displayName);
    } catch (err) {
      logger.warn('Failed to rename device at account service', { deviceId: targetDeviceId, error: (err as Error).message });
    }
    if (!stored) {
      server.sendError(ws, 'Could not rename the device. Try again later.');
      return;
    }
  }

  // The device may have been removed while the account service answered.
  if (!server.storage.setDeviceDisplayName(targetDeviceId, displayName)) return;
  server.deviceRenamedAt.set(targetDeviceId, ++server.renameClock);
  const renamed = server.storage.getDevice(targetDeviceId);
  if (!renamed) return;
  logger.info('Device renamed', { deviceId: targetDeviceId, byDevice: state.deviceId, custom: displayName !== null });
  broadcastDeviceRenamed(server, userId, renamed);
}

export function handleRemoveDevice(server: HeadServer, ws: WebSocket, state: ClientState, targetDeviceId: string): void {
  const logger = getLogger();
  if (!state.userId || !state.deviceId) {
    server.sendError(ws, 'Not authenticated');
    return;
  }

  if (!targetDeviceId || typeof targetDeviceId !== 'string') {
    server.sendError(ws, 'Missing deviceId');
    return;
  }

  const targetDevice = server.storage.getDevice(targetDeviceId);
  if (!targetDevice || targetDevice.userId !== state.userId) {
    server.sendError(ws, 'Device not found');
    return;
  }

  // Only allow removing offline devices (zombie cleanup)
  if (server.connections.has(targetDeviceId)) {
    server.sendError(ws, 'Cannot remove an online device');
    return;
  }

  server.storage.deleteDevice(targetDeviceId);
  server.deviceRenamedAt.delete(targetDeviceId);
  server.storage.deletePushTokensForDevice(targetDeviceId);
  // Drop the device's pulse endpoint + persisted outbox/snapshot/capability
  // rows too. Otherwise they outlive the device record forever, and
  // recoverOnBoot faithfully rebuilds an endpoint for a device that can
  // never authenticate again.
  server.pulseHub.forgetDevice(targetDeviceId);
  logger.info('Device removed', { deviceId: targetDeviceId, byDevice: state.deviceId });

  // Edge mode: the account service owns the device list and every auth
  // mirrors it back here, so the removal must reach it too (otherwise the
  // device reappears after the next reconnect).
  const remote = server.authBackend;
  if (remote instanceof RemoteAuthBackend) {
    const userId = state.userId;
    remote.removeDevice(userId, targetDeviceId).then((ok) => {
      if (!ok) logger.warn('Account service did not remove device', { deviceId: targetDeviceId });
    }).catch((err) => {
      logger.warn('Failed to remove device at account service', { deviceId: targetDeviceId, error: (err as Error).message });
    });
  }

  // Broadcast removal to all remaining user devices
  broadcastDeviceRemoved(server, state.userId, targetDeviceId);
}

/**
 * Delete the requesting user's account: at the account store (the account
 * service in edge mode) and in this relay's own storage and pulse state.
 * Then tell every connected device and close it. Devices that were offline
 * get `auth_error` code `account_deleted` when they next connect.
 */
export async function handleDeleteAccount(server: HeadServer, ws: WebSocket, state: ClientState): Promise<void> {
  const logger = getLogger();
  const userId = state.userId;
  const deviceId = state.deviceId;
  if (!userId || !deviceId) {
    server.sendError(ws, 'Not authenticated');
    return;
  }
  if (server.storage.getDevice(deviceId)?.role !== 'app') {
    server.sendError(ws, 'Only the Kraki app can delete the account');
    return;
  }
  if (server.deletingAccounts.has(userId)) return;
  server.deletingAccounts.add(userId);
  try {
    const deviceIds = new Set(server.storage.getDevicesByUser(userId).map((d) => d.id));
    if (server.authBackend.deleteAccount) {
      for (const id of await server.authBackend.deleteAccount(userId)) deviceIds.add(id);
    }
    // This relay's own rows (the edge mirror; already gone when the
    // account store is this relay's storage).
    for (const id of server.storage.deleteUser(userId)) deviceIds.add(id);
    logger.info('Account deleted', { userId, devices: deviceIds.size, byDevice: deviceId });

    for (const id of deviceIds) {
      const socket = server.connections.get(id);
      if (socket) {
        // Detach before closing so the close handler doesn't announce
        // device_left or touch the deleted rows.
        server.connections.delete(id);
        server.userByDevice.delete(id);
        server.clients.delete(socket);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'account_deleted' }));
          socket.close(ACCOUNT_DELETED_CLOSE_CODE, 'account_deleted');
        }
      }
      server.pulseHub.forgetDevice(id);
      server.deviceRenamedAt.delete(id);
    }
  } catch (err) {
    logger.error('Account deletion failed', { userId, error: (err as Error).message });
    server.sendError(ws, 'Could not delete the account. Try again.');
  } finally {
    server.deletingAccounts.delete(userId);
  }
}

export function handleRegisterPushToken(server: HeadServer, ws: WebSocket, state: ClientState, msg: Record<string, unknown>): void {
  const logger = getLogger();
  if (!state.userId || !state.deviceId) {
    server.sendError(ws, 'Not authenticated');
    return;
  }

  const payload = msg.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload.token !== 'string' || typeof payload.provider !== 'string') {
    server.sendError(ws, 'Invalid push token: payload.token and payload.provider required');
    return;
  }
  if (payload.provider === 'web_push' && !parseWebPushSubscription(payload.token)) {
    server.sendError(ws, 'Invalid push token: unsupported Web Push subscription');
    return;
  }

  server.storage.upsertPushToken(
    state.deviceId,
    payload.provider as string,
    payload.token as string,
    payload.environment as string | undefined,
    payload.bundleId as string | undefined,
  );

  // Clean up Web Push tokens from stale devices (offline >24h) to prevent
  // duplicate notifications from abandoned PWA installs on the same phone.
  // APNs tokens are kept: a phone not opened for a day still needs its pushes.
  // Only this user's devices matter; passing every connection on the relay
  // made each registration O(global connections) in SQL parameters.
  const onlineDeviceIds = server.storage.getDevicesByUser(state.userId)
    .map((d) => d.id)
    .filter((id) => server.connections.has(id));
  const pruned = server.storage.deleteStaleUserPushTokens(state.userId, state.deviceId, onlineDeviceIds);
  if (pruned > 0) {
    logger.info('Pruned stale push tokens', { userId: state.userId, count: pruned });
  }

  logger.info('Push token registered', { deviceId: state.deviceId, provider: payload.provider });
  if (state.deviceId) {
    server.sendControlToDevice(state.deviceId, { type: 'push_token_registered', payload: { provider: payload.provider } });
  }
}

export function handleUnregisterPushToken(server: HeadServer, ws: WebSocket, state: ClientState, msg: Record<string, unknown>): void {
  const logger = getLogger();
  if (!state.userId || !state.deviceId) {
    server.sendError(ws, 'Not authenticated');
    return;
  }

  const payload = msg.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload.provider !== 'string') {
    server.sendError(ws, 'Invalid unregister: payload.provider required');
    return;
  }

  server.storage.deletePushToken(state.deviceId, payload.provider as string);
  logger.info('Push token unregistered', { deviceId: state.deviceId, provider: payload.provider });
}
