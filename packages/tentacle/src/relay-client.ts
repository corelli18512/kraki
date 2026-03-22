/**
 * Relay client — connects the tentacle to the head via WebSocket.
 *
 * Translates adapter events into protocol messages and sends them to the head.
 * Receives consumer actions from the head and routes them to the adapter.
 * Handles auth, reconnection, and session lifecycle.
 */

import { WebSocket } from 'ws';
import type {
  ProducerMessage, ConsumerMessage, Message,
  DeviceInfo, AuthOkMessage, DeviceSummary,
} from '@kraki/protocol';
import { importPublicKey } from '@kraki/crypto';
import type { RecipientKey, EncryptedPayload } from '@kraki/crypto';
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
  /** GitHub token or channel key */
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
  private e2eEnabled = false;
  /** Cached consumer public keys for E2E encryption */
  private consumerKeys = new Map<string, string>();
  /** Messages queued when E2E is enabled but no consumer keys are available yet */
  private pendingE2eQueue: Partial<ProducerMessage>[] = [];
  /** Maps pre-generated sessionId → requestId for concurrent create_session correlation */
  private pendingRequestIds = new Map<string, string>();

  // Stale connection detection — tracks server pings to detect sleep/network changes
  private lastServerPingAt = 0;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** How long without a server ping before we consider the connection stale (ms) */
  private static readonly STALE_THRESHOLD = 60_000; // 60s (server pings every 30s, so 2 missed pings)
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
      this.lastServerPingAt = Date.now();
      this.startStaleCheck();
      const authMsg: Record<string, unknown> = {
        type: 'auth',
        token: this.options.token,
        device: {
          ...this.options.device,
          publicKey: this.keyManager?.getCompactPublicKey(),
        },
      };
      ws.send(JSON.stringify(authMsg));
    });

    ws.on('message', (data) => {
      this.lastServerPingAt = Date.now();
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

    // Track server pings for stale connection detection
    ws.on('ping', () => {
      this.lastServerPingAt = Date.now();
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

  private handleMessage(msg: any): void {
    if (msg.type === 'auth_ok') {
      this.authInfo = msg as AuthOkMessage;
      this.e2eEnabled = this.authInfo.e2e && !!this.keyManager;
      // Cache consumer device public keys for E2E
      if (this.e2eEnabled && this.authInfo.devices) {
        this.updateConsumerKeys(this.authInfo.devices);
      }
      this.setState('connected');
      this.onAuthenticated?.(this.authInfo);
      this.resumeDisconnectedSessions();
      return;
    }

    if (msg.type === 'auth_error') {
      this.onFatalError?.(msg.message);
      this.disconnect();
      return;
    }

    if (msg.type === 'pong') {
      return;
    }

    if (msg.type === 'head_notice') {
      // Update consumer keys when devices change
      if (this.e2eEnabled && msg.event === 'device_online') {
        const dev = msg.data?.device;
        const key = dev?.encryptionKey ?? dev?.publicKey;
        if (dev && key) {
          this.consumerKeys.set(dev.id, key);
          this.flushE2eQueue();
        }
      }
      if (msg.event === 'device_offline' || msg.event === 'device_removed') {
        this.consumerKeys.delete(msg.data?.deviceId);
      }
      return;
    }

    // In E2E mode, incoming consumer messages may be encrypted
    if (msg.type === 'encrypted' && this.keyManager && this.authInfo) {
      try {
        const decrypted = this.keyManager.decryptForMe(
          { iv: msg.iv, ciphertext: msg.ciphertext, tag: msg.tag, keys: msg.keys },
          this.authInfo.deviceId,
        );
        const inner = JSON.parse(decrypted);
        this.handleConsumerMessage(inner as ConsumerMessage);
      } catch {
        // Can't decrypt — not for us or corrupted
      }
      return;
    }

    // Plaintext consumer messages
    this.handleConsumerMessage(msg as ConsumerMessage);
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

    if (this.e2eEnabled && this.keyManager) {
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
   * Encrypt and send a message to the relay.
   */
  private sendEncrypted(msg: Partial<ProducerMessage>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.keyManager) return;

    const recipients: RecipientKey[] = [];
    for (const [deviceId, compactKey] of this.consumerKeys) {
      recipients.push({ deviceId, publicKey: importPublicKey(compactKey) });
    }

    const plaintext = JSON.stringify(msg);
    const encrypted = this.keyManager.encryptForRecipients(plaintext, recipients);
    const envelope: Record<string, unknown> = {
      type: 'encrypted',
      sessionId: msg.sessionId,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      tag: encrypted.tag,
      keys: encrypted.keys,
    };
    // Expose agent/model for session_created so the head can register properly
    if (msg.type === 'session_created' && msg.payload) {
      envelope.agent = (msg.payload as Record<string, unknown>).agent;
      envelope.model = (msg.payload as Record<string, unknown>).model;
    }
    // Mark ephemeral messages — head forwards but doesn't persist
    if (msg.type === 'agent_message_delta' || msg.type === 'idle') {
      envelope.ephemeral = true;
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
      const elapsed = Date.now() - this.lastServerPingAt;
      if (elapsed > RelayClient.STALE_THRESHOLD) {
        logger.warn(`No server ping for ${Math.round(elapsed / 1000)}s — connection stale, reconnecting`);
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
