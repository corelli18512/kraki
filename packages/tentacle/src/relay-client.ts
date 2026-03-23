/**
 * Relay client — connects the tentacle to the relay via WebSocket.
 *
 * Translates adapter events into protocol messages and broadcasts them to apps.
 * Receives unicast consumer actions from apps and routes them to the adapter.
 * Handles auth, E2E encryption, reconnection, and session lifecycle.
 */

import { WebSocket } from 'ws';
import type {
  ProducerMessage, ConsumerMessage,
  DeviceInfo, AuthOkMessage, AuthErrorMessage, DeviceSummary, AuthMethod,
  BroadcastEnvelope, UnicastEnvelope,
} from '@kraki/protocol';
import { importPublicKey, encryptToBlob, decryptFromBlob, signChallenge } from '@kraki/crypto';
import type { RecipientKey } from '@kraki/crypto';
import type { AgentAdapter } from './adapters/base.js';
import type { SessionManager, SessionContext } from './session-manager.js';
import type { KeyManager } from './key-manager.js';
import { createLogger } from './logger.js';

const logger = createLogger('relay-client');

export interface RelayClientOptions {
  /** Relay WebSocket URL (e.g., wss://kraki.corelli.cloud) */
  relayUrl: string;
  /** Device info for auth */
  device: DeviceInfo;
  /** How the relay should authenticate this device */
  authMethod: 'github' | 'channel-key' | 'open';
  /** Auth token, such as a GitHub token or channel/shared key */
  token?: string;
  /** Reconnect delay in ms. Default: 3000 */
  reconnectDelay?: number;
  /** Max reconnect attempts. Default: Infinity */
  maxReconnects?: number;
}

export type RelayClientState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';

export class RelayClient {
  private ws: WebSocket | null = null;
  private adapter: AgentAdapter;
  private sessionManager: SessionManager;
  private keyManager: KeyManager | null;
  private options: RelayClientOptions;
  private state: RelayClientState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authInfo: AuthOkMessage | null = null;
  /** Cached consumer public keys for E2E encryption */
  private consumerKeys = new Map<string, string>();
  /** Messages queued when E2E is enabled but no consumer keys are available yet */
  private pendingE2eQueue: Partial<ProducerMessage>[] = [];
  /** Maps pre-generated sessionId → requestId for concurrent create_session correlation */
  private pendingRequestIds = new Map<string, string>();
  /** Monotonic seq counter — per tentacle, shared across all sessions. */
  private seqCounter = 0;
  /** Tool kinds auto-approved via always_allow from apps */
  private allowedTools = new Set<string>();
  /** Prefer challenge auth when the relay already knows this device */
  private preferChallengeAuth = true;

  // Stale connection detection — tracks last incoming message to detect sleep/network changes
  private lastActivityAt = 0;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** How long without any activity before we consider the connection stale (ms) */
  private static readonly STALE_THRESHOLD = 60_000;
  /** How often to check for stale connection (ms) */
  private static readonly STALE_CHECK_INTERVAL = 10_000;

  /** Called when relay state changes */
  onStateChange: ((state: RelayClientState) => void) | null = null;
  /** Called on auth success */
  onAuthenticated: ((info: AuthOkMessage) => void) | null = null;
  /** Called on fatal error (won't reconnect) */
  onFatalError: ((message: string) => void) | null = null;

  constructor(
    adapter: AgentAdapter,
    sessionManager: SessionManager,
    options: RelayClientOptions,
    keyManager?: KeyManager | null,
  ) {
    this.adapter = adapter;
    this.sessionManager = sessionManager;
    this.options = options;
    this.keyManager = keyManager ?? null;
    this.wireAdapterEvents();
  }

  /**
   * Connect to the relay. Auto-reconnects on disconnect.
   */
  connect(): void {
    if (this.ws) return;
    this.setState('connecting');

    const ws = new WebSocket(this.options.relayUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.setState('authenticating');
      this.reconnectAttempts = 0;
      this.lastActivityAt = Date.now();
      this.startStaleCheck();
      const device = {
        ...this.options.device,
        publicKey: this.keyManager?.getCompactPublicKey(),
      };
      const auth = this.buildAuthPayload(device);
      ws.send(JSON.stringify({ type: 'auth', auth, device }));
    });

