/**
 * Relay client — connects the tentacle to the relay via WebSocket.
 *
 * Translates adapter events into protocol messages and broadcasts them to apps.
 * Receives unicast consumer actions from apps and routes them to the adapter.
 * Handles auth, E2E encryption, reconnection, and session lifecycle.
 */

import { WebSocket } from 'ws';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { getKrakiHome } from './config.js';

const logger = createLogger('relay-client');

export interface RelayClientOptions {
  /** Relay WebSocket URL (e.g., wss://kraki.corelli.cloud) */
  relayUrl: string;
  /** Device info for auth */
  device: DeviceInfo;
  /** How the relay should authenticate this device */
  authMethod: AuthMethod['method'];
  /** Auth token, such as a GitHub token or channel/shared key */
  token?: string;
  /** Reconnect delay in ms. Default: 3000 */
  reconnectDelay?: number;
  /** Max reconnect attempts. Default: Infinity */
  maxReconnects?: number;
  /** Tentacle version string (included in device_greeting) */
  version?: string;
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
  private intentionalDisconnect = false;
  private authInfo: AuthOkMessage | null = null;
  /** Cached consumer public keys for E2E encryption */
  private consumerKeys = new Map<string, string>();
  /** Messages queued when E2E is enabled but no consumer keys are available yet */
  private pendingE2eQueue: Partial<ProducerMessage>[] = [];
  /** Maps pre-generated sessionId → requestId for concurrent create_session correlation */
  private pendingRequestIds = new Map<string, string>();
  private static readonly TRANSIENT_TYPES = new Set([
    'agent_message_delta',
    'session_mode_set',
    'session_title_updated',
    'session_model_set',
    'session_pinned',
    'session_read',
  ]);
  /** Global seq counter for envelope ordering (not used for replay — per-session seq handles that). */
  private seqCounter = 0;
  /** Prefer challenge auth when the relay already knows this device */
  private preferChallengeAuth = true;

  // ── Title generation state ──────────────────────────
  /** Turn count per session (for title generation scheduling) */
  private turnCounts = new Map<string, number>();
  /** Sessions currently generating a title (prevent concurrent generation) */
  private titleGenerationInFlight = new Set<string>();

