import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, createVerify } from 'crypto';
import { v4 as uuid } from 'uuid';
import type { IncomingMessage as HttpIncomingMessage } from 'http';
import type { Server } from 'http';
import type {
  AuthMessage, AuthErrorCode, AuthMethod,
  UnicastEnvelope, BroadcastEnvelope, DeviceSummary, DeviceRole, DeviceKind,
  VoiceResource, VoiceCapability,
} from '@kraki/protocol';
import { Storage } from './storage.js';
import { PulseHub } from './pulse-hub.js';
import { LeaseIssuer } from './lease-issuer.js';
import type { AuthProvider, AuthUser, AuthOutcome as ProviderAuthOutcome } from './auth.js';
import { GitHubAuthProvider } from './auth.js';
import { getLogger } from './logger.js';
import type { PushManager } from './push/index.js';
import type { AuthBackend, AuthOutcome, ChallengeOutcome } from './auth-backend.js';

function importPublicKey(compactKey: string): string {
  const lines = compactKey.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

function verifySignature(nonce: string, signature: string, publicKeyPem: string): boolean {
  const verify = createVerify('SHA256');
  verify.update(nonce);
  return verify.verify(publicKeyPem, signature, 'base64');
}

interface InFlightEntry {
  relaySeq: number;
  /** Pre-serialized JSON payload, ready to re-send. */
  payload: string;
  /** Date.now() when first sent. Updated on each retry. */
  sentAt: number;
  retries: number;
  /** True once retries are exhausted. Head stops re-sending this entry but
   *  keeps it in the buffer; a future ack will still prune it cleanly. The
   *  message bytes may or may not have reached the peer — recovery is
   *  delegated to application-level per-session replay if the content is
   *  actually missing. */
  giveUp?: boolean;
}

interface ClientState {
  deviceId?: string;
  userId?: string;
  authenticated: boolean;
  ip?: string;
  isAlive: boolean;
  authenticatedAt?: number;
  pendingNonce?: string;
  pendingDeviceId?: string;
  pendingDeviceInfo?: { encryptionKey?: string };
  pendingAuthMethod?: string;

  // ── Liveness uncertainty (device_pending broadcast) ──
  /** Timestamp when pong grace period expires (null = no pending ping). */
  pongOverdueAt: number | null;
  /** Whether we already broadcast device_pending for this ping cycle. */
  pendingLivenessBroadcast: boolean;
  /** Diagnostic: last time we sent a ping to this client (ms epoch). */
  lastPingSentAt?: number;
  /** Diagnostic: last time we received a pong from this client (ms epoch). */
  lastPongRecvAt?: number;

  // ── Delivery assurance (per-connection, head→peer direction) ──
  /** Monotonic counter for relaySeq head stamps on outbound tracked sends. */
  relaySeqCounter: number;
  /** In-flight buffer: messages sent but not yet acked by this peer. */
  inFlight: InFlightEntry[];
  /** Highest relaySeq this peer has acknowledged. */
  lastAckedSeq: number;
  /** Set true once peer demonstrates ack support by sending an `ack` field. */
  ackSupported: boolean;
  /** Last `now` value when retry pass ran for this client (for debug only). */
  lastRetryAt?: number;

  // ── Delivery assurance (per-connection, peer→head direction) ──
  /** Highest relaySeq head has received from this peer. Sent back as `ack`
   *  in outbound messages so the peer can prune its own in-flight buffer. */
  lastReceivedRelaySeq: number;
  /** Set of recently-processed peer relaySeqs (bounded ~MAX_IN_FLIGHT) so head
   *  silently drops duplicate retries from the peer. */
  seenRelaySeqs: Set<number>;
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
  /** Optional auth backend. If provided, auth is delegated to it instead of using local providers. */
  authBackend?: AuthBackend;
  /** This head's region identifier (e.g., 'us', 'china'). Sent to auth backend for region checks. */
  region?: string;
  /** Voice-broker lease signer. If absent, request_voice_lease is rejected with 'not_entitled'. */
  leaseIssuer?: LeaseIssuer;
  /** Per-lease TTL in seconds. Default 86400 (24h). */
  voiceLeaseTtlSec?: number;
  /** Quota seconds embedded in each lease. Default 7200 (2h). */
  voiceLeaseQuotaSec?: number;
  /** Per-user-per-day cap on total issued lease quota. Default 7200 (2h). */
  voiceDailyQuotaSec?: number;
  /**
   * Public WSS URL of the voice broker for this region (e.g.
   * `wss://cn.stt.kraki.chat/voice`). When set, head advertises a
   * `VoiceCapability` inside `auth_ok.voice` so arm can render the mic UI.
   * When unset, the field is omitted entirely — arm hides the mic UI.
   *
   * Must be set together with `leaseIssuer`: cli-side interlock refuses to
   * start in either-without-the-other configurations because:
   *   - Advertising a broker URL but having no issuer would mean clients
   *     show the mic UI then get `not_entitled` on every press.
   *   - Having an issuer but no advertised URL means clients have no way
   *     to actually use the leases they're being issued.
   */
  voiceBrokerUrl?: string;
}

const DEFAULT_VOICE_LEASE_TTL_SEC = 86_400;
const DEFAULT_VOICE_LEASE_QUOTA_SEC = 7_200;
const DEFAULT_VOICE_DAILY_QUOTA_SEC = 7_200;
const VALID_VOICE_RESOURCES = new Set<VoiceResource>(['voice/doubao']);

const DEFAULT_MAX_PAYLOAD = 10 * 1024 * 1024;

// ── Delivery assurance tuning ──────────────────────────────
/** Max in-flight (unacked) messages per connection before forcing reconnect. */
const MAX_IN_FLIGHT = 200;
/** How long to wait for an ack before re-sending a message (ms). */
const RETRY_AFTER_MS = 5_000;
/** Max retries before closing the connection (forces clean reconnect). */
const MAX_RETRIES = 3;
/** How often the retry pass runs (ms). Independent of the slower 30s ping timer
 *  so detection latency tracks the recipient's ping cadence (~10s), not the
 *  liveness check cadence. */
const RETRY_CHECK_INTERVAL_MS = 2_500;
/** Grace period after ping before broadcasting device_pending (ms).
 *  Overridable via PONG_GRACE_MS environment variable. */
const PONG_GRACE_MS = Math.max(1_000, parseInt(process.env.PONG_GRACE_MS ?? '8000', 10) || 8_000);

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
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  /** Per-hop pulse hub (opt-in via KRAKI_PULSE=1). Null ⇒ legacy path only. */
  private pulseHub: PulseHub | null = null;
  private pulseTickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(storage: Storage, options: HeadServerOptions) {
    this.storage = storage;
    this.options = options;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxPayload ?? DEFAULT_MAX_PAYLOAD,
    });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.startPingInterval();
    this.startRetryInterval();

    // Pulse per-hop reliable delivery (opt-in). Shares the Storage SQLite file.
    if (process.env.KRAKI_PULSE === '1') {
      this.pulseHub = new PulseHub(this.storage.rawDb, {
        now: () => Date.now(),
        sendPulseTo: (deviceId, pulseB64) => this.sendPulseFrameTo(deviceId, pulseB64),
      });
      this.pulseHub.recoverOnBoot();
      getLogger().info('Pulse hub enabled (KRAKI_PULSE=1)');
      // Drive pulse heartbeat/liveness/durable-expiry every 5s.
      this.pulseTickTimer = setInterval(() => this.pulseHub?.tick(), 5_000);
    }

    // Expire old pending messages on startup
    const expired = this.storage.expirePending();
    if (expired > 0) {
      getLogger().info('Expired pending messages on startup', { count: expired });
    }
  }

  private startPingInterval(): void {
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      for (const [deviceId, ws] of this.connections) {
        const state = this.clients.get(ws);
        if (state && !state.isAlive) {
          // Missed last pong — connection is dead. Log diagnostic timing so
          // post-mortems can tell network drop from event-loop block.
          getLogger().info('Terminating stale connection (no pong)', {
            deviceId,
            msSincePingSent: state.lastPingSentAt ? now - state.lastPingSentAt : null,
            msSinceLastPong: state.lastPongRecvAt ? now - state.lastPongRecvAt : null,
            wsReadyState: ws.readyState,
          });
          this.removeConnection(deviceId);
          continue;
        }
        if (state) state.isAlive = false;
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.ping(); // protocol-level ping (browsers auto-respond)
            // JSON ping for proxy keepalive — include ack so the peer can
            // prune its in-flight buffer even when no other traffic flows.
            const pingMsg: Record<string, unknown> = { type: 'ping' };
            if (state && state.lastReceivedRelaySeq > 0) {
              pingMsg.ack = state.lastReceivedRelaySeq;
            }
            ws.send(JSON.stringify(pingMsg));
            if (state) {
              state.pongOverdueAt = now + PONG_GRACE_MS;
              state.pendingLivenessBroadcast = false;
              state.lastPingSentAt = now;
            }
            getLogger().debug('Sent ping', {
              deviceId,
              msSinceLastPong: state?.lastPongRecvAt ? now - state.lastPongRecvAt : null,
            });
          }
        } catch (err) {
          getLogger().warn('Ping send failed', {
            deviceId,
            error: (err as Error)?.message,
          });
          this.removeConnection(deviceId);
        }
      }

      // Sweep expired pairing tokens
      for (const [token, data] of this.pairingTokens) {
        if (now > data.expiresAt) this.pairingTokens.delete(token);
      }
    }, HeadServer.PING_INTERVAL);
  }

  // ── Delivery assurance ───────────────────────────────────

  /** Run the retry pass at a fixed cadence, independent of the slower liveness
   *  ping. Detection latency for a dropped message is bounded by the recipient's
   *  ping cadence (~10s) + this interval. */
  private startRetryInterval(): void {
    this.retryTimer = setInterval(() => {
      this.runRetryPass();
    }, RETRY_CHECK_INTERVAL_MS);
  }

  /** Stamp a message with relaySeq, buffer for retry, and send. Use this for
   *  any post-auth message head expects the peer to receive reliably. Skip for
   *  pings, pongs, errors, and pre-auth handshake messages.
   *
   *  If the message has incoming `relaySeq`/`ack` fields from another hop
   *  (e.g. a forwarded unicast/broadcast), they are stripped — these are
   *  per-hop and not end-to-end. */
  private trackedSend(ws: WebSocket, state: ClientState, msg: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return;

    state.relaySeqCounter += 1;
    const relaySeq = state.relaySeqCounter;
    // Strip any per-hop tracking fields from the source message, then stamp ours.
    const { relaySeq: _ignoredSeq, ack: _ignoredAck, ...rest } = msg as Record<string, unknown>;
    const stamped: Record<string, unknown> = { ...rest, relaySeq };
    // Piggyback our own ack of what we've received from this peer on this connection.
    if (state.lastReceivedRelaySeq > 0) {
      stamped.ack = state.lastReceivedRelaySeq;
    }
    const payload = JSON.stringify(stamped);

    // Buffer full: evict the oldest entry silently and continue.
    // Connection is NOT killed — peer may simply be temporarily throttled
    // (e.g. backgrounded browser tab). The 30s protocol-level ping/pong is
    // the source of truth for liveness, not delivery exhaustion.
    if (state.inFlight.length >= MAX_IN_FLIGHT) {
      getLogger().warn('In-flight buffer full, evicting oldest entry', {
        deviceId: state.deviceId,
        inFlight: state.inFlight.length,
      });
      state.inFlight.shift();
    }

    state.inFlight.push({
      relaySeq,
      payload,
      sentAt: Date.now(),
      retries: 0,
    });

    try {
      ws.send(payload);
    } catch {
      // Send failed — connection is likely dead. Drop the connection so
      // the client can reconnect cleanly. Retry pass will not re-send to
      // a dead connection.
      if (state.deviceId) this.removeConnection(state.deviceId);
    }
  }

  /** Track an incoming relaySeq from peer. Returns true if message is a
   *  duplicate that should be dropped silently. */
  private trackInboundRelaySeq(state: ClientState, msg: Record<string, unknown>): boolean {
    if (!('relaySeq' in msg)) return false;
    const seq = msg.relaySeq;
    if (typeof seq !== 'number' || !Number.isFinite(seq) || seq <= 0) return false;

    if (state.seenRelaySeqs.has(seq)) {
      return true; // duplicate
    }

    // Bound the set so it doesn't grow unbounded. Drop the oldest tracked
    // ack window when full — at this point any duplicate older than the
    // window would have been delivered long ago.
    if (state.seenRelaySeqs.size >= MAX_IN_FLIGHT) {
      const iter = state.seenRelaySeqs.values().next();
      if (!iter.done) state.seenRelaySeqs.delete(iter.value);
    }
    state.seenRelaySeqs.add(seq);
    if (seq > state.lastReceivedRelaySeq) {
      state.lastReceivedRelaySeq = seq;
    }
    return false;
  }

  /** Process an incoming ack field from any message type. Prunes the in-flight
   *  buffer and flips ackSupported on first sighting. */
  private processAck(state: ClientState, msg: Record<string, unknown>): void {
    if (!('ack' in msg)) return;
    const ack = msg.ack;
    if (typeof ack !== 'number' || !Number.isFinite(ack)) return;

    // Presence of the field at all marks the peer as ack-capable, even if
    // ack: 0. Once flipped, it stays true for the lifetime of the connection.
    state.ackSupported = true;

    if (ack > state.lastAckedSeq) {
      state.lastAckedSeq = ack;
      // Prune everything ≤ ack from the in-flight buffer.
      if (state.inFlight.length > 0) {
        let firstUnacked = 0;
        while (firstUnacked < state.inFlight.length && state.inFlight[firstUnacked].relaySeq <= ack) {
          firstUnacked += 1;
        }
        if (firstUnacked > 0) {
          state.inFlight.splice(0, firstUnacked);
        }
      }
    }
  }

  /** Walk all connections; re-send unacked messages that have aged past
   *  RETRY_AFTER_MS. When MAX_RETRIES is exceeded, mark the entry giveUp
   *  but keep the connection alive — liveness is decided by the 30s
   *  protocol-level ping/pong, not by delivery-retry exhaustion. */
  private runRetryPass(): void {
    const logger = getLogger();
    const now = Date.now();

    for (const [deviceId, ws] of this.connections) {
      const state = this.clients.get(ws);
      if (!state) continue;
      if (!state.ackSupported) continue; // Old client — skip retry
      if (state.inFlight.length === 0) continue;
      if (ws.readyState !== WebSocket.OPEN) continue;

      state.lastRetryAt = now;
      let sendFailed = false;

      for (const entry of state.inFlight) {
        if (entry.giveUp) continue;
        // Already acked? (Shouldn't normally happen — processAck prunes —
        // but guard against races.)
        if (entry.relaySeq <= state.lastAckedSeq) continue;
        if (now - entry.sentAt < RETRY_AFTER_MS) continue;

        if (entry.retries >= MAX_RETRIES) {
          // Give up retrying this entry. Don't kill the connection — the
          // peer may just be temporarily throttled (e.g. backgrounded
          // browser tab). If the peer later catches up and acks, this
          // entry is pruned normally. If the bytes were truly lost, the
          // application layer's per-session replay handles content recovery.
          logger.debug('Giving up retries for entry', {
            deviceId,
            relaySeq: entry.relaySeq,
            retries: entry.retries,
          });
          entry.giveUp = true;
          continue;
        }

        entry.retries += 1;
        entry.sentAt = now;
        try {
          ws.send(entry.payload);
          logger.debug('Retried unacked message', {
            deviceId,
            relaySeq: entry.relaySeq,
            attempt: entry.retries,
          });
        } catch {
          // ws.send threw — the underlying socket is dead. Close it so the
          // close handler can clean up. This is a transport failure, not a
          // delivery-retry failure.
          sendFailed = true;
          break;
        }
      }

      if (sendFailed) {
        this.removeConnection(deviceId);
      }
    }

    // ── Liveness uncertainty: broadcast device_pending when pong is overdue ──
    for (const [deviceId, ws] of this.connections) {
      const state = this.clients.get(ws);
      if (!state?.authenticated || !state.userId) continue;
      if (state.pongOverdueAt === null) continue;
      if (state.pendingLivenessBroadcast) continue;
      if (now <= state.pongOverdueAt) continue;

      state.pendingLivenessBroadcast = true;
      getLogger().debug('Broadcasting device_pending (pong overdue)', { deviceId });
      this.broadcastDevicePending(state.userId, deviceId);
    }
  }

  // ── End delivery assurance ──────────────────────────────

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

  /**
   * Build the voice capability advertisement for `auth_ok` from this head's
   * config. Returns `undefined` (omit the field) when no broker URL is
   * configured for this region.
   *
   * Note: the per-region nature falls out for free in edge mode — the edge's
   * own `voiceBrokerUrl` config drives this, never main's. So Beijing edge
   * advertises Beijing's broker, and US main advertises nothing, all from a
   * single helper.
   */
  private getVoiceCapability(): VoiceCapability | undefined {
    const url = this.options.voiceBrokerUrl;
    if (!url) return undefined;
    return { brokerUrl: url, resource: 'voice/doubao' };
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
    const state: ClientState = {
      authenticated: false,
      isAlive: true,
      ip,
      pongOverdueAt: null,
      pendingLivenessBroadcast: false,
      relaySeqCounter: 0,
      inFlight: [],
      lastAckedSeq: 0,
      ackSupported: false,
      lastReceivedRelaySeq: 0,
      seenRelaySeqs: new Set(),
    };
    const logger = getLogger();

    this.clients.set(ws, state);
    logger.debug('WebSocket connected', { ip });

    ws.on('pong', () => { this.onPongReceived(state); });

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

    ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason?.toString?.() || '';
      if (state.deviceId) {
        const disconnectedDeviceId = state.deviceId;
        const disconnectedUserId = state.userId;

        // Only clean up if this socket is still the active connection.
        // A reconnecting device may have already replaced us in the map.
        if (this.connections.get(disconnectedDeviceId) === ws) {
          try { this.storage.touchDeviceLastSeen(disconnectedDeviceId); } catch { /* storage may be closed */ }
          this.connections.delete(disconnectedDeviceId);
          this.userByDevice.delete(disconnectedDeviceId);
          this.pulseHub?.onDeviceDisconnected(disconnectedDeviceId);
          logger.info('Device disconnected', {
            deviceId: disconnectedDeviceId,
            closeCode: code,
            closeReason: reasonStr,
          });

          if (disconnectedUserId) {
            this.broadcastDeviceLeft(disconnectedUserId, disconnectedDeviceId);
          }
        } else {
          logger.debug('Stale socket closed (already replaced by reconnect)', {
            deviceId: disconnectedDeviceId,
            closeCode: code,
            closeReason: reasonStr,
          });
        }
      } else {
        logger.debug('WebSocket closed before auth', { ip: state.ip, closeCode: code, closeReason: reasonStr });
      }
      this.clients.delete(ws);
    });

    ws.on('error', (err: Error) => {
      logger.warn('WebSocket error', {
        deviceId: state.deviceId,
        ip: state.ip,
        error: err?.message,
        code: (err as NodeJS.ErrnoException)?.code,
      });
      ws.close();
    });
  }

  private async onMessage(ws: WebSocket, state: ClientState, msg: Record<string, unknown>): Promise<void> {
    // Process ack field on every incoming message (post or pre-auth, doesn't matter —
    // ack just prunes our outbound buffer for this peer).
    this.processAck(state, msg);

    // Track inbound relaySeq for sending acks back. Duplicates are dropped silently.
    if (this.trackInboundRelaySeq(state, msg)) {
      return;
    }

    // One-shot pairing token request — before auth
    if (msg.type === 'request_pairing_token') {
      await this.handleRequestPairingToken(ws, state, msg as { token?: string });
      return;
    }

    // Pre-auth: auth_info, auth, auth_response
    if (!state.authenticated) {
      if (msg.type === 'auth_info') {
        if (this.options.authBackend) {
          const info = this.options.authBackend.getAuthInfo();
          ws.send(JSON.stringify({
            type: 'auth_info_response',
            methods: info.methods,
            githubClientId: info.githubClientId,
            vapidPublicKey: info.vapidPublicKey ?? this.getVapidPublicKey(),
          }));
        } else {
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
        }
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
      // Pulse-framed envelope? The hub (a pulse endpoint on each hop) handles
      // reliable delivery + durable store-and-forward. Legacy path untouched.
      if (this.pulseHub && typeof msg.pulse === 'string' && state.deviceId) {
        this.pulseHub.onPulseEnvelope(state.deviceId, {
          pulse: msg.pulse as string,
          to: msg.to as string,
        });
        return;
      }
      if (!isValidUnicast(msg)) {
        this.sendError(ws, 'Invalid unicast: to, blob, keys required');
        return;
      }
      this.handleUnicast(ws, state, msg as unknown as UnicastEnvelope);
      return;
    }

    if (msg.type === 'broadcast') {
      // Pulse broadcast frames (control: hello/ack/heartbeat) are addressed to a
      // specific hop via the hub too; a producer fans out per-device unicasts.
      if (this.pulseHub && typeof msg.pulse === 'string' && state.deviceId) {
        this.pulseHub.onPulseEnvelope(state.deviceId, { pulse: msg.pulse as string });
        return;
      }
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
          // Read back the full merged preferences
          const fullUser = this.storage.getUser(state.userId);
          const merged = fullUser?.preferences ?? prefs;
          const confirmation = { type: 'preferences_updated', preferences: merged };
          // Send confirmation to sender (tracked — peer should see it)
          this.trackedSend(ws, state, confirmation);
          // Broadcast to all other devices of the same user
          const userDevices = (() => {
            try { return this.storage.getDevicesByUser(state.userId!); } catch { return []; }
          })();
          for (const d of userDevices) {
            if (d.id === state.deviceId) continue;
            const other = this.connections.get(d.id);
            if (!other || other.readyState !== WebSocket.OPEN) continue;
            const otherState = this.clients.get(other);
            if (!otherState) continue;
            this.trackedSend(other, otherState, confirmation);
          }
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

    if (msg.type === 'request_voice_lease') {
      this.handleRequestVoiceLease(ws, state, msg);
      return;
    }

    if (msg.type === 'ping') {
      const pongMsg: Record<string, unknown> = { type: 'pong' };
      if (state.lastReceivedRelaySeq > 0) {
        pongMsg.ack = state.lastReceivedRelaySeq;
      }
      ws.send(JSON.stringify(pongMsg));
      return;
    }

    if (msg.type === 'pong') {
      this.onPongReceived(state);
      return;
    }

    this.sendError(ws, `Unknown message type: ${msg.type}`);
  }

  // --- Voice lease issuance ---

  private handleRequestVoiceLease(
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

    const issuer = this.options.leaseIssuer;
    if (!issuer) {
      ws.send(JSON.stringify({
        type: 'voice_lease_denied',
        reason: 'not_entitled',
        detail: 'Voice lease issuance is not enabled on this head',
      }));
      return;
    }

    // Validate request shape.
    const requestedDeviceId = typeof msg.deviceId === 'string' ? msg.deviceId : undefined;
    const requestedResource = typeof msg.resource === 'string' ? (msg.resource as VoiceResource) : undefined;
    if (!requestedDeviceId || !requestedResource) {
      ws.send(JSON.stringify({
        type: 'voice_lease_denied',
        reason: 'invalid_request',
        detail: 'Missing deviceId or resource',
      }));
      return;
    }

    // Lease may only be requested for the authenticated device — no proxying.
    if (requestedDeviceId !== deviceId) {
      ws.send(JSON.stringify({
        type: 'voice_lease_denied',
        reason: 'invalid_request',
        detail: 'deviceId does not match authenticated device',
      }));
      return;
    }

    if (!VALID_VOICE_RESOURCES.has(requestedResource)) {
      ws.send(JSON.stringify({
        type: 'voice_lease_denied',
        reason: 'invalid_request',
        detail: `Unknown resource: ${String(requestedResource)}`,
      }));
      return;
    }

    const ttl = this.options.voiceLeaseTtlSec ?? DEFAULT_VOICE_LEASE_TTL_SEC;
    const quotaPerLease = this.options.voiceLeaseQuotaSec ?? DEFAULT_VOICE_LEASE_QUOTA_SEC;
    const dailyCap = this.options.voiceDailyQuotaSec ?? DEFAULT_VOICE_DAILY_QUOTA_SEC;
    const nowSec = Math.floor(Date.now() / 1000);

    const issuedToday = this.storage.sumVoiceLeaseQuotaIssuedToday(userId, nowSec);
    if (issuedToday + quotaPerLease > dailyCap) {
      logger.info('Voice lease denied: daily quota exhausted', {
        userId, deviceId, issuedToday, quotaPerLease, dailyCap,
      });
      ws.send(JSON.stringify({
        type: 'voice_lease_denied',
        reason: 'quota_exhausted',
        detail: `Daily quota reached (${issuedToday}/${dailyCap}s)`,
      }));
      return;
    }

    const lease = issuer.issue({
      userId,
      deviceId,
      quotaSeconds: quotaPerLease,
      ttlSeconds: ttl,
      resource: requestedResource,
      nowUnixSec: nowSec,
    });

    try {
      this.storage.recordVoiceLease({
        jti: lease.payload.jti,
        userId,
        deviceId,
        resource: requestedResource,
        quotaSeconds: quotaPerLease,
        issuedAtUnixSec: lease.payload.iat,
        expiresAtUnixSec: lease.payload.exp,
      });
    } catch (err) {
      logger.error('Voice lease persist failed', {
        userId, deviceId, jti: lease.payload.jti, error: (err as Error).message,
      });
      ws.send(JSON.stringify({
        type: 'voice_lease_denied',
        reason: 'invalid_request',
        detail: 'Lease persistence failed',
      }));
      return;
    }

    logger.info('Voice lease issued', {
      userId, deviceId, jti: lease.payload.jti,
      quotaSeconds: quotaPerLease, ttlSec: ttl,
    });
    ws.send(JSON.stringify({ type: 'voice_lease_grant', lease }));
  }

  // --- Routing ---

  /** Send a pulse frame (control or forwarded data) to a device's socket, as a
   *  minimal unicast envelope carrying only the `pulse` field. Returns true if
   *  the device is online. Used by the PulseHub to reach endpoints. */
  private sendPulseFrameTo(deviceId: string, pulseB64: string): boolean {
    const ws = this.connections.get(deviceId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    // `to` lets the receiver's own pulse layer know which stream this is; blob
    // is empty because the payload (if any) is inside the pulse frame.
    ws.send(JSON.stringify({ type: 'unicast', to: deviceId, pulse: pulseB64, blob: '', keys: {} }));
    return true;
  }

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
      // Target offline — queue for delivery on reconnect.
      // Strip per-hop tracking fields before persisting so the queued payload
      // doesn't carry stale relaySeq/ack from this sender→head hop.
      const { relaySeq: _s, ack: _a, ...clean } = msg as unknown as Record<string, unknown>;
      this.storage.insertPending(msg.to, senderUserId, JSON.stringify(clean));
      logger.debug('Unicast queued for offline device', { from: state.deviceId, to: msg.to });
      return;
    }

    const targetState = this.clients.get(targetWs);
    if (!targetState) return;

    // Forward via tracked path so we retry if the recipient doesn't ack.
    this.trackedSend(targetWs, targetState, msg as unknown as Record<string, unknown>);
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
      const targetState = this.clients.get(targetWs);
      if (!targetState) continue;

      this.trackedSend(targetWs, targetState, msg as unknown as Record<string, unknown>);
    }

    // Send push notifications to offline devices with registered tokens
    if (msg.pushPreview && this.options.pushManager) {
      this.options.pushManager.sendToOfflineDevices(senderUserId, onlineDeviceIds, msg.pushPreview)
        .catch(err => logger.warn('Push notification send failed', { error: (err as Error).message }));
    }
  }

  private removeConnection(deviceId: string): void {
    const ws = this.connections.get(deviceId);
    const userId = this.userByDevice.get(deviceId);
    this.connections.delete(deviceId);
    this.userByDevice.delete(deviceId);
    if (ws) {
      try { ws.close(); } catch { /* best effort */ }
    }
    // Programmatic removal — the ws.on('close') handler's reconnect-guard
    // check will fail (we already deleted from the map), so notify other
    // devices ourselves. Idempotent: if the close handler does run later it
    // sees the map empty and skips.
    if (userId) {
      try { this.storage.touchDeviceLastSeen(deviceId); } catch { /* storage may be closed */ }
      this.broadcastDeviceLeft(userId, deviceId);
    }
  }

  private sendAuthError(ws: WebSocket, code: AuthErrorCode, message: string, redirect?: string, deviceId?: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'auth_error', code, message, ...(redirect && { redirect }), ...(deviceId && { deviceId }) }));
    }
  }

  // --- Auth ---

  private async handleAuth(ws: WebSocket, state: ClientState, msg: AuthMessage): Promise<void> {
    const logger = getLogger();
    const { auth } = msg;

    // If auth backend is configured, delegate everything to it
    if (this.options.authBackend) {
      if (auth.method === 'challenge') {
        // Challenge is multi-step — start here, verify in handleChallengeResponse
        const result = await this.options.authBackend.startChallenge(
          auth.deviceId,
          msg.device.encryptionKey,
          this.options.region,
        );
        if (!result.ok) {
          this.sendAuthError(ws, result.code as AuthErrorCode, result.message,
            result.code === 'wrong_region' ? (result as { redirect?: string }).redirect : undefined);
          return;
        }
        state.pendingNonce = result.nonce;
        state.pendingDeviceId = result.deviceId;
        state.pendingDeviceInfo = { encryptionKey: msg.device.encryptionKey };
        state.pendingAuthMethod = 'challenge';
        logger.debug('Issuing auth challenge (via backend)', { deviceId: auth.deviceId });
        ws.send(JSON.stringify({ type: 'auth_challenge', nonce: result.nonce }));
        return;
      }

      const result = await this.options.authBackend.authenticate(auth, msg.device, this.options.region);
      this.handleBackendAuthResult(ws, state, result);
      return;
    }

    // Legacy: inline auth (no backend configured)

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
        const oauthAuth = auth as { method: 'github_oauth'; code: string; codeVerifier?: string; redirectUri?: string };
        const result = await provider.authenticate({
          githubCode: oauthAuth.code,
          codeVerifier: typeof oauthAuth.codeVerifier === 'string' ? oauthAuth.codeVerifier : undefined,
          redirectUri: typeof oauthAuth.redirectUri === 'string' ? oauthAuth.redirectUri : undefined,
          ip: state.ip,
        });
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

    // If auth backend is configured, delegate verification
    if (this.options.authBackend) {
      this.options.authBackend.verifyChallenge(
        deviceId, nonce, msg.signature,
        pendingInfo?.encryptionKey,
        this.options.region,
      ).then(result => {
        this.handleBackendAuthResult(ws, state, result);
      }).catch(err => {
        logger.error('Auth backend verifyChallenge failed', { error: (err as Error).message });
        this.sendAuthError(ws, 'auth_rejected', 'Internal auth error');
      });
      return;
    }

    // Legacy: inline challenge verification

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
    state.authenticatedAt = Date.now();
    state.deviceId = deviceId;
    state.userId = user.userId;
    this.connections.set(deviceId, ws);
    this.userByDevice.set(deviceId, user.userId);
    this.pulseHub?.onDeviceConnected(deviceId);

    logger.info('Device authenticated via challenge-response', { deviceId, ip: state.ip });

    this.completeAuthHandshake(ws, {
      deviceId,
      userId: user.userId,
      user: {
        id: user.userId,
        login: user.username,
        provider: user.provider,
        email: user.email,
      },
      authMethod: 'challenge',
    });
  }

  /**
   * Handle a result from AuthBackend — registers connection state and sends response.
   * Used for both initial auth and challenge-response verification.
   */
  private handleBackendAuthResult(ws: WebSocket, state: ClientState, result: AuthOutcome): void {
    const logger = getLogger();

    if (!result.ok) {
      const redirect = result.code === 'wrong_region' ? (result as { redirect?: string }).redirect : undefined;
      const deviceId = result.code === 'wrong_region' ? (result as { deviceId?: string }).deviceId : undefined;
      this.sendAuthError(ws, result.code as AuthErrorCode, result.message, redirect, deviceId);
      return;
    }

    // Register connection
    state.authenticated = true;
    state.authenticatedAt = Date.now();
    state.deviceId = result.deviceId;
    state.userId = result.userId;
    this.connections.set(result.deviceId, ws);
    this.userByDevice.set(result.deviceId, result.userId);
    this.pulseHub?.onDeviceConnected(result.deviceId);

    logger.info('Device authenticated (via backend)', {
      deviceId: result.deviceId,
      user: result.user.login,
      method: result.authMethod,
      ip: state.ip,
    });

    // Mirror user + devices into local storage so edge-local operations
    // (broadcastDeviceJoined, getDeviceSummaries, etc.) work even when auth
    // is delegated to a remote backend.
    try {
      this.storage.upsertUser(
        result.user.id, result.user.login, result.user.provider, result.user.email,
      );
      for (const d of result.devices) {
        try {
          this.storage.upsertDevice(
            d.id, result.userId, d.name, d.role,
            d.kind ?? undefined, d.publicKey ?? undefined, d.encryptionKey ?? undefined,
          );
        } catch (err) {
          logger.warn('Failed to mirror device locally', { deviceId: d.id, error: (err as Error).message });
        }
      }
    } catch (err) {
      logger.warn('Failed to mirror user locally', { userId: result.userId, error: (err as Error).message });
    }

    this.completeAuthHandshake(ws, {
      deviceId: result.deviceId,
      userId: result.userId,
      user: result.user,
      authMethod: result.authMethod,
      devices: result.devices,
      backendPendingMessages: result.pendingMessages,
      githubClientId: result.githubClientId,
      vapidPublicKey: result.vapidPublicKey,
    });
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
  private completeAuthHandshake(
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
      /** Pending messages forwarded by a remote auth backend, if any. Merged with
       *  the local edge's own pending_messages table (which the head queued when
       *  unicasts arrived for this device while it was offline). */
      backendPendingMessages?: UnicastEnvelope[];
      /** Override of `getGitHubClientId()` (used when delegated). */
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
    const fullUser = this.storage.getUser(params.userId);
    const userResponse = {
      ...params.user,
      preferences: fullUser?.preferences ?? params.user.preferences,
    };

    // Flush locally-queued pending messages — every auth path that lands here
    // means a device is reconnecting, and any unicasts queued for it locally
    // (via handleUnicast → storage.insertPending) should be delivered now.
    // Combined with whatever the remote backend forwarded, if applicable.
    const localPending = this.flushPendingEnvelopes(params.deviceId);
    const pendingMessages = [
      ...(params.backendPendingMessages ?? []),
      ...localPending,
    ];

    // Devices list. If the caller provided one (edge mode), recompute online
    // status against our current connections map. Otherwise derive locally.
    const devices = params.devices
      ? params.devices.map(d => ({ ...d, online: this.connections.has(d.id) }))
      : this.getDeviceSummaries(params.userId);

    ws.send(JSON.stringify({
      type: 'auth_ok',
      deviceId: params.deviceId,
      authMethod: params.authMethod,
      user: userResponse,
      devices,
      githubClientId: params.githubClientId ?? this.getGitHubClientId(),
      vapidPublicKey: params.vapidPublicKey ?? this.getVapidPublicKey(),
      relayVersion: this.options.version,
      ...(pendingMessages.length > 0 && { pendingMessages }),
      ...(this.getVoiceCapability() && { voice: this.getVoiceCapability() }),
    }));

    this.broadcastDeviceJoined(params.userId, params.deviceId);
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
    state.authenticatedAt = Date.now();
    state.deviceId = deviceId;
    state.userId = user.id;
    this.connections.set(deviceId, ws);
    this.userByDevice.set(deviceId, user.id);
    this.pulseHub?.onDeviceConnected(deviceId);

    logger.info('Device authenticated', {
      deviceId,
      name: msg.device.name,
      role: msg.device.role,
      user: user.login,
      ip: state.ip,
    });

    this.completeAuthHandshake(ws, {
      deviceId,
      userId: user.id,
      user: {
        id: user.id,
        login: user.login,
        provider: user.provider,
        email: user.email,
      },
      authMethod,
    });
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

    if (this.options.authBackend) {
      try {
        const result = this.options.authBackend.createPairingToken(state.userId);
        logger.info('Pairing token created (via backend)', { userId: state.userId });
        ws.send(JSON.stringify({ type: 'pairing_token_created', token: result.token, expiresIn: result.expiresIn }));
      } catch {
        // Remote backend needs async — fall through to error
        this.sendError(ws, 'Pairing not available in remote mode');
      }
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

    // If auth backend is configured, delegate
    if (this.options.authBackend) {
      const result = await this.options.authBackend.requestPairingToken(msg.token, state.ip);
      if (!result.ok) {
        this.sendAuthError(ws, result.code as AuthErrorCode, result.message);
        return;
      }
      logger.info('Pairing token created (one-shot, via backend)', { userId: result.userId });
      ws.send(JSON.stringify({
        type: 'pairing_token_created',
        token: result.pairingToken,
        expiresIn: result.expiresIn,
      }));
      return;
    }

    // Legacy: inline pairing token creation
    let authResult: ProviderAuthOutcome = { ok: false, message: 'No auth provider accepted the token' };
    for (const provider of (this.options.authProviders?.values() ?? [])) {
      authResult = await provider.authenticate({ token: msg.token, ip: state.ip });
      if (authResult.ok) break;
    }
    if (!authResult.ok && this.options.authProvider && !this.options.authProviders?.size) {
      authResult = await this.options.authProvider.authenticate({ token: msg.token, ip: state.ip });
    }

    if (!authResult.ok) {
      this.sendAuthError(ws, 'auth_rejected', authResult.message);
      return;
    }

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

    // Clean up push tokens from stale devices (offline >24h) to prevent
    // duplicate notifications from abandoned PWA installs on the same phone.
    const onlineDeviceIds = Array.from(this.connections.keys());
    const pruned = this.storage.deleteStaleUserPushTokens(state.userId, state.deviceId, onlineDeviceIds);
    if (pruned > 0) {
      logger.info('Pruned stale push tokens', { userId: state.userId, count: pruned });
    }

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
    let userDevices;
    try {
      userDevices = this.storage.getDevicesByUser(userId);
    } catch { return; }
    for (const d of userDevices) {
      const ws = this.connections.get(d.id);
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;
      const targetState = this.clients.get(ws);
      if (!targetState) continue;
      this.trackedSend(ws, targetState, { type: 'device_removed', deviceId: removedDeviceId });
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

    let userDevices;
    try {
      userDevices = this.storage.getDevicesByUser(userId);
    } catch { return; }
    for (const d of userDevices) {
      if (d.id === newDeviceId) continue;
      const ws = this.connections.get(d.id);
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;
      const targetState = this.clients.get(ws);
      if (!targetState) continue;
      this.trackedSend(ws, targetState, { type: 'device_joined', device: summary });
    }
  }

  private broadcastDeviceLeft(userId: string, leftDeviceId: string): void {
    let userDevices;
    try {
      userDevices = this.storage.getDevicesByUser(userId);
    } catch { return; } // Storage may be closed during shutdown
    for (const d of userDevices) {
      if (d.id === leftDeviceId) continue;
      const ws = this.connections.get(d.id);
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;
      const targetState = this.clients.get(ws);
      if (!targetState) continue;
      this.trackedSend(ws, targetState, { type: 'device_left', deviceId: leftDeviceId });
    }
  }

  private broadcastDevicePending(userId: string, pendingDeviceId: string): void {
    let userDevices;
    try {
      userDevices = this.storage.getDevicesByUser(userId);
    } catch { return; }
    for (const d of userDevices) {
      if (d.id === pendingDeviceId) continue;
      const ws = this.connections.get(d.id);
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;
      const targetState = this.clients.get(ws);
      if (!targetState) continue;
      this.trackedSend(ws, targetState, { type: 'device_pending', deviceId: pendingDeviceId });
    }
  }

  /** Handle pong from either protocol-level or JSON pong.
   *  Re-promotes to device_joined if we already broadcast device_pending.
   *  Guards against stale pongs from replaced connections (reconnect race). */
  private onPongReceived(state: ClientState): void {
    const now = Date.now();
    const rttMs = state.lastPingSentAt ? now - state.lastPingSentAt : null;
    state.isAlive = true;
    const wasPending = state.pendingLivenessBroadcast;
    state.pongOverdueAt = null;
    state.pendingLivenessBroadcast = false;
    state.lastPongRecvAt = now;
    if (state.deviceId) {
      getLogger().debug('Received pong', { deviceId: state.deviceId, rttMs });
    }

    if (wasPending && state.userId && state.deviceId) {
      // Only re-promote if this state still belongs to the active connection.
      // A reconnecting device may have replaced us in the connections map;
      // broadcasting from a stale socket would emit a duplicate device_joined.
      const activeWs = this.connections.get(state.deviceId);
      const activeState = activeWs ? this.clients.get(activeWs) : null;
      if (activeState === state) {
        this.broadcastDeviceJoined(state.userId, state.deviceId);
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

  getStats(): {
    users: { total: number; online: number };
    devices: { total: number; online: number };
    connections: Array<{
      deviceId: string;
      userId: string;
      userName?: string;
      role?: string;
      kind?: string;
      connectedAt?: string;
    }>;
    registeredUsers: Array<{
      userId: string;
      username: string;
      provider: string;
      email?: string;
      createdAt: string;
      online: boolean;
      devices: Array<{
        id: string;
        name: string;
        role: string;
        kind?: string;
        online: boolean;
        lastSeen: string;
        createdAt: string;
      }>;
    }>;
  } {
    const onlineUserIds = new Set<string>();
    const connectionList: Array<{
      deviceId: string;
      userId: string;
      userName?: string;
      role?: string;
      kind?: string;
      connectedAt?: string;
    }> = [];

    for (const [deviceId, ws] of this.connections) {
      const state = this.clients.get(ws);
      if (!state?.authenticated || !state.userId) continue;

      onlineUserIds.add(state.userId);

      const device = this.storage.getDevice(deviceId);
      const user = this.storage.getUser(state.userId);

      connectionList.push({
        deviceId,
        userId: state.userId,
        userName: user?.username,
        role: device?.role,
        kind: device?.kind ?? undefined,
        connectedAt: state.authenticatedAt
          ? new Date(state.authenticatedAt).toISOString()
          : undefined,
      });
    }

    const allUsers = this.storage.getAllUsers();
    const registeredUsers = allUsers.map(u => {
      const devices = this.storage.getDevicesByUser(u.userId);
      return {
        userId: u.userId,
        username: u.username,
        provider: u.provider,
        email: u.email,
        createdAt: u.createdAt,
        online: onlineUserIds.has(u.userId),
        devices: devices.map(d => ({
          id: d.id,
          name: d.name,
          role: d.role,
          kind: d.kind ?? undefined,
          online: this.connections.has(d.id),
          lastSeen: d.lastSeen,
          createdAt: d.createdAt,
        })),
      };
    });

    return {
      users: {
        total: this.storage.getUserCount(),
        online: onlineUserIds.size,
      },
      devices: {
        total: this.storage.getDeviceCount(),
        online: this.connections.size,
      },
      connections: connectionList,
      registeredUsers,
    };
  }

  /** Test hook: inspect delivery state for an online device. Not used in prod. */
  getDeliveryState(deviceId: string): {
    inFlightCount: number;
    givenUpCount: number;
    relaySeqCounter: number;
    lastAckedSeq: number;
    ackSupported: boolean;
    lastReceivedRelaySeq: number;
  } | undefined {
    const ws = this.connections.get(deviceId);
    if (!ws) return undefined;
    const state = this.clients.get(ws);
    if (!state) return undefined;
    return {
      inFlightCount: state.inFlight.length,
      givenUpCount: state.inFlight.filter(e => e.giveUp).length,
      relaySeqCounter: state.relaySeqCounter,
      lastAckedSeq: state.lastAckedSeq,
      ackSupported: state.ackSupported,
      lastReceivedRelaySeq: state.lastReceivedRelaySeq,
    };
  }

  /** Test hook: force a retry pass without waiting for the timer. */
  forceRetryPass(): void {
    this.runRetryPass();
  }

  /** Test hook: run the ping pass (set isAlive=false, send ping, start grace timer). */
  forcePingPass(): void {
    for (const [deviceId, ws] of this.connections) {
      const state = this.clients.get(ws);
      if (state && !state.isAlive) {
        getLogger().info('Terminating stale connection (no pong)', { deviceId });
        this.removeConnection(deviceId);
        continue;
      }
      if (state) state.isAlive = false;
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
          const pingMsg: Record<string, unknown> = { type: 'ping' };
          if (state && state.lastReceivedRelaySeq > 0) {
            pingMsg.ack = state.lastReceivedRelaySeq;
          }
          ws.send(JSON.stringify(pingMsg));
          if (state) {
            state.pongOverdueAt = Date.now() + PONG_GRACE_MS;
            state.pendingLivenessBroadcast = false;
          }
        }
      } catch {
        this.removeConnection(deviceId);
      }
    }
  }

  /** Test hook: simulate the effect of a ping pass on a single device without
   *  actually sending a protocol-level ws.ping() (which triggers an auto-pong
   *  from the ws library client, making it impossible to test overdue scenarios).
   *  Sets isAlive=false and starts the grace timer. */
  simulatePingSent(deviceId: string): void {
    const ws = this.connections.get(deviceId);
    if (!ws) return;
    const state = this.clients.get(ws);
    if (!state) return;
    state.isAlive = false;
    state.pongOverdueAt = Date.now() + PONG_GRACE_MS;
    state.pendingLivenessBroadcast = false;
  }

  /** Test hook: expire the pong grace timer for a specific device so the next
   *  retry pass will broadcast device_pending immediately. */
  expirePongGrace(deviceId: string): void {
    const ws = this.connections.get(deviceId);
    if (!ws) return;
    const state = this.clients.get(ws);
    if (!state) return;
    if (state.pongOverdueAt !== null) {
      state.pongOverdueAt = Date.now() - 1;
    }
  }

  close(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.pulseTickTimer) {
      clearInterval(this.pulseTickTimer);
      this.pulseTickTimer = null;
    }
    for (const ws of this.clients.keys()) {
      ws.close();
    }
    this.wss.close();
    this.options.pushManager?.close();
  }
}