    ws.on('message', (data) => {
      this.lastActivityAt = Date.now();
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch {
        // Ignore malformed messages from head
      }
    });

    ws.on('close', () => {
      this.stopStaleCheck();
      this.ws = null;
      this.setState('disconnected');
      this.scheduleReconnect();
    });

    ws.on('error', () => {
      // Error triggers close, which handles reconnect
    });

    // Track any incoming frames as activity for stale detection
    ws.on('ping', () => {
      this.lastActivityAt = Date.now();
    });
  }

  /**
   * Disconnect from the relay. No reconnect.
   */
  disconnect(): void {
    this.stopStaleCheck();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState('disconnected');
  }

  /**
   * Get current connection state.
   */
  getState(): RelayClientState {
    return this.state;
  }

  /**
   * Get auth info from last successful connection.
   */
  getAuthInfo(): AuthOkMessage | null {
    return this.authInfo;
  }

  // ── Message handling ────────────────────────────────

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.type === 'auth_ok') {
      this.authInfo = msg as unknown as AuthOkMessage;
      this.preferChallengeAuth = true;
      // Cache consumer device public keys for E2E
      if (this.authInfo.devices) {
        this.updateConsumerKeys(this.authInfo.devices);
      }
      this.setState('connected');
      this.onAuthenticated?.(this.authInfo);
      this.resumeDisconnectedSessions();
      return;
    }

    if (msg.type === 'auth_error') {
      const authError = msg as unknown as AuthErrorMessage;
      if (authError.code === 'unknown_device' && this.preferChallengeAuth && this.options.device.deviceId && this.keyManager) {
        logger.warn('Challenge auth rejected for unknown device; retrying with full auth');
        this.preferChallengeAuth = false;
        this.ws?.close();
        return;
      }
      this.onFatalError?.(authError.message);
      this.disconnect();
      return;
    }

    if (msg.type === 'auth_challenge') {
      if (this.keyManager && this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          const signature = signChallenge(msg.nonce as string, this.keyManager.getKeyPair().privateKey);
          this.ws.send(JSON.stringify({ type: 'auth_response', signature }));
        } catch (err) {
          logger.error({ err }, 'Failed to sign auth challenge');
        }
      }
      return;
    }

    if (msg.type === 'server_error') {
      logger.error({ message: msg.message as string, ref: msg.ref }, 'Server error');
      return;
    }

    if (msg.type === 'pong') {
      return;
    }

    if (msg.type === 'ping') {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'pong' }));
      }
      return;
    }

    // Device presence notifications — update consumer keys dynamically
    if (msg.type === 'device_joined') {
      const device = msg.device as DeviceSummary;
      if (device.role === 'app') {
        const key = device.encryptionKey ?? device.publicKey;
        if (key) {
          this.consumerKeys.set(device.id, key);
          this.flushE2eQueue();
        }
      }
      return;
    }

    if (msg.type === 'device_left') {
      const deviceId = msg.deviceId as string;
      this.consumerKeys.delete(deviceId);
      return;
    }

    // Incoming unicast messages from apps — decrypt and handle inner message
    if (msg.type === 'unicast' && this.keyManager && this.authInfo) {
      try {
        const decrypted = decryptFromBlob(
          { blob: msg.blob as string, keys: msg.keys as Record<string, string> },
          this.authInfo.deviceId,
          this.keyManager.getKeyPair().privateKey,
        );
        const inner = JSON.parse(decrypted);
        this.handleConsumerMessage(inner as ConsumerMessage);
      } catch {
        // Can't decrypt — not for us or corrupted
      }
      return;
    }

    // Plaintext consumer messages (fallback when no keyManager)
    this.handleConsumerMessage(msg as unknown as ConsumerMessage);
  }

  private buildAuthPayload(device: DeviceInfo): AuthMethod {
    if (this.preferChallengeAuth && device.deviceId && this.keyManager) {
      return {
        method: 'challenge',
        deviceId: device.deviceId,
      };
    }

    switch (this.options.authMethod) {
      case 'github':
        if (!this.options.token) {
          throw new Error('GitHub auth requires a token or an already-known device for challenge auth');
        }
        return {
          method: 'github_token',
          token: this.options.token,
        };

      case 'channel-key':
        return {
          method: 'open',
          sharedKey: this.options.token,
        };

      case 'open':
      default:
        return this.options.token
          ? { method: 'open', sharedKey: this.options.token }
          : { method: 'open' };
    }
  }

  private handleConsumerMessage(msg: ConsumerMessage): void {
    // create_session is special — no sessionId yet
    if (msg.type === 'create_session') {
      this.handleCreateSession(msg);
      return;
    }

    const sessionId = msg.sessionId;
    if (!sessionId) return;

    try {
      switch (msg.type) {
        case 'send_input':
          // Broadcast user_message back to apps (round-trip confirmation)
          this.send({
            type: 'user_message',
            sessionId,
            payload: { content: msg.payload.text },
          });
          this.adapter.sendMessage(sessionId, msg.payload.text, msg.payload.attachments)
            .catch((err) => logger.error({ err, sessionId }, 'sendMessage failed'));
          break;
        case 'approve':
          this.adapter.respondToPermission(sessionId, msg.payload.permissionId, 'approve')
            .catch((err) => logger.error({ err, sessionId }, 'respondToPermission failed'));
          break;
        case 'deny':
          this.adapter.respondToPermission(sessionId, msg.payload.permissionId, 'deny')
            .catch((err) => logger.error({ err, sessionId }, 'respondToPermission failed'));
          break;
        case 'always_allow':
          // Track auto-approved tool kinds for future permissions
          if (msg.payload.toolKind) {
            this.allowedTools.add(msg.payload.toolKind);
          }
          this.adapter.respondToPermission(sessionId, msg.payload.permissionId, 'always_allow')
            .catch((err) => logger.error({ err, sessionId }, 'respondToPermission failed'));
          break;
        case 'answer':
          this.adapter.respondToQuestion(sessionId, msg.payload.questionId, msg.payload.answer, false)
            .catch((err) => logger.error({ err, sessionId }, 'respondToQuestion failed'));
          break;
        case 'kill_session':
          this.adapter.killSession(sessionId)
            .catch((err) => logger.error({ err, sessionId }, 'killSession failed'));
          break;
        case 'abort_session':
          this.adapter.abortSession(sessionId)
            .catch((err) => logger.error({ err, sessionId }, 'abortSession failed'));
          break;
        case 'delete_session':
          this.adapter.killSession(sessionId)
            .catch((err) => logger.error({ err, sessionId }, 'killSession on delete failed'));
          this.sessionManager.deleteSession(sessionId);
          this.send({ type: 'session_deleted', sessionId, payload: {} });
          break;
        default: {
          // Handle extended message types (e.g. set_session_mode)
          const ext = msg as any;
          if (ext.type === 'set_session_mode') {
            this.adapter.setSessionMode(sessionId, ext.payload.mode);
            // Echo confirmation back so head stores it for replay
            this.send({
              type: 'session_mode_set',
              sessionId,
              payload: { mode: ext.payload.mode },
            });
          }
          break;
        }
      }
    } catch (err) {
      logger.error({ err, sessionId, type: msg.type }, 'handleConsumerMessage failed');
    }
  }

  private async handleCreateSession(msg: ConsumerMessage): Promise<void> {
    if (msg.type !== 'create_session') return;
    const { model, cwd, prompt, requestId } = msg.payload;

    // Pre-generate a stable sessionId and map requestId BEFORE calling the adapter.
    // This is concurrency-safe: each request gets its own unique key.
    const preSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (requestId) {
      this.pendingRequestIds.set(preSessionId, requestId);
    }

    try {
      const result = await this.adapter.createSession({ model, cwd: cwd || '/', sessionId: preSessionId });

      // If an initial prompt was provided, send it to the new session
      if (prompt && result.sessionId) {
        await this.adapter.sendMessage(result.sessionId, prompt);
      }
    } catch (err) {
      this.pendingRequestIds.delete(preSessionId);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'server_error',
          message: `Failed to create session: ${(err as Error).message}`,
          requestId,
        }));
      }
    }
  }

  // ── Adapter event wiring ────────────────────────────

  private wireAdapterEvents(): void {
    this.adapter.onSessionCreated = (event) => {
      // Track in SessionManager if not already tracked (from resume)
      if (!this.sessionManager.getMeta(event.sessionId)) {
        this.sessionManager.createSession(event.agent, event.model, event.sessionId);
      }
      // Look up requestId by sessionId (set in handleCreateSession before adapter call)
      const requestId = this.pendingRequestIds.get(event.sessionId);
      if (requestId) this.pendingRequestIds.delete(event.sessionId);

      this.send({
        type: 'session_created',
        sessionId: event.sessionId,
        payload: { agent: event.agent, model: event.model, requestId },
      });
    };

    this.adapter.onMessage = (sessionId, event) => {
      this.send({
        type: 'agent_message',
        sessionId,
        payload: { content: event.content },
      });
      // Update context with latest state
      this.sessionManager.updateContext(sessionId, {
        lastUserMessage: '', // Will be set by send_input handler
      });
    };

    this.adapter.onMessageDelta = (sessionId, event) => {
      this.send({
        type: 'agent_message_delta',
        sessionId,
        payload: { content: event.content },
      });
    };

    this.adapter.onPermissionRequest = (sessionId, event) => {
      // Auto-approve if tool kind is in the always-allowed set
      if (this.allowedTools.has(event.toolArgs.toolName)) {
        this.adapter.respondToPermission(sessionId, event.id, 'approve')
          .catch((err) => logger.error({ err, sessionId }, 'auto-approve failed'));
        return;
      }

      this.send({
        type: 'permission',
        sessionId,
        payload: {
          id: event.id,
          toolName: event.toolArgs.toolName,
          args: event.toolArgs.args as Record<string, unknown>,
          description: event.description,
        },
      });
    };

    // When a permission is auto-resolved (e.g. by Always Allow), notify relay
    // so the web app can remove the blocking card
    this.adapter.onPermissionAutoResolved = (sessionId, permissionId) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'approve',
          sessionId,
          payload: { permissionId },
        }));
      }
    };

    this.adapter.onQuestionRequest = (sessionId, event) => {
      this.send({
        type: 'question',
        sessionId,
        payload: {
          id: event.id,
          question: event.question,
          choices: event.choices,
        },
      });
    };

    this.adapter.onToolStart = (sessionId, event) => {
      this.send({
        type: 'tool_start',
        sessionId,
        payload: { toolName: event.toolName, args: event.args, toolCallId: event.toolCallId },
      });
      // Track key files from tool usage
      if (event.toolName === 'read_file' || event.toolName === 'write_file') {
        const path = (event.args as any)?.path;
        if (path) {
          const ctx = this.sessionManager.getContext(sessionId);
          if (ctx) {
            const files = new Set(ctx.keyFiles);
            files.add(path);
            this.sessionManager.updateContext(sessionId, { keyFiles: Array.from(files) });
          }
        }
      }
    };

    this.adapter.onToolComplete = (sessionId, event) => {
      this.send({
        type: 'tool_complete',
        sessionId,
        payload: { toolName: event.toolName, args: {}, result: event.result, toolCallId: event.toolCallId },
      });
    };

    this.adapter.onIdle = (sessionId) => {
      this.send({ type: 'idle', sessionId, payload: {} });
    };

    this.adapter.onError = (sessionId, event) => {
      this.send({
        type: 'error',
        sessionId,
        payload: { message: event.message },
      });
    };

    this.adapter.onSessionEnded = (sessionId, event) => {
      this.sessionManager.endSession(sessionId, event.reason);
      this.send({
        type: 'session_ended',
        sessionId,
        payload: { reason: event.reason },
      });
    };
  }

  // ── Session resume on reconnect ─────────────────────

  private async resumeDisconnectedSessions(): Promise<void> {
    const resumable = this.sessionManager.getResumableSessions();
    for (const meta of resumable) {
      const result = this.sessionManager.resumeSession(meta.id);
      if (result) {
        try {
          await this.adapter.resumeSession(meta.id, result.context);
          // session_created will be fired by adapter's onSessionCreated callback
        } catch {
          this.sessionManager.endSession(meta.id, 'resume_failed');
          this.send({
            type: 'session_ended',
            sessionId: meta.id,
            payload: { reason: 'resume_failed' },
          });
        }
      }
    }
  }

  // ── Send to relay ───────────────────────────────────

  // TODO: Make send() accept a discriminated union of ProducerMessage types
  // instead of Partial<ProducerMessage> so TypeScript enforces correct payload
  // shape per message type (e.g. user_message must have payload.content).
  private send(msg: Partial<ProducerMessage>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Outbound messages also prove connectivity
    this.lastActivityAt = Date.now();

    // Tentacle assigns seq and timestamp before encryption
    const enriched = msg as Record<string, unknown>;
    enriched.seq = ++this.seqCounter;
    enriched.timestamp = new Date().toISOString();
    if (this.authInfo) {
      enriched.deviceId = this.authInfo.deviceId;
    }

    if (this.keyManager) {
      if (this.consumerKeys.size === 0) {
        // No consumers online — queue (bounded to prevent memory growth)
        if (this.pendingE2eQueue.length < 1000) {
          this.pendingE2eQueue.push(msg);
        } else {
          logger.warn({ type: (msg as any).type }, 'E2E queue full (1000) — dropping message');
        }
        return;
      }

      this.sendEncrypted(msg);
      return;
    }

    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      logger.error({ err }, 'ws.send failed');
    }
  }

  /**
   * Encrypt and send a message to the relay as a BroadcastEnvelope.
   */
  private sendEncrypted(msg: Partial<ProducerMessage>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.keyManager) return;

    const recipients: RecipientKey[] = [];
    for (const [deviceId, compactKey] of this.consumerKeys) {
      recipients.push({ deviceId, publicKey: importPublicKey(compactKey) });
    }

    const plaintext = JSON.stringify(msg);
    const { blob, keys } = encryptToBlob(plaintext, recipients);

    const envelope: BroadcastEnvelope = {
      type: 'broadcast',
      blob,
      keys,
    };

    // Send push notifications for permission and question messages
    if (msg.type === 'permission' || msg.type === 'question') {
      envelope.notify = true;
    }

    this.ws.send(JSON.stringify(envelope));
  }

  /**
   * Flush queued E2E messages once consumer keys become available.
   */
  private flushE2eQueue(): void {
    if (this.consumerKeys.size === 0 || this.pendingE2eQueue.length === 0) return;
    const queued = this.pendingE2eQueue.splice(0);
    for (const msg of queued) {
      this.sendEncrypted(msg);
    }
  }

  private updateConsumerKeys(devices: DeviceSummary[]): void {
    this.consumerKeys.clear();
    for (const d of devices) {
      if (d.role === 'app') {
        const key = d.encryptionKey ?? d.publicKey;
        if (key) this.consumerKeys.set(d.id, key);
      }
    }
    // Flush queued messages now that we have consumer keys
    this.flushE2eQueue();
  }

  // ── Stale connection detection ───────────────────────

  private startStaleCheck(): void {
    this.stopStaleCheck();
    this.staleCheckTimer = setInterval(() => {
      if (this.state !== 'connected' && this.state !== 'authenticating') return;
      const elapsed = Date.now() - this.lastActivityAt;
      if (elapsed > RelayClient.STALE_THRESHOLD) {
        logger.warn(`No activity for ${Math.round(elapsed / 1000)}s — connection stale, reconnecting`);
        this.ws?.close();
      }
    }, RelayClient.STALE_CHECK_INTERVAL);
  }

  private stopStaleCheck(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
  }

  // ── Reconnect logic ─────────────────────────────────

  private scheduleReconnect(): void {
    const max = this.options.maxReconnects ?? Infinity;
    if (this.reconnectAttempts >= max) {
      this.onFatalError?.('Max reconnect attempts reached');
      return;
    }

    const delay = this.options.reconnectDelay ?? 3000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  private setState(state: RelayClientState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state);
  }
}