  // ── Push preview state ─────────────────────────────
  /** Last agent message content per session (for idle push preview) */
  private lastAgentContent = new Map<string, string>();

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
    this.intentionalDisconnect = false;
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
      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
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
    this.intentionalDisconnect = true;
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
      // Process queued messages from the relay BEFORE broadcasting session list
      // so that deletes/mode changes are applied first
      this.processPendingMessages(this.authInfo.pendingMessages);
      this.resumeDisconnectedSessions();
      this.sendGreetingBroadcast();
      this.broadcastSessionList();
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
          // Send a greeting unicast so the app learns our capabilities
          this.sendGreetingTo(device.id, key);
          // Send session list so the app can sync
          this.sendSessionListTo(device.id, key);
        }
      }
      return;
    }

    if (msg.type === 'device_left') {
      const deviceId = msg.deviceId as string;
      this.consumerKeys.delete(deviceId);
      return;
    }

    // Incoming encrypted messages from apps — decrypt and handle inner message
    if ((msg.type === 'unicast' || msg.type === 'broadcast') && this.keyManager && this.authInfo) {
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
      case 'github_token':
        if (!this.options.token) {
          throw new Error('GitHub auth requires a token or an already-known device for challenge auth');
        }
        return {
          method: 'github_token',
          token: this.options.token,
        };

      case 'github_oauth':
        if (!this.options.token) {
          throw new Error('GitHub OAuth requires a code');
        }
        return {
          method: 'github_oauth',
          code: this.options.token,
        };

      case 'apikey':
        if (!this.options.token) {
          throw new Error('API key auth requires a key');
        }
        return {
          method: 'apikey',
          key: this.options.token,
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

    // fork_session is special — operates on a source session, not the new one
    if (msg.type === 'fork_session') {
      this.handleForkSession(msg);
      return;
    }

    // request_replay — replay buffered messages to the requesting device
    // request_session_replay — replay buffered messages for a specific session
    if (msg.type === 'request_session_replay') {
      this.handleSessionReplay(msg.deviceId, msg.payload.sessionId, msg.payload.afterSeq, msg.payload.limit);
      return;
    }

    // client_log — write web app debug logs to local file
    const msgRecord = msg as unknown as Record<string, unknown>;
    if (msgRecord.type === 'client_log') {
      const payload = msgRecord.payload as Record<string, unknown> | undefined;
      this.handleClientLog(msg.deviceId, payload?.entries as Array<{ ts: string; level: string; scope: string; message: string }> | undefined);
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
            payload: {
              content: msg.payload.text,
              ...(msg.payload.attachments?.length && { attachments: msg.payload.attachments }),
            },
          });
          this.sessionManager.markActive(sessionId);
          this.send({ type: 'active', sessionId, payload: {} });
          this.adapter.sendMessage(sessionId, msg.payload.text, msg.payload.attachments)
            .catch((err) => logger.error({ err, sessionId }, 'sendMessage failed'));
          break;
        case 'approve':
          this.adapter.respondToPermission(sessionId, msg.payload.permissionId, 'approve')
            .catch((err) => logger.error({ err, sessionId }, 'respondToPermission failed'));
          this.send({ type: 'permission_resolved', sessionId, payload: { permissionId: msg.payload.permissionId, resolution: 'approved' } });
          break;
        case 'deny':
          this.adapter.respondToPermission(sessionId, msg.payload.permissionId, 'deny')
            .catch((err) => logger.error({ err, sessionId }, 'respondToPermission failed'));
          this.send({ type: 'permission_resolved', sessionId, payload: { permissionId: msg.payload.permissionId, resolution: 'denied' } });
          break;
        case 'always_allow':
          this.adapter.respondToPermission(sessionId, msg.payload.permissionId, 'always_allow')
            .catch((err) => logger.error({ err, sessionId }, 'respondToPermission failed'));
          this.send({ type: 'permission_resolved', sessionId, payload: { permissionId: msg.payload.permissionId, resolution: 'always_allowed' } });
          break;
        case 'answer':
          this.adapter.respondToQuestion(sessionId, msg.payload.questionId, msg.payload.answer, false)
            .catch((err) => logger.error({ err, sessionId }, 'respondToQuestion failed'));
          this.send({ type: 'question_resolved', sessionId, payload: { questionId: msg.payload.questionId, answer: msg.payload.answer } });
          break;
        case 'kill_session':
          this.adapter.killSession(sessionId)
            .catch((err) => logger.error({ err, sessionId }, 'killSession failed'));
          break;
        case 'abort_session':
          this.adapter.abortSession(sessionId)
            .then(() => {
              this.sessionManager.markIdle(sessionId);
              this.send({ type: 'idle', sessionId, payload: {} });
            })
            .catch((err) => logger.error({ err, sessionId }, 'abortSession failed'));
          break;
        case 'delete_session':
          this.adapter.killSession(sessionId)
            .catch((err) => logger.error({ err, sessionId }, 'killSession on delete failed'))
            .finally(() => {
              this.sessionManager.deleteSession(sessionId);
              this.lastAgentContent.delete(sessionId);
              this.send({ type: 'session_deleted', sessionId, payload: {} });
            });
          break;
        case 'mark_read':
          this.sessionManager.markRead(sessionId, msg.payload.seq);
          this.send({
            type: 'session_read',
            sessionId,
            payload: { seq: msg.payload.seq },
          });
          break;
        case 'mark_unread': {
          const meta = this.sessionManager.getMeta(sessionId);
          if (meta && meta.lastSeq > 0) {
            const rolledBack = Math.max(0, meta.lastSeq - 1);
            this.sessionManager.markRead(sessionId, rolledBack);
            this.send({
              type: 'session_read',
              sessionId,
              payload: { seq: rolledBack },
            });
          }
          break;
        }
        case 'set_session_mode': {
          const mode = msg.payload.mode;
          this.adapter.setSessionMode(sessionId, mode);
          this.sessionManager.setMode(sessionId, mode);
          this.send({
            type: 'session_mode_set',
            sessionId,
            payload: { mode },
          });
          break;
        }
        case 'rename_session': {
          const newTitle = msg.payload.title;
          if (newTitle) {
            this.sessionManager.setTitle(sessionId, newTitle);
          } else {
            // Empty string = clear manual title
            this.sessionManager.setTitle(sessionId, '');
          }
          const meta = this.sessionManager.getMeta(sessionId);
          this.send({
            type: 'session_title_updated',
            sessionId,
            payload: { title: meta?.title, autoTitle: meta?.autoTitle },
          });
          break;
        }
        case 'set_session_model': {
          const { model, reasoningEffort } = msg.payload;
          this.adapter.setSessionModel(sessionId, model, reasoningEffort)
            .catch((err) => logger.error({ err, sessionId }, 'setSessionModel failed'));
          this.sessionManager.setModel(sessionId, model);
          this.send({
            type: 'session_model_set',
            sessionId,
            payload: { model, reasoningEffort },
          });
          break;
        }
        case 'pin_session': {
          const pinned = msg.payload.pinned;
          this.sessionManager.setPin(sessionId, pinned);
          this.send({
            type: 'session_pinned',
            sessionId,
            payload: { pinned },
          });
          break;
        }
        default:
          break;
      }
    } catch (err) {
      logger.error({ err, sessionId, type: msg.type }, 'handleConsumerMessage failed');
    }
  }

  private async handleCreateSession(msg: ConsumerMessage): Promise<void> {
    if (msg.type !== 'create_session') return;
    const { model, reasoningEffort, cwd, prompt, requestId } = msg.payload;

    // Pre-generate a stable sessionId and map requestId BEFORE calling the adapter.
    // This is concurrency-safe: each request gets its own unique key.
    const preSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (requestId) {
      this.pendingRequestIds.set(preSessionId, requestId);
    }

    try {
      const result = await this.adapter.createSession({ model, reasoningEffort, cwd: cwd || '/', sessionId: preSessionId });

      // If an initial prompt was provided, send it to the new session.
      // Otherwise mark idle — the SDK only fires session.idle after a turn
      // completes, so without a prompt the session would stay 'active' forever.
      if (prompt && result.sessionId) {
        await this.adapter.sendMessage(result.sessionId, prompt);
      } else if (result.sessionId) {
        this.sessionManager.markIdle(result.sessionId);
        this.send({ type: 'idle', sessionId: result.sessionId, payload: {} });
      }
    } catch (err) {
      this.pendingRequestIds.delete(preSessionId);
      const errorMsg = `Failed to create session: ${(err as Error).message}`;
      this.send({
        type: 'error',
        sessionId: '',
        payload: { message: errorMsg },
      });
    }
  }

  private async handleForkSession(msg: ConsumerMessage): Promise<void> {
    if (msg.type !== 'fork_session') return;
    const { sourceSessionId, requestId } = msg.payload;

    try {
      // 1. Fork kraki session files (meta, context, messages)
      const result = this.sessionManager.forkSession(sourceSessionId);
      if (!result) throw new Error(`Source session not found: ${sourceSessionId}`);

      const { sessionId: newId } = result;
      if (requestId) {
        this.pendingRequestIds.set(newId, requestId);
      }

      // 2. Fork SDK session state and resume
      await this.adapter.forkSession(sourceSessionId, newId);

      // 3. Forked session is idle until the user sends a message
      this.sessionManager.markIdle(newId);
      this.send({ type: 'idle', sessionId: newId, payload: {} });

    } catch (err) {
      logger.error({ err, sourceSessionId }, 'Fork session failed');
      const errorMsg = `Failed to fork session: ${(err as Error).message}`;
      this.send({
        type: 'error',
        sessionId: '',
        payload: { message: errorMsg },
      });
    }
  }

  // ── Pending message processing ─────────────────────

  /**
   * Process queued unicast envelopes delivered by the relay in auth_ok.
   * These are messages sent by arms while this tentacle was offline.
   * Must run before broadcastSessionList so deletes/mode changes take effect first.
   */
  private processPendingMessages(messages?: UnicastEnvelope[]): void {
    if (!messages || messages.length === 0 || !this.keyManager || !this.authInfo) return;

    logger.info(`Processing ${messages.length} pending message(s) from relay`);
    for (const envelope of messages) {
      try {
        const decrypted = decryptFromBlob(
          { blob: envelope.blob, keys: envelope.keys },
          this.authInfo.deviceId,
          this.keyManager.getKeyPair().privateKey,
        );
        const inner = JSON.parse(decrypted);
        this.handleConsumerMessage(inner as ConsumerMessage);
      } catch (err) {
        logger.warn({ err }, 'Failed to process pending message');
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

      const meta = this.sessionManager.getMeta(event.sessionId);
      this.send({
        type: 'session_created',
        sessionId: event.sessionId,
        payload: { agent: event.agent, model: event.model ?? meta?.model, requestId, lastSeq: meta?.lastSeq ?? 0 },
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
    this.adapter.onPermissionAutoResolved = (sessionId, permissionId, resolution) => {
      this.send({
        type: 'permission_resolved',
        sessionId,
        payload: { permissionId, resolution },
      });
    };

    this.adapter.onQuestionAutoResolved = (sessionId, questionId) => {
      this.send({
        type: 'question_resolved',
        sessionId,
        payload: { questionId, answer: '', cancelled: true },
      });
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
        const path = (event.args as Record<string, unknown>)?.path as string | undefined;
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
        payload: {
          toolName: event.toolName, args: {}, result: event.result,
          toolCallId: event.toolCallId,
          ...(event.attachments?.length && { attachments: event.attachments }),
        },
      });
    };

    this.adapter.onIdle = (sessionId) => {
      this.sessionManager.markIdle(sessionId);
      const usage = this.adapter.getSessionUsage(sessionId) ?? undefined;
      if (usage) this.sessionManager.setUsage(sessionId, usage);
      this.send({ type: 'idle', sessionId, payload: { usage } });
      this.maybeGenerateTitle(sessionId);
    };

    this.adapter.onUsageUpdate = (sessionId, usage) => {
      this.sessionManager.setUsage(sessionId, usage);
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
      this.turnCounts.delete(sessionId);
      this.titleGenerationInFlight.delete(sessionId);
      this.lastAgentContent.delete(sessionId);
      this.send({
        type: 'session_ended',
        sessionId,
        payload: { reason: event.reason },
      });
    };

    // SDK title fallback — use as fast placeholder while LLM generation runs
    this.adapter.onTitleChanged = (sessionId, title) => {
      const meta = this.sessionManager.getMeta(sessionId);
      if (!meta?.autoTitle) {
        this.sessionManager.setAutoTitle(sessionId, title);
        this.send({
          type: 'session_title_updated',
          sessionId,
          payload: { title: meta?.title, autoTitle: title },
        });
      }
    };
  }

  // ── Session resume on reconnect ─────────────────────

  private async resumeDisconnectedSessions(): Promise<void> {
    const resumable = this.sessionManager.getResumableSessions();
    for (const meta of resumable) {
      const originalState = meta.state;
      const result = this.sessionManager.resumeSession(meta.id);
      if (result) {
        try {
          await this.adapter.resumeSession(meta.id, result.context);
          // Restore permission mode from persisted meta
          if (meta.mode) {
            this.adapter.setSessionMode(meta.id, meta.mode);
          }
          // Restore persisted usage totals so accumulation continues
          if (meta.usage) {
            this.adapter.setSessionUsage(meta.id, meta.usage);
          }
          // Restore idle state — resumeSession sets active, but SDK won't
          // fire session.idle for an already-idle session
          if (originalState === 'idle') {
            this.sessionManager.markIdle(meta.id);
          }
        } catch (err) {
          logger.warn({ err, sessionId: meta.id }, 'Session resume failed after restart');
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

  // ── Session sync & replay ───────────────────────────

  /**
   * Send the session_list to a specific device (used on device_joined).
   */
  private sendSessionListTo(targetDeviceId: string, compactPubKey: string): void {
    const sessions = this.sessionManager.getSessionList();
    const msg = {
      type: 'session_list',
      deviceId: this.authInfo?.deviceId ?? '',
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload: { sessions },
    };
    this.sendUnicastTo(targetDeviceId, compactPubKey, msg);
  }

  /**
   * Broadcast session_list to all connected apps (used on auth_ok).
   */
  private broadcastSessionList(): void {
    const sessions = this.sessionManager.getSessionList();
    this.sendEncrypted({
      type: 'session_list',
      deviceId: this.authInfo?.deviceId ?? '',
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload: { sessions },
    } as ProducerMessage);
  }

  /**
   * Handle a per-session replay request from a reconnecting app.
   */
  private handleSessionReplay(requesterDeviceId: string, sessionId: string, afterSeq: number, limit?: number): void {
    const requesterKey = this.consumerKeys.get(requesterDeviceId);
    if (!requesterKey) {
      logger.warn({ requesterDeviceId }, 'Session replay requested but no encryption key for requester');
      return;
    }

    const logged = this.sessionManager.getMessagesAfterSeq(sessionId, afterSeq, limit);
    logger.info({ requesterDeviceId, sessionId, afterSeq, limit, count: logged.length }, 'Replaying session messages (batch)');

    // Parse logged messages into ProducerMessage objects.
    // Filter out transient types that may exist in older logs — they don't
    // belong in the content stream and would create seq gaps on the arm.
    const parsed: Array<Record<string, unknown>> = [];
    for (const entry of logged) {
      if (RelayClient.TRANSIENT_TYPES.has(entry.type)) continue;
      try {
        const msg = JSON.parse(entry.payload);
        msg.seq = entry.seq;
        parsed.push(msg);
      } catch {
        logger.warn({ seq: entry.seq, sessionId }, 'Failed to parse session message for batch');
      }
    }

    const replayedLastSeq = logged.length > 0 ? logged[logged.length - 1].seq : afterSeq;
    const meta = this.sessionManager.getMeta(sessionId);

    const batchMsg = {
      type: 'session_replay_batch',
      deviceId: this.authInfo?.deviceId ?? '',
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId,
        messages: parsed,
        lastSeq: replayedLastSeq,
        totalLastSeq: meta?.lastSeq ?? replayedLastSeq,
      },
    };
    this.sendUnicastTo(requesterDeviceId, requesterKey, batchMsg);
  }

  // ── Client log shipping ─────────────────────────────

  /**
   * Write web app debug logs to a local file.
   */
  private handleClientLog(deviceId: string, entries: Array<{ ts: string; level: string; scope: string; message: string }> | undefined): void {
    if (!entries || entries.length === 0) return;
    try {
      const logPath = join(getKrakiHome(), 'logs', 'web-client.log');
      const lines = entries.map(e => `${e.ts} [${deviceId}] [${e.level}:${e.scope}] ${e.message}`).join('\n') + '\n';
      appendFileSync(logPath, lines, 'utf8');
    } catch {
      // Ignore write errors
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

    // Log message to per-session store for replay.
    // Skip transient types that are redundant for state reconstruction.
    // Metadata messages (title, model, pin, read) are synced via session_list
    // on reconnect and don't need per-session seq or replay logging.
    const type = enriched.type as string;
    const sessionId = enriched.sessionId as string | undefined;
    if (sessionId && !RelayClient.TRANSIENT_TYPES.has(type)) {
      enriched.seq = this.sessionManager.appendMessage(sessionId, type, JSON.stringify(enriched));
    }

    if (this.keyManager) {
      if (this.consumerKeys.size === 0) {
        // No consumers online — queue (bounded to prevent memory growth)
        if (this.pendingE2eQueue.length < 1000) {
          this.pendingE2eQueue.push(msg);
        } else {
          logger.warn({ type: (msg as Partial<ProducerMessage>).type }, 'E2E queue full (1000) — dropping message');
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
      try {
        recipients.push({ deviceId, publicKey: importPublicKey(compactKey) });
      } catch (err) {
        logger.warn({ err, deviceId }, 'Skipping device with invalid public key');
      }
    }
    if (recipients.length === 0) return;

    try {
      const plaintext = JSON.stringify(msg);
      const { blob, keys } = encryptToBlob(plaintext, recipients);

      const envelope: BroadcastEnvelope = {
        type: 'broadcast',
        blob,
        keys,
      };

      // Track last agent message for idle push preview
      if (msg.type === 'agent_message' && msg.sessionId) {
        const content = (msg.payload as Record<string, unknown>).content as string;
        if (content) this.lastAgentContent.set(msg.sessionId as string, content);
      }

      // Build encrypted push preview for notification-worthy messages
      let previewSummary: string | undefined;
      if (msg.type === 'permission') {
        previewSummary = (msg.payload as Record<string, unknown>).description as string;
      } else if (msg.type === 'question') {
        previewSummary = (msg.payload as Record<string, unknown>).question as string;
      } else if (msg.type === 'idle') {
        previewSummary = this.lastAgentContent.get(msg.sessionId as string);
      }

      if (previewSummary) {
        const preview = JSON.stringify({ type: msg.type, summary: previewSummary.slice(0, 50) });
        const previewBlob = encryptToBlob(preview, recipients);
        envelope.pushPreview = { blob: previewBlob.blob, keys: previewBlob.keys };
      }

      this.ws.send(JSON.stringify(envelope));
    } catch (err) {
      logger.error({ err }, 'Encrypted broadcast failed');
    }
  }

  /**
   * Encrypt and send a message to a single device as a UnicastEnvelope.
   */
  private sendUnicastTo(targetDeviceId: string, compactPubKey: string, msg: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.keyManager) return;

    try {
      const recipientPubKey = importPublicKey(compactPubKey);
      const plaintext = JSON.stringify(msg);
      const { blob, keys } = encryptToBlob(plaintext, [
        { deviceId: targetDeviceId, publicKey: recipientPubKey },
      ]);

      const envelope: UnicastEnvelope = {
        type: 'unicast',
        to: targetDeviceId,
        blob,
        keys,
      };

      this.ws.send(JSON.stringify(envelope));
    } catch (err) {
      logger.error({ err, targetDeviceId }, 'Encrypted unicast failed');
    }
  }

  /**
   * Broadcast a device_greeting to all connected apps (used on auth_ok).
   */
  private sendGreetingBroadcast(): void {
    this.sendEncrypted({
      type: 'device_greeting',
      deviceId: this.authInfo?.deviceId ?? '',
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload: {
        name: this.options.device.name,
        kind: this.options.device.kind,
        models: this.options.device.capabilities?.models,
        modelDetails: this.options.device.capabilities?.modelDetails,
        version: this.options.version,
      },
    } as ProducerMessage);
  }

  /**
   * Send a device_greeting unicast to a newly joined app.
   */
  private sendGreetingTo(targetDeviceId: string, compactPubKey: string): void {
    const greeting = {
      type: 'device_greeting',
      deviceId: this.authInfo?.deviceId ?? '',
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload: {
        name: this.options.device.name,
        kind: this.options.device.kind,
        models: this.options.device.capabilities?.models,
        modelDetails: this.options.device.capabilities?.modelDetails,
        version: this.options.version,
      },
    };
    this.sendUnicastTo(targetDeviceId, compactPubKey, greeting);
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

  // ── Title generation scheduling ──────────────────────

  private maybeGenerateTitle(sessionId: string): void {
    const turns = (this.turnCounts.get(sessionId) ?? 0) + 1;
    this.turnCounts.set(sessionId, turns);

    const meta = this.sessionManager.getMeta(sessionId);
    if (!meta) return;

    // Manual title set — skip auto-generation
    if (meta.title) return;

    // Schedule: turn 1, turn 5, then every 20 turns
    const shouldGenerate = turns === 1 || turns === 5
      || (turns > 5 && (turns - 5) % 20 === 0);

    logger.debug({ sessionId, turns, shouldGenerate }, 'maybeGenerateTitle check');

    if (!shouldGenerate) return;

    // One generation in flight per session
    if (this.titleGenerationInFlight.has(sessionId)) return;
    this.titleGenerationInFlight.add(sessionId);

    // Read only recent messages — full log is unnecessary for title context
    const lastSeq = meta.lastSeq ?? 0;
    const recentMsgs = this.sessionManager.getMessagesAfterSeq(sessionId, Math.max(0, lastSeq - 20));
    const userMessages: string[] = [];
    for (const m of recentMsgs) {
      try {
        const parsed = JSON.parse(m.payload);
        if (parsed.type === 'user_message' && parsed.payload?.content) {
          userMessages.push(parsed.payload.content);
        }
      } catch { /* skip */ }
    }

    const lastUserMessage = userMessages[userMessages.length - 1] ?? '';
    // For context: last 3 user messages, most recent first
    const recentMessages = userMessages.slice(-3).reverse();
    // Include current auto-title so the LLM can refine rather than regenerate
    const currentTitle = meta.autoTitle;

    logger.debug({ sessionId, turns, lastUserMessage: lastUserMessage.slice(0, 50), totalUserMsgs: userMessages.length }, 'Title generation starting');

    if (!lastUserMessage) {
      this.titleGenerationInFlight.delete(sessionId);
      return;
    }

    this.adapter.generateTitle({
      firstUserMessage: recentMessages[recentMessages.length - 1] ?? lastUserMessage,
      lastUserMessage,
      recentMessages,
      currentTitle,
    })
      .then((title) => {
        if (title) {
          this.sessionManager.setAutoTitle(sessionId, title);
          this.send({
            type: 'session_title_updated',
            sessionId,
            payload: { title: this.sessionManager.getMeta(sessionId)?.title, autoTitle: title },
          });
          logger.info({ sessionId, title, turn: turns }, 'Auto-title generated');
        }
      })
      .catch((err) => {
        logger.warn({ err, sessionId }, 'Title generation failed');
      })
      .finally(() => {
        this.titleGenerationInFlight.delete(sessionId);
      });
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
