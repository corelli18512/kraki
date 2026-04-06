import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, createVerify } from 'crypto';
import { v4 as uuid } from 'uuid';
import type { IncomingMessage as HttpIncomingMessage } from 'http';
import type { Server } from 'http';
import type {
  AuthMessage, AuthErrorCode, AuthMethod,
  UnicastEnvelope, BroadcastEnvelope, DeviceSummary, DeviceRole, DeviceKind,
} from '@kraki/protocol';
import { Storage } from './storage.js';
import type { AuthProvider, AuthUser, AuthOutcome } from './auth.js';
import { GitHubAuthProvider } from './auth.js';
import { getLogger } from './logger.js';
import type { PushManager } from './push/index.js';

function importPublicKey(compactKey: string): string {
  const lines = compactKey.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

function verifySignature(nonce: string, signature: string, publicKeyPem: string): boolean {
  const verify = createVerify('SHA256');
  verify.update(nonce);
  return verify.verify(publicKeyPem, signature, 'base64');
}

interface ClientState {
  deviceId?: string;
  userId?: string;
  authenticated: boolean;
  ip?: string;
  isAlive: boolean;
  pendingNonce?: string;
  pendingDeviceId?: string;
  pendingDeviceInfo?: { encryptionKey?: string };
  pendingAuthMethod?: string;
}

interface PairingToken {
  userId: string;
  expiresAt: number;
}

export interface HeadServerOptions {
  authProviders?: Map<string, AuthProvider>;
  authProvider?: AuthProvider;
  maxPayload?: number;
  pairingEnabled?: boolean;
  pairingTtl?: number;
  version?: string;
  pushManager?: PushManager;
}

const DEFAULT_MAX_PAYLOAD = 10 * 1024 * 1024;

function isValidMessage(msg: unknown): msg is { type: string; [key: string]: unknown } {
  if (typeof msg !== 'object' || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  return typeof obj.type === 'string' && obj.type.length > 0;
}

function isValidAuth(msg: Record<string, unknown>): boolean {
  if (!msg.device || typeof msg.device !== 'object') return false;
  const dev = msg.device as Record<string, unknown>;
  if (typeof dev.name !== 'string' || typeof dev.role !== 'string') return false;
  if (dev.role !== 'tentacle' && dev.role !== 'app') return false;
  if (!msg.auth || typeof msg.auth !== 'object') return false;
  const auth = msg.auth as Record<string, unknown>;
  if (typeof auth.method !== 'string') return false;
  return true;
}

function isValidUnicast(msg: Record<string, unknown>): boolean {
  return msg.type === 'unicast' && typeof msg.to === 'string'
    && typeof msg.blob === 'string' && typeof msg.keys === 'object' && msg.keys !== null;
}

function isValidBroadcast(msg: Record<string, unknown>): boolean {
  return msg.type === 'broadcast'
    && typeof msg.blob === 'string' && typeof msg.keys === 'object' && msg.keys !== null;
}

export class HeadServer {
  private wss: WebSocketServer;
  private storage: Storage;
  private options: HeadServerOptions;

  private static readonly PING_INTERVAL = 30_000;

  // In-memory state
  private connections = new Map<string, WebSocket>();
  private pairingTokens = new Map<string, PairingToken>();
  private userByDevice = new Map<string, string>();
  private clients = new Map<WebSocket, ClientState>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(storage: Storage, options: HeadServerOptions) {
    this.storage = storage;
    this.options = options;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxPayload ?? DEFAULT_MAX_PAYLOAD,
    });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.startPingInterval();

    // Expire old pending messages on startup
    const expired = this.storage.expirePending();
    if (expired > 0) {
      getLogger().info('Expired pending messages on startup', { count: expired });
    }
  }

  private startPingInterval(): void {
    this.pingTimer = setInterval(() => {
      const jsonPing = JSON.stringify({ type: 'ping' });
      for (const [deviceId, ws] of this.connections) {
        const state = this.clients.get(ws);
        if (state && !state.isAlive) {
          // Missed last pong — connection is dead
          getLogger().info('Terminating stale connection (no pong)', { deviceId });
          this.removeConnection(deviceId);
          continue;
        }
        if (state) state.isAlive = false;
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.ping();        // protocol-level ping (browsers auto-respond)
            ws.send(jsonPing); // JSON ping for proxy keepalive
          }
        } catch {
          this.removeConnection(deviceId);
        }
      }

      // Sweep expired pairing tokens
      const now = Date.now();
      for (const [token, data] of this.pairingTokens) {
        if (now > data.expiresAt) this.pairingTokens.delete(token);
      }
    }, HeadServer.PING_INTERVAL);
  }

  // --- Auth provider helpers ---

  private getAuthProvider(): AuthProvider {
    if (this.options.authProviders?.size) {
      return this.options.authProviders.values().next().value!;
    }
    return this.options.authProvider!;
  }

  private getAuthProviderForMode(mode?: string): AuthProvider {
    if (mode && this.options.authProviders?.has(mode)) {
      return this.options.authProviders.get(mode)!;
    }
    return this.getAuthProvider();
  }

  private getGitHubClientId(): string | undefined {
    const ghProvider = this.findGitHubProvider();
    return ghProvider?.oauthConfigured ? ghProvider.getClientId() : undefined;
  }

  private getVapidPublicKey(): string | undefined {
    return this.options.pushManager?.getVapidPublicKey();
  }

  private findGitHubProvider(): GitHubAuthProvider | undefined {
    const provider = this.options.authProviders?.get('github') ?? this.options.authProvider;
    if (!provider) return undefined;
    if (provider instanceof GitHubAuthProvider) return provider;
    if ('inner' in provider) {
      const inner = (provider as unknown as { inner: unknown }).inner;
      if (inner instanceof GitHubAuthProvider) return inner;
    }
    return undefined;
  }

  // --- Connection management ---

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });
  }

  acceptConnection(ws: WebSocket): void {
    this.onConnection(ws);
  }

  private onConnection(ws: WebSocket, req?: HttpIncomingMessage): void {
    const ip = req?.socket?.remoteAddress ?? req?.headers['x-forwarded-for']?.toString() ?? 'unknown';
    const state: ClientState = { authenticated: false, isAlive: true, ip };
    const logger = getLogger();

    this.clients.set(ws, state);
    logger.debug('WebSocket connected', { ip });

    ws.on('pong', () => { state.isAlive = true; });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!isValidMessage(msg)) {
          this.sendError(ws, 'Invalid message format');
          return;
        }
        this.onMessage(ws, state, msg).catch((err) => {
          getLogger().error('Unhandled error in message handler', { error: (err as Error).message });
          this.sendError(ws, 'Internal server error');
        });
      } catch {
        this.sendError(ws, 'Invalid JSON');
      }
    });

    ws.on('close', () => {
      if (state.deviceId) {
        const disconnectedDeviceId = state.deviceId;
        const disconnectedUserId = state.userId;

        // Only clean up if this socket is still the active connection.
        // A reconnecting device may have already replaced us in the map.
        if (this.connections.get(disconnectedDeviceId) === ws) {
          this.connections.delete(disconnectedDeviceId);
          this.userByDevice.delete(disconnectedDeviceId);
          logger.info('Device disconnected', { deviceId: disconnectedDeviceId });

          if (disconnectedUserId) {
            this.broadcastDeviceLeft(disconnectedUserId, disconnectedDeviceId);
          }
        } else {
          logger.debug('Stale socket closed (already replaced by reconnect)', { deviceId: disconnectedDeviceId });
        }
      }
      this.clients.delete(ws);
    });

    ws.on('error', () => {
      ws.close();
    });
  }

  private async onMessage(ws: WebSocket, state: ClientState, msg: Record<string, unknown>): Promise<void> {
    // One-shot pairing token request — before auth
    if (msg.type === 'request_pairing_token') {
      await this.handleRequestPairingToken(ws, state, msg as { token?: string });
      return;
    }

    // Pre-auth: auth_info, auth, auth_response
    if (!state.authenticated) {
      if (msg.type === 'auth_info') {
        const methods: string[] = [];
        if (this.options.authProviders?.has('github')) {
          methods.push('github_token');
          const ghProvider = this.findGitHubProvider();
          if (ghProvider?.oauthConfigured) methods.push('github_oauth');
        }
        if (this.options.authProviders?.has('apikey')) methods.push('apikey');
        if (this.options.authProviders?.has('open')) methods.push('open');
        if (this.options.pairingEnabled !== false) methods.push('pairing');
        methods.push('challenge');
        ws.send(JSON.stringify({
          type: 'auth_info_response',
          methods,
          githubClientId: this.getGitHubClientId(),
          vapidPublicKey: this.getVapidPublicKey(),
        }));
        return;
      }
      if (msg.type === 'auth') {
        if (!isValidAuth(msg)) {
          this.sendError(ws, 'Invalid auth message: device.name and device.role required');
          return;
        }
        await this.handleAuth(ws, state, msg as unknown as AuthMessage);
      } else if (msg.type === 'auth_response' && state.pendingNonce) {
        this.handleChallengeResponse(ws, state, msg as unknown as { deviceId: string; signature: string });
      } else {
        this.sendError(ws, 'Must authenticate first');
      }
      return;
    }

    // Authenticated messages
    if (msg.type === 'create_pairing_token') {
      this.handleCreatePairingToken(ws, state);
      return;
    }

    if (msg.type === 'unicast') {
      if (!isValidUnicast(msg)) {
        this.sendError(ws, 'Invalid unicast: to, blob, keys required');
        return;
      }
      this.handleUnicast(ws, state, msg as unknown as UnicastEnvelope);
      return;
    }

    if (msg.type === 'broadcast') {
      if (!isValidBroadcast(msg)) {
        this.sendError(ws, 'Invalid broadcast: blob, keys required');
        return;
      }
      this.handleBroadcast(state, msg as unknown as BroadcastEnvelope);
      return;
    }

    if (msg.type === 'update_preferences') {
      if (state.userId) {
        const prefs = msg.preferences as Record<string, unknown> | undefined;
        if (prefs && typeof prefs === 'object') {
          this.storage.updatePreferences(state.userId, prefs);
          ws.send(JSON.stringify({ type: 'preferences_updated', preferences: prefs }));
        }
      }
      return;
    }

    if (msg.type === 'remove_device') {
      this.handleRemoveDevice(ws, state, msg.deviceId as string);
      return;
    }

    if (msg.type === 'register_push_token') {
      this.handleRegisterPushToken(ws, state, msg);
      return;
    }

    if (msg.type === 'unregister_push_token') {
      this.handleUnregisterPushToken(ws, state, msg);
      return;
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (msg.type === 'pong') {
      state.isAlive = true;
      return;
    }

    this.sendError(ws, `Unknown message type: ${msg.type}`);
  }

  // --- Routing ---

  private handleUnicast(ws: WebSocket, state: ClientState, msg: UnicastEnvelope): void {
    const logger = getLogger();
    const senderUserId = state.userId;
    if (!senderUserId || !state.deviceId) return;

    // Verify target belongs to same user
    const targetDevice = this.storage.getDevice(msg.to);
    if (!targetDevice || targetDevice.userId !== senderUserId) {
      logger.warn('Unicast rejected: target not found or wrong user', { from: state.deviceId, to: msg.to });
      ws.send(JSON.stringify({ type: 'server_error', message: 'Target device not found or offline', ref: msg.ref }));
      return;
    }

    const targetWs = this.connections.get(msg.to);
    if (!targetWs) {
      // Target offline — queue for delivery on reconnect
      this.storage.insertPending(msg.to, senderUserId, JSON.stringify(msg));
      logger.debug('Unicast queued for offline device', { from: state.deviceId, to: msg.to });
      return;
    }

    try {
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(msg));
      }
    } catch {
      logger.warn('Unicast send failed, removing connection', { to: msg.to });
      this.removeConnection(msg.to);
    }
  }

  private handleBroadcast(state: ClientState, msg: BroadcastEnvelope): void {
    const logger = getLogger();
    const senderUserId = state.userId;
    const senderDeviceId = state.deviceId;
    if (!senderUserId || !senderDeviceId) return;

    // Find all other connected devices for this user
    const userDevices = this.storage.getDevicesByUser(senderUserId);
    const onlineDeviceIds: string[] = [senderDeviceId];

    for (const device of userDevices) {
      if (device.id === senderDeviceId) continue;

      const targetWs = this.connections.get(device.id);
      if (!targetWs) continue;

      onlineDeviceIds.push(device.id);
      try {
        if (targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify(msg));
        }
      } catch {
        logger.warn('Broadcast send failed, removing connection', { to: device.id });
        this.removeConnection(device.id);
      }
    }

    // Send push notifications to offline devices with registered tokens
    if (msg.pushPreview && this.options.pushManager) {
      this.options.pushManager.sendToOfflineDevices(senderUserId, onlineDeviceIds, msg.pushPreview)
        .catch(err => logger.warn('Push notification send failed', { error: (err as Error).message }));
    }
  }

  private removeConnection(deviceId: string): void {
    const ws = this.connections.get(deviceId);
    this.connections.delete(deviceId);
    this.userByDevice.delete(deviceId);
    if (ws) {
      try { ws.close(); } catch { /* best effort */ }
    }
  }

  private sendAuthError(ws: WebSocket, code: AuthErrorCode, message: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'auth_error', code, message }));
    }
  }

  // --- Auth ---

  private async handleAuth(ws: WebSocket, state: ClientState, msg: AuthMessage): Promise<void> {
    const logger = getLogger();
    const { auth } = msg;

    switch (auth.method) {
      case 'pairing': {
        this.handlePairingAuth(ws, state, auth.token, msg);
        return;
      }

      case 'challenge': {
        const device = this.storage.getDevice(auth.deviceId);
        if (device && device.publicKey) {
          const nonce = randomBytes(32).toString('hex');
          state.pendingNonce = nonce;
          state.pendingDeviceId = auth.deviceId;
          state.pendingDeviceInfo = { encryptionKey: msg.device.encryptionKey };
          state.pendingAuthMethod = 'challenge';
          logger.debug('Issuing auth challenge', { deviceId: auth.deviceId });
          ws.send(JSON.stringify({ type: 'auth_challenge', nonce }));
          return;
        }
        this.sendAuthError(ws, 'unknown_device', 'Unknown device');
        return;
      }

      case 'github_token': {
        const provider = this.getAuthProviderForMode('github');
        const result = await provider.authenticate({ token: auth.token, ip: state.ip });
        if (!result.ok) {
          logger.warn('Auth rejected', { method: 'github_token', ip: state.ip, reason: result.message });
          this.sendAuthError(ws, 'auth_rejected', result.message);
          return;
        }
        this.completeAuth(ws, state, result.user, msg, 'github_token');
        return;
      }

      case 'github_oauth': {
        const provider = this.getAuthProviderForMode('github');
        const result = await provider.authenticate({ githubCode: auth.code, ip: state.ip });
        if (!result.ok) {
          logger.warn('Auth rejected', { method: 'github_oauth', ip: state.ip, reason: result.message });
          this.sendAuthError(ws, 'auth_rejected', result.message);
          return;
        }
        this.completeAuth(ws, state, result.user, msg, 'github_oauth');
        return;
      }

      case 'apikey': {
        const provider = this.getAuthProviderForMode('apikey');
        const result = await provider.authenticate({ token: auth.key, ip: state.ip });
        if (!result.ok) {
          logger.warn('Auth rejected', { method: 'apikey', ip: state.ip, reason: result.message });
          this.sendAuthError(ws, 'auth_rejected', result.message);
          return;
        }
        this.completeAuth(ws, state, result.user, msg, 'apikey');
        return;
      }

      case 'open': {
        const provider = this.getAuthProviderForMode('open');
        const result = await provider.authenticate({ token: auth.sharedKey, ip: state.ip });
        if (!result.ok) {
          logger.warn('Auth rejected', { method: 'open', ip: state.ip, reason: result.message });
          this.sendAuthError(ws, 'auth_rejected', result.message);
          return;
        }
        this.completeAuth(ws, state, result.user, msg, 'open');
        return;
      }

      default: {
        const method = (auth as { method: string }).method;
        this.sendAuthError(ws, 'unknown_auth_method', `Unknown auth method: ${method}`);
      }
    }
  }

  private handlePairingAuth(ws: WebSocket, state: ClientState, pairingToken: string, msg: AuthMessage): void {
    const logger = getLogger();
    if (!(this.options.pairingEnabled ?? true)) {
      this.sendAuthError(ws, 'pairing_disabled', 'Pairing is disabled.');
      return;
    }

    const tokenData = this.pairingTokens.get(pairingToken);

    if (!tokenData || tokenData.expiresAt < Date.now()) {
      if (tokenData) this.pairingTokens.delete(pairingToken);
      logger.warn('Pairing auth failed: invalid or expired token', { ip: state.ip });
      this.sendAuthError(ws, 'invalid_pairing_token', 'Invalid or expired pairing token');
      return;
    }

    // Consume token (single-use)
    this.pairingTokens.delete(pairingToken);

    const user = this.storage.getUser(tokenData.userId);
    if (!user) {
      this.sendAuthError(ws, 'user_not_found', 'User not found');
      return;
    }

    const authUser: AuthUser = { id: user.userId, login: user.username, provider: user.provider, email: user.email };
    this.completeAuth(ws, state, authUser, msg, 'pairing');
  }

  private handleChallengeResponse(ws: WebSocket, state: ClientState, msg: { deviceId: string; signature: string }): void {
    const logger = getLogger();
    const deviceId = state.pendingDeviceId;
    const nonce = state.pendingNonce;
    const pendingInfo = state.pendingDeviceInfo;

    state.pendingNonce = undefined;
    state.pendingDeviceId = undefined;
    state.pendingDeviceInfo = undefined;

    if (!deviceId || !nonce) {
      this.sendAuthError(ws, 'no_pending_challenge', 'No pending challenge');
      return;
    }

    const device = this.storage.getDevice(deviceId);
    if (!device || !device.publicKey) {
      this.sendAuthError(ws, 'device_not_found', 'Device not found');
      return;
    }

    const publicKeyPem = importPublicKey(device.publicKey);
    const valid = verifySignature(nonce, msg.signature, publicKeyPem);

    if (!valid) {
      logger.warn('Challenge-response auth failed', { deviceId, ip: state.ip });
      this.sendAuthError(ws, 'invalid_signature', 'Invalid signature');
      return;
    }

    // Update encryption key if provided
    const encryptionKey = pendingInfo?.encryptionKey ?? device.encryptionKey ?? undefined;
    this.storage.upsertDevice(
      deviceId, device.userId, device.name, device.role,
      device.kind ?? undefined, device.publicKey ?? undefined, encryptionKey,
    );

    const user = this.storage.getUser(device.userId);
    if (!user) {
      this.sendAuthError(ws, 'user_not_found', 'User not found');
      return;
    }

    // Register connection
    state.authenticated = true;
    state.deviceId = deviceId;
    state.userId = user.userId;
    this.connections.set(deviceId, ws);
    this.userByDevice.set(deviceId, user.userId);

    logger.info('Device authenticated via challenge-response', { deviceId, ip: state.ip });

    const fullUser = this.storage.getUser(user.userId);
    const pendingMessages = this.flushPendingEnvelopes(deviceId);
    ws.send(JSON.stringify({
      type: 'auth_ok',
      deviceId,
      authMethod: 'challenge',
      user: { id: user.userId, login: user.username, provider: user.provider, preferences: fullUser?.preferences },
      devices: this.getDeviceSummaries(user.userId),
      githubClientId: this.getGitHubClientId(),
      vapidPublicKey: this.getVapidPublicKey(),
      relayVersion: this.options.version,
      ...(pendingMessages.length > 0 && { pendingMessages }),
    }));

    // Notify other connected devices about the reconnected device
    this.broadcastDeviceJoined(user.userId, deviceId);
  }

  private completeAuth(
    ws: WebSocket,
    state: ClientState,
    user: AuthUser,
    msg: AuthMessage,
    authMethod: AuthMethod['method'],
  ): void {
    const logger = getLogger();

    // Persist user
    this.storage.upsertUser(user.id, user.login, user.provider, user.email);

    // Register device
    const deviceId = msg.device.deviceId ?? `dev_${uuid().slice(0, 12)}`;
    try {
      this.storage.upsertDevice(
        deviceId, user.id, msg.device.name, msg.device.role,
        msg.device.kind, msg.device.publicKey, msg.device.encryptionKey,
      );
    } catch (err) {
      logger.warn('Device registration failed', { ip: state.ip, error: (err as Error).message });
      this.sendAuthError(ws, 'device_registration_failed', (err as Error).message);
      return;
    }

    state.authenticated = true;
    state.deviceId = deviceId;
    state.userId = user.id;
    this.connections.set(deviceId, ws);
    this.userByDevice.set(deviceId, user.id);

    logger.info('Device authenticated', {
      deviceId,
      name: msg.device.name,
      role: msg.device.role,
      user: user.login,
      ip: state.ip,
    });

    const fullUser = this.storage.getUser(user.id);
    const pendingMessages = this.flushPendingEnvelopes(deviceId);
    ws.send(JSON.stringify({
      type: 'auth_ok',
      deviceId,
      authMethod,
      user: { id: user.id, login: user.login, provider: user.provider, preferences: fullUser?.preferences },
      devices: this.getDeviceSummaries(user.id),
      githubClientId: this.getGitHubClientId(),
      vapidPublicKey: this.getVapidPublicKey(),
      relayVersion: this.options.version,
      ...(pendingMessages.length > 0 && { pendingMessages }),
    }));

    // Notify other connected devices about the new device
    this.broadcastDeviceJoined(user.id, deviceId);
  }

  // --- Pairing tokens (in-memory) ---

  private handleCreatePairingToken(ws: WebSocket, state: ClientState): void {
    const logger = getLogger();
    if (!(this.options.pairingEnabled ?? true)) {
      this.sendError(ws, 'Pairing is disabled on this relay');
      return;
    }
    if (!state.userId) {
      this.sendError(ws, 'Not authenticated');
      return;
    }

    const token = `pt_${randomBytes(32).toString('hex')}`;
    const ttl = this.options.pairingTtl ?? 300;
    this.pairingTokens.set(token, {
      userId: state.userId,
      expiresAt: Date.now() + ttl * 1000,
    });

    logger.info('Pairing token created', { userId: state.userId, ttl });
    ws.send(JSON.stringify({
      type: 'pairing_token_created',
      token,
      expiresIn: ttl,
    }));
  }

  private async handleRequestPairingToken(ws: WebSocket, state: ClientState, msg: { token?: string }): Promise<void> {
    const logger = getLogger();
    if (!(this.options.pairingEnabled ?? true)) {
      this.sendError(ws, 'Pairing is disabled on this relay');
      return;
    }
    if (!msg.token) {
      this.sendError(ws, 'Token required for pairing request');
      return;
    }

    // Try all configured auth providers until one succeeds
    let authResult: AuthOutcome = { ok: false, message: 'No auth provider accepted the token' };
    for (const provider of (this.options.authProviders?.values() ?? [])) {
      authResult = await provider.authenticate({ token: msg.token, ip: state.ip });
      if (authResult.ok) break;
    }
    // Fall back to legacy single provider if no authProviders map
    if (!authResult.ok && this.options.authProvider && !this.options.authProviders?.size) {
      authResult = await this.options.authProvider.authenticate({ token: msg.token, ip: state.ip });
    }

    if (!authResult.ok) {
      this.sendAuthError(ws, 'auth_rejected', authResult.message);
      return;
    }

    // Ensure user exists
    this.storage.upsertUser(authResult.user.id, authResult.user.login, authResult.user.provider, authResult.user.email);

    const token = `pt_${randomBytes(32).toString('hex')}`;
    const ttl = this.options.pairingTtl ?? 300;
    this.pairingTokens.set(token, {
      userId: authResult.user.id,
      expiresAt: Date.now() + ttl * 1000,
    });

    logger.info('Pairing token created (one-shot)', { userId: authResult.user.id, ttl });
    ws.send(JSON.stringify({
      type: 'pairing_token_created',
      token,
      expiresIn: ttl,
    }));
  }

  // --- Device presence notifications ---

  private handleRemoveDevice(ws: WebSocket, state: ClientState, targetDeviceId: string): void {
    const logger = getLogger();
    if (!state.userId || !state.deviceId) {
      this.sendError(ws, 'Not authenticated');
      return;
    }

    if (!targetDeviceId || typeof targetDeviceId !== 'string') {
      this.sendError(ws, 'Missing deviceId');
      return;
    }

    const targetDevice = this.storage.getDevice(targetDeviceId);
    if (!targetDevice || targetDevice.userId !== state.userId) {
      this.sendError(ws, 'Device not found');
      return;
    }

    // Only allow removing offline devices (zombie cleanup)
    if (this.connections.has(targetDeviceId)) {
      this.sendError(ws, 'Cannot remove an online device');
      return;
    }

    this.storage.deleteDevice(targetDeviceId);
    this.storage.deletePendingForDevice(targetDeviceId);
    this.storage.deletePushTokensForDevice(targetDeviceId);
    logger.info('Device removed', { deviceId: targetDeviceId, byDevice: state.deviceId });

    // Broadcast removal to all remaining user devices
    this.broadcastDeviceRemoved(state.userId, targetDeviceId);
  }

  // --- Push token management ---

  private handleRegisterPushToken(ws: WebSocket, state: ClientState, msg: Record<string, unknown>): void {
    const logger = getLogger();
    if (!state.userId || !state.deviceId) {
      this.sendError(ws, 'Not authenticated');
      return;
    }

    const payload = msg.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload.token !== 'string' || typeof payload.provider !== 'string') {
      this.sendError(ws, 'Invalid push token: payload.token and payload.provider required');
      return;
    }

    this.storage.upsertPushToken(
      state.deviceId,
      payload.provider as string,
      payload.token as string,
      payload.environment as string | undefined,
      payload.bundleId as string | undefined,
    );

    logger.info('Push token registered', { deviceId: state.deviceId, provider: payload.provider });
    ws.send(JSON.stringify({ type: 'push_token_registered', payload: { provider: payload.provider } }));
  }

  private handleUnregisterPushToken(ws: WebSocket, state: ClientState, msg: Record<string, unknown>): void {
    const logger = getLogger();
    if (!state.userId || !state.deviceId) {
      this.sendError(ws, 'Not authenticated');
      return;
    }

    const payload = msg.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload.provider !== 'string') {
      this.sendError(ws, 'Invalid unregister: payload.provider required');
      return;
    }

    this.storage.deletePushToken(state.deviceId, payload.provider as string);
    logger.info('Push token unregistered', { deviceId: state.deviceId, provider: payload.provider });
  }

  private broadcastDeviceRemoved(userId: string, removedDeviceId: string): void {
    const msg = JSON.stringify({ type: 'device_removed', deviceId: removedDeviceId });
    let userDevices;
    try {
      userDevices = this.storage.getDevicesByUser(userId);
    } catch { return; }
    for (const d of userDevices) {
      const ws = this.connections.get(d.id);
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch { /* best effort */ }
      }
    }
  }

  private broadcastDeviceJoined(userId: string, newDeviceId: string): void {
    let device;
    try {
      device = this.storage.getDevice(newDeviceId);
    } catch { return; } // Storage may be closed during shutdown
    if (!device) return;

    const summary: DeviceSummary = {
      id: device.id,
      name: device.name,
      role: device.role as DeviceRole,
      kind: (device.kind as DeviceKind) ?? undefined,
      publicKey: device.publicKey ?? undefined,
      encryptionKey: device.encryptionKey ?? undefined,
      online: true,
      lastSeen: device.lastSeen,
      createdAt: device.createdAt,
    };

    const msg = JSON.stringify({ type: 'device_joined', device: summary });
    let userDevices;
    try {
      userDevices = this.storage.getDevicesByUser(userId);
    } catch { return; }
    for (const d of userDevices) {
      if (d.id === newDeviceId) continue;
      const ws = this.connections.get(d.id);
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch { /* best effort */ }
      }
    }
  }

  private broadcastDeviceLeft(userId: string, leftDeviceId: string): void {
    const msg = JSON.stringify({ type: 'device_left', deviceId: leftDeviceId });
    let userDevices;
    try {
      userDevices = this.storage.getDevicesByUser(userId);
    } catch { return; } // Storage may be closed during shutdown
    for (const d of userDevices) {
      if (d.id === leftDeviceId) continue;
      const ws = this.connections.get(d.id);
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch { /* best effort */ }
      }
    }
  }

  // --- Helpers ---

  private getDeviceSummaries(userId: string): DeviceSummary[] {
    const stored = this.storage.getDevicesByUser(userId);
    return stored.map(d => ({
      id: d.id,
      name: d.name,
      role: d.role as DeviceRole,
      kind: (d.kind as DeviceKind) ?? undefined,
      publicKey: d.publicKey ?? undefined,
      encryptionKey: d.encryptionKey ?? undefined,
      online: this.connections.has(d.id),
      lastSeen: d.lastSeen,
      createdAt: d.createdAt,
    }));
  }

  private sendError(ws: WebSocket, message: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'server_error', message }));
    }
  }

  /** Flush pending messages from SQLite, parse into envelope objects. */
  private flushPendingEnvelopes(deviceId: string): UnicastEnvelope[] {
    const logger = getLogger();
    const rows = this.storage.flushPending(deviceId);
    if (rows.length === 0) return [];

    const envelopes: UnicastEnvelope[] = [];
    for (const raw of rows) {
      try {
        envelopes.push(JSON.parse(raw));
      } catch {
        logger.warn('Failed to parse pending message', { deviceId });
      }
    }
    logger.info('Flushed pending messages', { deviceId, count: envelopes.length });
    return envelopes;
  }

  close(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const ws of this.clients.keys()) {
      ws.close();
    }
    this.wss.close();
    this.options.pushManager?.close();
  }
}
