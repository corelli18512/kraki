import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, createVerify } from 'crypto';
import type { IncomingMessage as HttpIncomingMessage } from 'http';
import type { Server } from 'http';
import type {
  AuthMessage, ReplayMessage, ProducerMessage, ConsumerMessage,
} from '@kraki/protocol';
import { ChannelManager } from './channel-manager.js';
import { Router } from './router.js';
import type { AuthProvider } from './auth.js';
import { GitHubAuthProvider } from './auth.js';
import { getLogger } from './logger.js';

/**
 * Import a compact base64 public key to PEM format.
 */
function importPublicKey(compactKey: string): string {
  const lines = compactKey.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Verify a challenge-response signature.
 */
function verifySignature(nonce: string, signature: string, publicKeyPem: string): boolean {
  const verify = createVerify('SHA256');
  verify.update(nonce);
  return verify.verify(publicKeyPem, signature, 'base64');
}

interface ClientState {
  deviceId?: string;
  channelId?: string;
  authenticated: boolean;
  ip?: string;
  alive: boolean;
  /** Pending challenge nonce for keypair auth */
  pendingNonce?: string;
  /** DeviceId claimed during challenge auth (not yet verified) */
  pendingDeviceId?: string;
  /** Device info from initial auth message (preserved for challenge-response) */
  pendingDeviceInfo?: { encryptionKey?: string; capabilities?: Record<string, unknown> };
}

export interface HeadServerOptions {
  /** Auth providers keyed by mode name. Falls back to authProvider if set. */
  authProviders?: Map<string, AuthProvider>;
  /** Supported auth mode names (for auth_info response) */
  authModes?: string[];
  /** Legacy single auth provider (used if authProviders not set) */
  authProvider?: AuthProvider;
  /** Enable E2E encryption mode */
  e2e: boolean;
  /** Max WebSocket message size in bytes. Default: 10MB */
  maxPayload?: number;
  /** Ping interval in ms. Default: 30000 (30s). Set 0 to disable. */
  pingInterval?: number;
  /** Pong timeout in ms. Default: 10000 (10s) */
  pongTimeout?: number;
  /** Allow QR pairing for adding devices. Default: true */
  pairingEnabled?: boolean;
  /** Pairing token TTL in seconds. Default: 300 (5 min) */
  pairingTtl?: number;
}

const DEFAULT_MAX_PAYLOAD = 10 * 1024 * 1024;
const DEFAULT_PING_INTERVAL = 30_000;
const DEFAULT_PONG_TIMEOUT = 10_000; // 10MB

/**
 * Basic message validation guard.
 * Checks structural requirements — not full schema validation.
 */
function isValidMessage(msg: unknown): msg is { type: string; [key: string]: unknown } {
  if (typeof msg !== 'object' || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  if (typeof obj.type !== 'string' || obj.type.length === 0) return false;
  if ('payload' in obj && (typeof obj.payload !== 'object' || obj.payload === null)) return false;
  return true;
}

/** Validate auth message shape */
function isValidAuth(msg: Record<string, unknown>): boolean {
  if (!msg.device || typeof msg.device !== 'object') return false;
  const dev = msg.device as Record<string, unknown>;
  if (typeof dev.name !== 'string' || typeof dev.role !== 'string') return false;
  if (dev.role !== 'tentacle' && dev.role !== 'app') return false;
  return true;
}

/** Validate create_session payload */
function isValidCreateSession(msg: Record<string, unknown>): boolean {
  if (!msg.payload || typeof msg.payload !== 'object') return false;
  const p = msg.payload as Record<string, unknown>;
  if (typeof p.targetDeviceId !== 'string') return false;
  if (typeof p.model !== 'string') return false;
  if (typeof p.requestId !== 'string') return false;
  return true;
}

/** Validate encrypted envelope */
function isValidEncrypted(msg: Record<string, unknown>): boolean {
  return typeof msg.iv === 'string' && typeof msg.ciphertext === 'string'
    && typeof msg.tag === 'string' && typeof msg.keys === 'object' && msg.keys !== null;
}

export class HeadServer {
  private wss: WebSocketServer;
  private cm: ChannelManager;
  private router: Router;
  private options: HeadServerOptions;
  private clients = new Map<WebSocket, ClientState>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Dedup: track recently seen client message IDs to prevent duplicates */
  private recentClientMsgIds = new Set<string>();
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(cm: ChannelManager, router: Router, options: HeadServerOptions) {
    this.cm = cm;
    this.router = router;
    this.options = options;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxPayload ?? DEFAULT_MAX_PAYLOAD,
    });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.startPingInterval();
    this.startDedupCleanup();
  }

  /** Resolve the auth provider (multi-provider or legacy single). */
  private getAuthProvider(): AuthProvider {
    if (this.options.authProviders?.size) {
      // Return first provider as default (actual selection happens per-request)
      return this.options.authProviders.values().next().value!;
    }
    return this.options.authProvider!;
  }

  /** Get supported auth mode names. */
  private getAuthModes(): string[] {
    if (this.options.authModes?.length) return this.options.authModes;
    if (this.options.authProviders?.size) return [...this.options.authProviders.keys()];
    return [this.options.authProvider?.name ?? 'open'];
  }

  /** Resolve auth provider by mode name (for multi-provider). */
  private getAuthProviderForMode(mode?: string): AuthProvider {
    if (mode && this.options.authProviders?.has(mode)) {
      return this.options.authProviders.get(mode)!;
    }
    return this.getAuthProvider();
  }

  /** Get the GitHub OAuth client ID if configured (for auth_info_response). */
  private getGitHubClientId(): { githubClientId?: string } {
    const ghProvider = this.findGitHubProvider();
    if (ghProvider?.oauthConfigured) {
      return { githubClientId: ghProvider.getClientId() };
    }
    return {};
  }

  /** Find the GitHubAuthProvider in the provider chain (unwrapping throttle). */
  private findGitHubProvider(): GitHubAuthProvider | undefined {
    const provider = this.options.authProviders?.get('github') ?? this.options.authProvider;
    if (!provider) return undefined;
    if (provider instanceof GitHubAuthProvider) return provider;
    if ('inner' in provider) {
      const inner = (provider as any).inner;
      if (inner instanceof GitHubAuthProvider) return inner;
    }
    return undefined;
  }

  /** Resolve the channel owner's user info for auth_ok. */
  private getChannelOwnerUser(channelId: string): { id: string; login: string; provider: string; email?: string } | undefined {
    const channel = this.cm.getStorage().getChannel(channelId);
    if (!channel) return undefined;
    const user = this.cm.getStorage().getUser(channel.ownerId);
    if (!user) return undefined;
    return { id: user.userId, login: user.username, provider: user.provider, email: user.email };
  }

  /**
   * Attach to an HTTP server for upgrade handling.
   */
  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });
  }

  /**
   * Accept a raw WebSocket connection (for testing without HTTP server).
   */
  acceptConnection(ws: WebSocket): void {
    this.onConnection(ws);
  }

  private onConnection(ws: WebSocket, req?: HttpIncomingMessage): void {
    const ip = req?.socket?.remoteAddress ?? req?.headers['x-forwarded-for']?.toString() ?? 'unknown';
    const state: ClientState = { authenticated: false, ip, alive: true };
    const logger = getLogger();

    this.clients.set(ws, state);
    logger.debug('WebSocket connected', { ip });

    ws.on('pong', () => {
      state.alive = true;
    });

    ws.on('message', (data) => {
      state.alive = true;
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
      if (state.deviceId && state.channelId) {
        const device = this.cm.disconnectDevice(state.deviceId);
        if (device) {
          logger.info('Device disconnected', { deviceId: state.deviceId, name: device.name });
          this.router.broadcastNotice(state.channelId, {
            type: 'head_notice',
            event: 'device_offline',
            data: { deviceId: state.deviceId },
          });
        }
      }
      this.clients.delete(ws);
    });

    ws.on('error', () => {
      ws.close();
    });
  }

  private async onMessage(ws: WebSocket, state: ClientState, msg: Record<string, unknown>): Promise<void> {
    // Handle ping/pong
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    // Dedup: if client provides a clientMsgId, check for duplicates
    if (typeof msg.clientMsgId === 'string') {
      if (this.trackClientMsgId(msg.clientMsgId)) {
        getLogger().debug('Duplicate message dropped', { clientMsgId: msg.clientMsgId });
        return;
      }
    }

    // One-shot pairing token request — no device registration, handled before auth
    if (msg.type === 'request_pairing_token') {
      await this.handleRequestPairingToken(ws, state, msg as { token?: string });
      return;
    }

    // Must auth first
    if (!state.authenticated) {
      if (msg.type === 'auth_info') {
        ws.send(JSON.stringify({
          type: 'auth_info_response',
          authModes: this.getAuthModes(),
          e2e: this.options.e2e,
          pairing: this.options.pairingEnabled !== false,
          ...this.getGitHubClientId(),
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
        this.handleChallengeResponse(ws, state, msg as any);
      } else {
        this.sendError(ws, 'Must authenticate first');
      }
      return;
    }

    // Validate type-specific messages
    if (msg.type === 'encrypted' && !isValidEncrypted(msg)) {
      this.sendError(ws, 'Invalid encrypted message: iv, ciphertext, tag, keys required');
      return;
    }
    if (msg.type === 'create_session' && !isValidCreateSession(msg)) {
      this.sendError(ws, 'Invalid create_session: requestId, targetDeviceId, model required');
      return;
    }

    // Handle control messages
    if (msg.type === 'replay') {
      const replay = msg as unknown as ReplayMessage;
      if (!state.deviceId) return;
      this.router.replay(state.deviceId, replay.afterSeq, replay.sessionId);
      return;
    }

    if (msg.type === 'mark_read') {
      if (!state.channelId) return;
      const { sessionId, seq } = msg as { sessionId: string; seq: number };
      if (sessionId && typeof seq === 'number') {
        this.cm.getStorage().markRead(state.channelId, sessionId, seq);
      }
      return;
    }

    if (msg.type === 'create_pairing_token') {
      this.handleCreatePairingToken(ws, state);
      return;
    }

    if (msg.type === 'delete_session') {
      this.handleDeleteSession(ws, state, msg as { sessionId?: string });
      return;
    }

    // Handle producer, consumer, and encrypted messages
    if (state.deviceId) {
      this.router.handleMessage(state.deviceId, msg as unknown as ProducerMessage | ConsumerMessage);
    }
  }

  private handleCreatePairingToken(ws: WebSocket, state: ClientState): void {
    const logger = getLogger();
    if (!(this.options.pairingEnabled ?? true)) {
      this.sendError(ws, 'Pairing is disabled on this relay');
      return;
    }
    if (!state.channelId) {
      this.sendError(ws, 'Not authenticated');
      return;
    }

    const token = `pt_${randomBytes(32).toString('hex')}`;
    const ttl = this.options.pairingTtl ?? 300;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    this.cm.getStorage().createPairingToken(token, state.channelId, expiresAt);

    logger.info('Pairing token created', { channelId: state.channelId, ttl });
    ws.send(JSON.stringify({
      type: 'pairing_token_created',
      token,
      expiresIn: ttl,
    }));
  }

  private handleDeleteSession(ws: WebSocket, state: ClientState, msg: { sessionId?: string }): void {
    const logger = getLogger();
    if (!state.channelId) {
      this.sendError(ws, 'Not authenticated');
      return;
    }
    if (!msg.sessionId || typeof msg.sessionId !== 'string') {
      this.sendError(ws, 'sessionId required for delete_session');
      return;
    }

    const session = this.cm.getStorage().getSessionById(msg.sessionId);
    if (!session || session.channelId !== state.channelId) {
      this.sendError(ws, 'Session not found');
      return;
    }

    this.cm.deleteSession(msg.sessionId, state.channelId);
    logger.info('Session deleted', { sessionId: msg.sessionId, channelId: state.channelId });

    this.router.broadcastNotice(state.channelId, {
      type: 'head_notice',
      event: 'session_removed',
      data: { sessionId: msg.sessionId },
    });
  }

  /**
   * One-shot pairing token request. Validates auth token inline,
   * creates a pairing token, responds, and requires no device registration.
   */
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

    const authResult = await this.getAuthProvider().authenticate({
      token: msg.token,
      ip: state.ip,
    });

    if (!authResult.ok) {
      ws.send(JSON.stringify({ type: 'auth_error', message: authResult.message }));
      return;
    }

    const channelId = this.cm.getOrCreateChannel(authResult.user);
    const token = `pt_${randomBytes(32).toString('hex')}`;
    const ttl = this.options.pairingTtl ?? 300;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    this.cm.getStorage().createPairingToken(token, channelId, expiresAt);

    logger.info('Pairing token created (one-shot)', { channelId, ttl });
    ws.send(JSON.stringify({
      type: 'pairing_token_created',
      token,
      expiresIn: ttl,
    }));
  }

  private async handleAuth(ws: WebSocket, state: ClientState, msg: AuthMessage): Promise<void> {
    const logger = getLogger();

    // Try pairing token auth first
    if ((msg as any).pairingToken) {
      this.handlePairingAuth(ws, state, msg);
      return;
    }

    // Try challenge-response for returning devices with a known deviceId + publicKey
    if (msg.device.deviceId && !msg.token && !msg.channelKey && !(msg as any).githubCode) {
      const device = this.cm.getStorage().getDevice(msg.device.deviceId);
      if (device && device.publicKey) {
        // Known device with public key — issue challenge
        const nonce = randomBytes(32).toString('hex');
        state.pendingNonce = nonce;
        state.pendingDeviceId = msg.device.deviceId;
        state.pendingDeviceInfo = {
          encryptionKey: msg.device.encryptionKey,
          capabilities: msg.device.capabilities as Record<string, unknown> | undefined,
        };
        logger.debug('Issuing auth challenge', { deviceId: msg.device.deviceId });
        ws.send(JSON.stringify({ type: 'auth_challenge', nonce }));
        return;
      }
    }

    // Route to GitHub provider when an OAuth code is provided
    const githubCode = (msg as any).githubCode as string | undefined;
    const authProvider = githubCode
      ? this.getAuthProviderForMode('github')
      : this.getAuthProvider();

    const authResult = await authProvider.authenticate({
      token: msg.token,
      channelKey: msg.channelKey,
      githubCode,
      ip: state.ip,
    });

    if (!authResult.ok) {
      logger.warn('Auth rejected', { ip: state.ip, reason: authResult.message });
      ws.send(JSON.stringify({ type: 'auth_error', message: authResult.message }));
      return;
    }

    const channelId = this.cm.getOrCreateChannel(authResult.user);
    let deviceId: string;
    try {
      deviceId = this.cm.registerDevice({
        channelId,
        name: msg.device.name,
        role: msg.device.role,
        send: (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        },
        kind: msg.device.kind,
        publicKey: msg.device.publicKey,
        encryptionKey: msg.device.encryptionKey,
        capabilities: msg.device.capabilities,
        clientDeviceId: msg.device.deviceId,
      });
    } catch (err) {
      logger.warn('Device registration failed', { ip: state.ip, error: (err as Error).message });
      ws.send(JSON.stringify({ type: 'auth_error', message: (err as Error).message }));
      return;
    }

    state.authenticated = true;
    state.deviceId = deviceId;
    state.channelId = channelId;

    logger.info('Device authenticated', {
      deviceId,
      name: msg.device.name,
      role: msg.device.role,
      user: authResult.user.login,
      ip: state.ip,
    });

    ws.send(JSON.stringify({
      type: 'auth_ok',
      channel: channelId,
      deviceId,
      e2e: this.options.e2e,
      devices: this.cm.getDeviceSummaries(channelId),
      sessions: this.cm.getSessionSummaries(channelId),
      readState: this.cm.getStorage().getReadState(channelId),
      user: this.getChannelOwnerUser(channelId),
      ...this.getGitHubClientId(),
    }));

    // Notify other devices
    this.router.broadcastNotice(channelId, {
      type: 'head_notice',
      event: 'device_online',
      data: {
        device: {
          id: deviceId,
          name: msg.device.name,
          role: msg.device.role,
          kind: msg.device.kind,
          publicKey: msg.device.publicKey,
          encryptionKey: msg.device.encryptionKey,
          capabilities: msg.device.capabilities,
          online: true,
        },
      },
    });
  }

  private handlePairingAuth(ws: WebSocket, state: ClientState, msg: AuthMessage): void {
    const logger = getLogger();
    if (!(this.options.pairingEnabled ?? true)) {
      ws.send(JSON.stringify({ type: 'auth_error', message: 'Pairing is disabled. Use OAuth to authenticate.' }));
      return;
    }

    const pairingToken = (msg as any).pairingToken as string;
    const channelId = this.cm.getStorage().consumePairingToken(pairingToken);

    if (!channelId) {
      logger.warn('Pairing auth failed: invalid or expired token', { ip: state.ip });
      ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid or expired pairing token' }));
      return;
    }

    let deviceId: string;
    try {
      deviceId = this.cm.registerDevice({
        channelId,
        name: msg.device.name,
        role: msg.device.role,
        send: (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        },
        kind: msg.device.kind,
        publicKey: msg.device.publicKey,
        encryptionKey: msg.device.encryptionKey,
        capabilities: msg.device.capabilities,
        clientDeviceId: msg.device.deviceId,
      });
    } catch (err) {
      logger.warn('Device registration failed (pairing)', { ip: state.ip, error: (err as Error).message });
      ws.send(JSON.stringify({ type: 'auth_error', message: (err as Error).message }));
      return;
    }

    state.authenticated = true;
    state.deviceId = deviceId;
    state.channelId = channelId;

    logger.info('Device paired via token', { deviceId, name: msg.device.name, ip: state.ip });

    ws.send(JSON.stringify({
      type: 'auth_ok',
      channel: channelId,
      deviceId,
      e2e: this.options.e2e,
      devices: this.cm.getDeviceSummaries(channelId),
      sessions: this.cm.getSessionSummaries(channelId),
      readState: this.cm.getStorage().getReadState(channelId),
      user: this.getChannelOwnerUser(channelId),
      ...this.getGitHubClientId(),
    }));

    this.router.broadcastNotice(channelId, {
      type: 'head_notice',
      event: 'device_online',
      data: {
        device: {
          id: deviceId,
          name: msg.device.name,
          role: msg.device.role,
          kind: msg.device.kind,
          publicKey: msg.device.publicKey,
          encryptionKey: msg.device.encryptionKey,
          capabilities: msg.device.capabilities,
          online: true,
        },
      },
    });
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
      ws.send(JSON.stringify({ type: 'auth_error', message: 'No pending challenge' }));
      return;
    }

    const device = this.cm.getStorage().getDevice(deviceId);
    if (!device || !device.publicKey) {
      ws.send(JSON.stringify({ type: 'auth_error', message: 'Device not found' }));
      return;
    }

    // Verify signature
    const publicKeyPem = importPublicKey(device.publicKey);
    const valid = verifySignature(nonce, msg.signature, publicKeyPem);

    if (!valid) {
      logger.warn('Challenge-response auth failed', { deviceId, ip: state.ip });
      ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid signature' }));
      return;
    }

    // Use encryptionKey from the auth message (may be new/updated)
    const encryptionKey = pendingInfo?.encryptionKey ?? device.encryptionKey ?? undefined;

    let registeredId: string;
    try {
      registeredId = this.cm.registerDevice({
        channelId: device.channelId,
        name: device.name,
        role: device.role as any,
        send: (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        },
        kind: (device.kind as any) ?? undefined,
        publicKey: device.publicKey ?? undefined,
        encryptionKey,
        clientDeviceId: deviceId,
      });
    } catch (err) {
      logger.warn('Device registration failed (challenge)', { deviceId, error: (err as Error).message });
      ws.send(JSON.stringify({ type: 'auth_error', message: (err as Error).message }));
      return;
    }

    state.authenticated = true;
    state.deviceId = registeredId;
    state.channelId = device.channelId;

    logger.info('Device authenticated via challenge-response', { deviceId, ip: state.ip });

    ws.send(JSON.stringify({
      type: 'auth_ok',
      channel: device.channelId,
      deviceId: registeredId,
      e2e: this.options.e2e,
      devices: this.cm.getDeviceSummaries(device.channelId),
      sessions: this.cm.getSessionSummaries(device.channelId),
      readState: this.cm.getStorage().getReadState(device.channelId),
      user: this.getChannelOwnerUser(device.channelId),
      ...this.getGitHubClientId(),
    }));

    this.router.broadcastNotice(device.channelId, {
      type: 'head_notice',
      event: 'device_online',
      data: {
        device: {
          id: registeredId,
          name: device.name,
          role: device.role as any,
          kind: (device.kind as any) ?? undefined,
          publicKey: device.publicKey ?? undefined,
          encryptionKey,
          online: true,
        },
      },
    });
  }

  private sendError(ws: WebSocket, message: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'server_error', message }));
    }
  }

  private startPingInterval(): void {
    const interval = this.options.pingInterval ?? DEFAULT_PING_INTERVAL;
    if (interval <= 0) return;

    const timeout = this.options.pongTimeout ?? DEFAULT_PONG_TIMEOUT;
    const logger = getLogger();

    this.pingTimer = setInterval(() => {
      for (const [ws, state] of this.clients) {
        if (!state.alive) {
          logger.warn('Device ping timeout, terminating', { deviceId: state.deviceId, ip: state.ip });
          ws.terminate();
          continue;
        }
        state.alive = false;
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }
    }, interval);
  }

  private startDedupCleanup(): void {
    // Clear dedup set periodically and bound max size
    this.dedupCleanupTimer = setInterval(() => {
      this.recentClientMsgIds.clear();
    }, 5 * 60_000);
  }

  /** Guard against unbounded dedup set growth */
  private trackClientMsgId(id: string): boolean {
    if (this.recentClientMsgIds.has(id)) return true; // duplicate
    if (this.recentClientMsgIds.size > 10_000) {
      this.recentClientMsgIds.clear(); // safety valve
    }
    this.recentClientMsgIds.add(id);
    return false;
  }

  /**
   * Close the server and all connections.
   */
  close(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.dedupCleanupTimer) { clearInterval(this.dedupCleanupTimer); this.dedupCleanupTimer = null; }
    for (const ws of this.clients.keys()) {
      ws.close();
    }
    this.wss.close();
  }
}
