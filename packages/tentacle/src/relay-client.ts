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
import { homedir } from 'node:os';
import type {
  ProducerMessage, ConsumerMessage,
  DeviceInfo, AuthOkMessage, AuthErrorMessage, DeviceSummary, AuthMethod,
} from '@kraki/protocol';
import { HEAD_PULSE_TARGET } from '@kraki/protocol';
import { importPublicKey, encryptToBlob, decryptFromBlob, signChallenge } from '@kraki/crypto';
import type { RecipientKey } from '@kraki/crypto';
import type { AgentAdapter } from './adapters/base.js';
import type { SessionManager, SessionContext } from './session-manager.js';
import type { KeyManager } from './key-manager.js';
import { scanLocalSessions, filterSessions } from './session-scanner.js';
import { parseSessionHistory } from './history-parser.js';
import { EventsWatcher } from './events-watcher.js';
import { createLogger } from './logger.js';
import { getKrakiHome } from './config.js';
import { makeHeadline } from './tool-headline.js';
import { TentaclePulse } from './tentacle-pulse.js';

const logger = createLogger('relay-client');

export interface RelayClientOptions {
  /** Relay WebSocket URL (e.g., wss://relay.kraki.chat) */
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
  /** Cached consumer public keys for E2E encryption (includes offline devices for pushPreview) */
  private consumerKeys = new Map<string, string>();
  /** Device IDs of currently connected consumers (for queue decision) */
  private onlineConsumers = new Set<string>();
  /** Messages queued when E2E is enabled but no consumer keys are available yet */
  private pendingE2eQueue: Partial<ProducerMessage>[] = [];
  /** Maps pre-generated sessionId → requestId for concurrent create_session correlation */
  private pendingRequestIds = new Map<string, string>();
  /** Message types that write to events.jsonl and should be persisted to messages.jsonl.
   *  New types default to NOT persisting/pausing the watcher — safer than the inverse. */
  private static readonly PERSISTENT_TYPES = new Set([
    'session_created',
    'agent_message',
    'user_message',
    'permission',
    'permission_resolved',
    'question',
    'question_resolved',
    'tool_start',
    'tool_complete',
    'error',
    'session_ended',
    'idle',
  ]);
  /** Global seq counter for envelope ordering (not used for replay — per-session seq handles that). */
  private seqCounter = 0;
  private legacyReplayWarned = new Set<string>();
  /** Prefer challenge auth when the relay already knows this device */
  private preferChallengeAuth = true;

  // ── Title generation state ──────────────────────────
  /** Turn count per session (for title generation scheduling) */
  private turnCounts = new Map<string, number>();
  /** Sessions currently generating a title (prevent concurrent generation) */
  private titleGenerationInFlight = new Set<string>();

  // ── Lazy resume state ──────────────────────────────
  /** In-flight `ensureSessionResumed` promises keyed by sessionId, so two
   *  concurrent callers don't double-resume the same SDK session. */
  private resumeInFlight = new Map<string, Promise<boolean>>();

  // ── Push preview state ─────────────────────────────
  /** Last agent message content per session (for idle push preview) */
  private lastAgentContent = new Map<string, string>();
  /** Push preview to attach to the next pulse broadcast envelope (set just
   *  before pulse.send for a notification-worthy message, consumed by
   *  sendPulseEnvelope). */
  private pendingPushPreview: { blob: string; keys: Record<string, string> } | undefined;

  // ── Streaming delta debounce ───────────────────────
  // Each agent_message_delta otherwise triggers a full hybrid encryption
  // (sync RSA-4096 wrap per recipient + AES-GCM) on the JS main thread.
  // Coalescing a short window of token-sized deltas into one merged
  // payload roughly drops main-thread crypto work proportionally without
  // changing the on-the-wire content seen by arms.
  private static readonly DELTA_DEBOUNCE_MS = 40;
  private deltaBuffers = new Map<string, { content: string; timer: ReturnType<typeof setTimeout> }>();
  /** Sessions currently inside flushDelta — prevents the recursive send()
   *  from re-buffering the already-merged delta. */
  private flushingDeltas = new Set<string>();

  // Stale connection detection — tracks last incoming message to detect sleep/network changes
  private lastActivityAt = 0;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** Tick instrumentation: last time the staleCheck callback ran (ms epoch).
   *  Used to detect timer drift / event-loop block. 0 = first tick. */
  private staleCheckLastTickAt = 0;
  /** How long without any activity before we consider the connection stale (ms).
   *  Must be < relay's PING_INTERVAL * 2 (60s) so we reconnect first, instead
   *  of being killed by the relay's slower stale-detection. Tentacle-initiated
   *  reconnects take ~3s vs ~10s for relay-kill→close-frame→reconnect. */
  private static readonly STALE_THRESHOLD = 45_000;
  /** How often to check for stale connection (ms) */
  private static readonly STALE_CHECK_INTERVAL = 5_000;

  /** Called when relay state changes */
  onStateChange: ((state: RelayClientState) => void) | null = null;
  /** Called on auth success */
  onAuthenticated: ((info: AuthOkMessage) => void) | null = null;
  /** Called on fatal error (won't reconnect) */
  onFatalError: ((message: string) => void) | null = null;

  /** Watches imported sessions' events.jsonl for external changes */
  private eventsWatcher: EventsWatcher | null = null;

  constructor(
    adapter: AgentAdapter,
    sessionManager: SessionManager,
    options: RelayClientOptions,
    keyManager?: KeyManager | null,
    attachmentStore?: import('./attachment-store.js').AttachmentStore,
  ) {
    this.adapter = adapter;
    this.sessionManager = sessionManager;
    this.options = options;
    this.keyManager = keyManager ?? null;
    this.attachmentStore = attachmentStore;
    // Per-hop pulse endpoint to the relay — the reliable-delivery layer.
    this.pulse = new TentaclePulse(
      {
        now: () => Date.now(),
        sendPulseFrame: (pulseB64, targetDeviceId) => this.sendPulseEnvelope(pulseB64, targetDeviceId),
        onDelivered: (blobB64) => this.handlePulseDelivered(blobB64),
      },
      `tentacle:${options.device.deviceId ?? 'local'}:${Date.now()}`,
    );
    this.wireAdapterEvents();
  }

  private readonly pulse: TentaclePulse;

  private readonly attachmentStore?: import('./attachment-store.js').AttachmentStore;

  /** Track attachment ids already broadcast per session — prevents double-push
   *  if the agent calls show_image twice with the same image bytes. The
   *  receiving devices still see the ref each time (so the chat history is
   *  correct); they just don't get a redundant byte broadcast. */
  private broadcastedAttachmentIds = new Map<string, Set<string>>();

  /** Inline floor for offloading args. Below this we don't bother creating
   *  a ContentRef + chunk push — the round-trip overhead would exceed the
   *  bytes saved. Above it we always offload. */
  private static readonly ARGS_INLINE_FLOOR = 256;

  /** Stash args (and the matching argsRef if we created one) at tool_start
   *  so tool_complete can recompute the headline and carry the same argsRef
   *  forward. Keyed by toolCallId. Cleaned on complete OR on session end. */
  private lastArgsByToolCallId = new Map<string, Record<string, unknown>>();
  private lastArgsRefByToolCallId = new Map<string, import('@kraki/protocol').ContentRef>();
  /** Reverse index of in-flight toolCallIds per session — so we can purge
   *  the two `lastArgs*` maps when a session ends with tool calls that
   *  never received a matching `tool_complete`. Without this, the toolCallId-
   *  keyed maps leak entries permanently (Phase 1 had the identical issue
   *  in the Copilot adapter; same fix here). */
  private sessionToolCallIds = new Map<string, Set<string>>();

  /** Build a ContentRef for the args JSON if the serialized size exceeds the
   *  inline floor. Returns undefined when args are trivially small. */
  private offloadArgs(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
  ): import('@kraki/protocol').ContentRef | undefined {
    if (!this.attachmentStore || !args) return undefined;
    let serialized: string;
    try {
      serialized = JSON.stringify(args);
    } catch {
      return undefined;
    }
    if (serialized.length < RelayClient.ARGS_INLINE_FLOOR) return undefined;
    try {
      const ref = this.attachmentStore.put(
        sessionId,
        Buffer.from(serialized, 'utf-8'),
        'application/json',
        { name: `${toolName}.args.json` },
      );
      return ref;
    } catch (err) {
      logger.warn({ err, sessionId, toolName }, 'failed to offload args');
      return undefined;
    }
  }

  /** Build a ContentRef for the tool result body. All non-empty results are
   *  offloaded (uniform lazy treatment — the wire shape stays predictable). */
  private offloadResult(
    sessionId: string,
    toolName: string,
    result: string | undefined,
  ): import('@kraki/protocol').ContentRef | undefined {
    if (!this.attachmentStore || !result) return undefined;
    try {
      const ref = this.attachmentStore.put(
        sessionId,
        Buffer.from(result, 'utf-8'),
        'text/plain',
        { name: `${toolName}.result.txt` },
      );
      return ref;
    } catch (err) {
      logger.warn({ err, sessionId, toolName }, 'failed to offload result');
      return undefined;
    }
  }

  /** Drop any in-flight toolCallId state for a session — called when a
   *  session ends or is deleted. Without this, the toolCallId-keyed
   *  `lastArgs*` maps would leak entries for any tool call that didn't
   *  receive a matching `tool_complete` before the session went away. */
  private purgeSessionToolState(sessionId: string): void {
    const inflight = this.sessionToolCallIds.get(sessionId);
    if (!inflight) return;
    for (const id of inflight) {
      this.lastArgsByToolCallId.delete(id);
      this.lastArgsRefByToolCallId.delete(id);
    }
    this.sessionToolCallIds.delete(sessionId);
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

    ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason?.toString?.() || '';
      this.stopStaleCheck();
      this.ws = null;
      logger.info({ code, reason: reasonStr, intentional: this.intentionalDisconnect }, 'WS closed');
      this.setState('disconnected');
      this.pulse.onDisconnected();
      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err: Error) => {
      logger.warn({ err: err?.message, code: (err as NodeJS.ErrnoException)?.code }, 'WS error');
      // Error triggers close, which handles reconnect
    });

    // Track any incoming frames as activity for stale detection
    ws.on('ping', () => {
      this.lastActivityAt = Date.now();
      logger.debug('Received WS ping from relay');
    });

    ws.on('pong', () => {
      logger.debug('Received WS pong from relay');
    });
  }

  /**
   * Disconnect from the relay. No reconnect.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.stopStaleCheck();
    this.clearAllDeltaTimers();
    if (this.eventsWatcher) {
      this.eventsWatcher.close();
      this.eventsWatcher = null;
    }
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
      // Bring up the pulse endpoint to the relay (resume the stream).
      this.pulse.onConnected();
      // Initialize events watcher for imported sessions
      this.initEventsWatcher();
      this.resumeDisconnectedSessions();
      this.sendGreetingBroadcast();
      this.broadcastSessionList();
      return;
    }

    if (msg.type === 'auth_error') {
      const authError = msg as unknown as AuthErrorMessage;
      if (authError.code === 'wrong_region' && authError.redirect) {
        logger.info({ to: authError.redirect }, 'Relay requested reconnect to assigned region');
        this.options.relayUrl = authError.redirect;
        this.ws?.close();
        return;
      }
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
      logger.debug('Received JSON pong from relay');
      return;
    }

    if (msg.type === 'ping') {
      logger.debug('Received JSON ping from relay');
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'pong' }));
        logger.debug('Sent JSON pong to relay');
      } else {
        logger.warn({ readyState: this.ws?.readyState }, 'Could not pong — WS not open');
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
          this.onlineConsumers.add(device.id);
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
      this.onlineConsumers.delete(deviceId);
      // Keep consumerKeys — offline devices still need pushPreview encrypted for them.
      return;
    }

    if (msg.type === 'device_removed') {
      const deviceId = msg.deviceId as string;
      this.consumerKeys.delete(deviceId);
      this.onlineConsumers.delete(deviceId);
      return;
    }

    // Incoming encrypted messages from apps — decrypt and handle inner message
    if ((msg.type === 'unicast' || msg.type === 'broadcast') && this.keyManager && this.authInfo) {
      // Pulse-framed? Feed the frame to our endpoint; a `deliver` will call
      // handlePulseDelivered with the {blob,keys} payload to decrypt.
      if (typeof msg.pulse === 'string') {
        this.pulse.onFrame(msg.pulse as string);
        return;
      }
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

    // request_session_messages — turn-aware paginated replay
    if (msg.type === 'request_session_messages') {
      this.handleSessionMessages(msg.deviceId, msg.payload.sessionId, msg.payload.beforeSeq);
      return;
    }

    // request_session_messages_range — exact seq-range fetch (gap recovery, range queries)
    if (msg.type === 'request_session_messages_range') {
      this.handleSessionMessagesRange(msg.deviceId, msg.payload.sessionId, msg.payload.fromSeq, msg.payload.toSeq);
      return;
    }

    // request_replay — replay buffered messages to the requesting device
    // request_session_replay — replay buffered messages for a specific session
    if (msg.type === 'request_session_replay') {
      if (!this.legacyReplayWarned.has(msg.deviceId)) {
        this.legacyReplayWarned.add(msg.deviceId);
        logger.warn({ deviceId: msg.deviceId, sessionId: msg.payload.sessionId }, 'Arm using deprecated request_session_replay — should migrate to request_session_messages');
      }
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

    // ── Local session sync (no sessionId) ────────────────
    if (msg.type === 'request_local_sessions') {
      this.handleRequestLocalSessions(msg);
      return;
    }
    if (msg.type === 'import_session') {
      this.handleImportSession(msg);
      return;
    }

    if (msg.type === 'request_attachment') {
      this.handleRequestAttachment(msg).catch((err) => {
        logger.warn({ err, attachmentId: msg.payload?.id }, 'request_attachment failed');
      });
      return;
    }

    const sessionId = msg.sessionId;
    if (!sessionId) return;

    try {
      switch (msg.type) {
        case 'send_input':
          // Broadcast user_message back to apps (round-trip confirmation).
          // Echo the optional `clientId` so the originating client can
          // correlate this broadcast with its optimistic pending_input
          // placeholder (see UserMessage.payload.clientId).
          this.send({
            type: 'user_message',
            sessionId,
            payload: {
              content: msg.payload.text,
              ...(msg.payload.attachments?.length && { attachments: msg.payload.attachments }),
              ...(msg.payload.clientId && { clientId: msg.payload.clientId }),
            },
          });
          this.send({ type: 'active', sessionId, payload: {} });
          // Lazy resume must run BEFORE markActive — otherwise the meta flip
          // from disconnected → active defeats ensureSessionResumed's state
          // gate, sessions never get loaded, and every send fails with
          // "Session not found". (Regression discovered post-v0.21.1.)
          this.ensureSessionResumed(sessionId)
            .then(() => {
              this.sessionManager.markActive(sessionId);
              return this.adapter.sendMessage(sessionId, msg.payload.text, msg.payload.attachments);
            })
            .catch((err) => {
              logger.error({ err, sessionId }, 'sendMessage failed');
              this.send({ type: 'error', sessionId, payload: { message: `Failed to deliver message: ${(err as Error).message}` } });
            });
          break;
        case 'approve':
          // Broadcast the resolution only AFTER the adapter actually applies it,
          // so arms are never told "approved" for a permission that failed /
          // already timed out. (Adapter no-ops on an unknown/resolved id, so a
          // pulse resend is safe.)
          this.adapter.respondToPermission(sessionId, msg.payload.permissionId, 'approve')
            .then(() => {
              this.send({ type: 'permission_resolved', sessionId, payload: { permissionId: msg.payload.permissionId, resolution: 'approved' } });
            })
            .catch((err) => {
              logger.error({ err, sessionId }, 'respondToPermission failed');
              this.send({ type: 'error', sessionId, payload: { message: `Failed to approve permission: ${(err as Error).message}` } });
            });
          break;
        case 'deny':
          this.adapter.respondToPermission(sessionId, msg.payload.permissionId, 'deny')
            .then(() => {
              this.send({ type: 'permission_resolved', sessionId, payload: { permissionId: msg.payload.permissionId, resolution: 'denied' } });
            })
            .catch((err) => {
              logger.error({ err, sessionId }, 'respondToPermission failed');
              this.send({ type: 'error', sessionId, payload: { message: `Failed to deny permission: ${(err as Error).message}` } });
            });
          break;
        case 'always_allow':
          this.adapter.respondToPermission(sessionId, msg.payload.permissionId, 'always_allow')
            .then(() => {
              this.send({ type: 'permission_resolved', sessionId, payload: { permissionId: msg.payload.permissionId, resolution: 'always_allowed' } });
            })
            .catch((err) => {
              logger.error({ err, sessionId }, 'respondToPermission failed');
              this.send({ type: 'error', sessionId, payload: { message: `Failed to set always-allow: ${(err as Error).message}` } });
            });
          break;
        case 'answer':
          this.adapter.respondToQuestion(sessionId, msg.payload.questionId, msg.payload.answer, msg.payload.wasFreeform ?? false)
            .then(() => {
              this.send({ type: 'question_resolved', sessionId, payload: { questionId: msg.payload.questionId, answer: msg.payload.answer } });
            })
            .catch((err) => {
              logger.error({ err, sessionId }, 'respondToQuestion failed');
              this.send({ type: 'error', sessionId, payload: { message: `Failed to deliver answer: ${(err as Error).message}` } });
            });
          break;
        case 'kill_session':
          this.adapter.killSession(sessionId)
            .catch((err) => logger.error({ err, sessionId }, 'killSession failed'));
          break;
        case 'abort_session':
          this.adapter.abortSession(sessionId)
            .then(() => {
              this.sessionManager.markIdle(sessionId);
              this.send({ type: 'idle', sessionId, payload: { reason: 'aborted' } });
            })
            .catch((err) => {
              logger.error({ err, sessionId }, 'abortSession failed');
              this.send({ type: 'error', sessionId, payload: { message: `Failed to abort session: ${(err as Error).message}` } });
            });
          break;
        case 'delete_session':
          // Remove from local session state SYNCHRONOUSLY. The adapter's
          // killSession runs async and may take a while to talk to the
          // Copilot SDK; we don't want broadcastSessionList to see
          // the still-tracked session and broadcast it back to arms.
          this.sessionManager.removeLinkByKrakiId(sessionId);
          this.sessionManager.deleteSession(sessionId);
          this.lastAgentContent.delete(sessionId);
          this.purgeSessionToolState(sessionId);
          this.broadcastedAttachmentIds.delete(sessionId);
          this.send({ type: 'session_deleted', sessionId, payload: {} });
          this.eventsWatcher?.unwatch(sessionId);
          this.adapter.killSession(sessionId)
            .catch((err) => logger.error({ err, sessionId }, 'killSession on delete failed'));
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
          const { model, reasoningEffort, contextTier } = msg.payload;
          // Persist + ack immediately so the choice survives even if the
          // session is currently disconnected and lazy-resume fails.
          this.sessionManager.setModel(sessionId, model);
          this.send({
            type: 'session_model_set',
            sessionId,
            payload: { model, reasoningEffort, contextTier },
          });
          // Lazy resume: ensure the SDK session is live before pushing the
          // new model into it; otherwise the adapter would silently drop it
          // (and the user's selection would be lost on next interaction).
          this.ensureSessionResumed(sessionId)
            .then(() => this.adapter.setSessionModel(sessionId, model, reasoningEffort, contextTier))
            .catch((err) => {
              logger.error({ err, sessionId }, 'setSessionModel failed');
              this.send({ type: 'error', sessionId, payload: { message: `Failed to change model: ${(err as Error).message}` } });
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
    const { model, reasoningEffort, contextTier, cwd, prompt, requestId, agentId } = msg.payload;

    // Pre-generate a stable sessionId and map requestId BEFORE calling the adapter.
    // This is concurrency-safe: each request gets its own unique key.
    const preSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (requestId) {
      this.pendingRequestIds.set(preSessionId, requestId);
    }

    try {
      const result = await this.adapter.createSession({ model, reasoningEffort, contextTier, cwd: cwd || '/', sessionId: preSessionId, agentId });

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

  // ── Local session sync handlers ───────────────────────

  private handleRequestLocalSessions(msg: ConsumerMessage): void {
    if (msg.type !== 'request_local_sessions') return;

    const { requestId, filter } = msg.payload;
    const requesterDeviceId = msg.deviceId;
    const requesterKey = this.consumerKeys.get(requesterDeviceId);

    try {
      let sessions = scanLocalSessions();
      const linkedIds = this.sessionManager.getLinkedIds();

      // Mark sessions that are already linked
      for (const s of sessions) {
        const link = this.sessionManager.getLink(s.sessionId);
        if (link) s.linkedKrakiSessionId = link.krakiSessionId;
      }

      // Exclude sessions that Kraki manages (natively created or imported)
      const krakiSessionIds = new Set(this.sessionManager.getSessionList().map(s => s.id));
      sessions = sessions.filter(s => !krakiSessionIds.has(s.sessionId) || s.linkedKrakiSessionId);

      // Apply filters
      if (filter) {
        sessions = filterSessions(sessions, filter, linkedIds);
      }

      const response = {
        type: 'local_sessions_list',
        deviceId: this.authInfo?.deviceId ?? '',
        seq: ++this.seqCounter,
        timestamp: new Date().toISOString(),
        payload: { sessions, requestId },
      };

      if (requesterKey) {
        this.sendReliableUnicastTo(requesterDeviceId, requesterKey, response);
      } else {
        // No encryption key — broadcast (works in open/non-E2E mode)
        this.send(response as Partial<ProducerMessage>);
      }

      logger.debug({ count: sessions.length, requestId }, 'Sent local sessions list');
    } catch (err) {
      logger.error({ err }, 'Failed to scan local sessions');
      const response = {
        type: 'local_sessions_list',
        deviceId: this.authInfo?.deviceId ?? '',
        seq: ++this.seqCounter,
        timestamp: new Date().toISOString(),
        payload: { sessions: [], requestId },
      };

      if (requesterKey) {
        this.sendReliableUnicastTo(requesterDeviceId, requesterKey, response);
      } else {
        this.send(response as Partial<ProducerMessage>);
      }
    }
  }

  private async handleImportSession(msg: ConsumerMessage): Promise<void> {
    if (msg.type !== 'import_session') return;

    const { requestId, localSessionId, meta: clientMeta } = msg.payload as {
      requestId: string;
      localSessionId: string;
      meta?: { cwd?: string; summary?: string; source?: string; model?: string; branch?: string; startTime?: string };
    };

    // Check if already linked
    const existing = this.sessionManager.getLink(localSessionId);
    if (existing) {
      this.send({
        type: 'error',
        sessionId: '',
        payload: { message: `Session already imported as ${existing.krakiSessionId} (requestId: ${requestId})` },
      });
      return;
    }

    try {
      const krakiSessionId = localSessionId;

      // ── Phase 1: Prepare locally (~85ms) ──────────────────
      // Parse events.jsonl for backfill + metadata
      const sessionStateDir = join(homedir(), '.copilot', 'session-state', localSessionId);
      const { messages: backfilledMessages, meta: parsedMeta } = parseSessionHistory(sessionStateDir);

      // Use metadata from the client (picker already has it) or parsed fallback
      const source: import('@kraki/protocol').LocalSessionSource = clientMeta?.source as import('@kraki/protocol').LocalSessionSource ?? 'copilot-cli';
      const model = parsedMeta.model ?? clientMeta?.model;
      const autoTitle = clientMeta?.summary?.slice(0, 100);
      const cwd = clientMeta?.cwd ?? parsedMeta.cwd ?? '/';

      // Create Kraki session
      this.sessionManager.createSession('copilot', model, krakiSessionId);

      // Persist metadata
      this.sessionManager.updateMeta(krakiSessionId, {
        source,
        autoTitle,
        model,
        createdAt: clientMeta?.startTime,
      });

      // Batch-write all backfilled messages (single write instead of N appends)
      const lastSeq = this.sessionManager.appendMessagesBatch(krakiSessionId, backfilledMessages);

      // Write link table entry
      this.sessionManager.addLink({
        localSessionId,
        krakiSessionId,
        source,
        cwd,
        branch: clientMeta?.branch,
        linkedAt: new Date().toISOString(),
      });

      // ── Phase 2: Resume adapter (blocking) ────────────────
      // Clear the requestId so onSessionCreated doesn't send a duplicate session_created
      if (requestId) this.pendingRequestIds.delete(krakiSessionId);

      let adapterFailed = false;
      try {
        await this.adapter.createSession({ sessionId: krakiSessionId, model: parsedMeta.model, cwd });
      } catch (err) {
        adapterFailed = true;
        logger.warn({ err: (err as Error).message, krakiSessionId }, 'SDK resume failed — session imported as read-only');
      }

      // ── Phase 3: Broadcast to arms ────────────────────────
      // session_created = session is fully ready (or at least browsable)
      this.send({
        type: 'session_created',
        sessionId: krakiSessionId,
        payload: { agent: 'copilot', model, requestId, lastSeq },
      });

      // Send title
      if (autoTitle) {
        this.send({
          type: 'session_title_updated',
          sessionId: krakiSessionId,
          payload: { autoTitle },
        });
      }

      // Send backfilled history as replay batch
      if (backfilledMessages.length > 0) {
        const replayMessages = this.sessionManager.getMessagesAfterSeq(krakiSessionId, 0, 500);
        const asProducerMessages = replayMessages.map(m => {
          try {
            const payload = JSON.parse(m.payload);
            return { type: m.type, seq: m.seq, timestamp: m.ts, sessionId: krakiSessionId, deviceId: this.authInfo?.deviceId ?? '', payload } as unknown as import('@kraki/protocol').ProducerMessage;
          } catch { return null; }
        }).filter((m): m is import('@kraki/protocol').ProducerMessage => m !== null);

        this.send({
          type: 'session_replay_batch',
          sessionId: krakiSessionId,
          payload: {
            sessionId: krakiSessionId,
            messages: asProducerMessages,
            lastSeq,
            totalLastSeq: lastSeq,
          },
        });
      }

      // Notify user if adapter failed — session is browsable but not interactive
      if (adapterFailed) {
        this.send({
          type: 'error',
          sessionId: krakiSessionId,
          payload: { message: 'Session imported but could not connect to agent — history is browsable, but new messages will not work.' },
        });
      }

      // Mark idle + broadcast session list
      this.sessionManager.markIdle(krakiSessionId);
      this.send({ type: 'idle', sessionId: krakiSessionId, payload: {} });
      this.broadcastSessionList();

      logger.info({ localSessionId, krakiSessionId, backfilled: backfilledMessages.length, adapterFailed }, 'Session imported');

      // Start watching events.jsonl for external changes (CLI, VS Code)
      this.eventsWatcher?.watch(krakiSessionId);

    } catch (err) {
      logger.error({ err, localSessionId }, 'Import session failed');
      this.send({
        type: 'error',
        sessionId: localSessionId,
        payload: { message: `Failed to import session: ${(err as Error).message} (requestId: ${requestId})` },
      });
    }
  }

  // ── Events watcher for imported sessions ──────────────

  private initEventsWatcher(): void {
    if (this.eventsWatcher) this.eventsWatcher.close();

    this.eventsWatcher = new EventsWatcher(
      (msg) => {
        // Broadcast external events to all arms + append to SessionManager
        const sessionId = msg.sessionId;
        this.sessionManager.appendMessage(sessionId, msg.type, JSON.stringify(msg.payload));
        this.send({
          ...msg,
          deviceId: this.authInfo?.deviceId ?? '',
        } as unknown as Partial<ProducerMessage>);
      },
      this.authInfo?.deviceId ?? '',
    );

    // Start watching all currently linked sessions
    for (const link of this.sessionManager.getAllLinks()) {
      this.eventsWatcher.watch(link.localSessionId);
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

      // Skip duplicate broadcast for imported sessions — handleImportSession
      // already sent session_created and cleared the requestId.
      if (!requestId && this.sessionManager.getLink(event.sessionId)) {
        return;
      }

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
      const headline = makeHeadline(event.toolName, event.args);
      const argsRef = this.offloadArgs(sessionId, event.toolName, event.args);
      // Ship args inline when below the offload floor so clients always have source data
      const inlineArgs = !argsRef && event.args ? event.args : undefined;
      if (event.toolCallId) {
        this.lastArgsByToolCallId.set(event.toolCallId, event.args ?? {});
        if (argsRef) this.lastArgsRefByToolCallId.set(event.toolCallId, argsRef);
        let inflight = this.sessionToolCallIds.get(sessionId);
        if (!inflight) {
          inflight = new Set();
          this.sessionToolCallIds.set(sessionId, inflight);
        }
        inflight.add(event.toolCallId);
      }
      this.send({
        type: 'tool_start',
        sessionId,
        payload: {
          toolName: event.toolName,
          headline,
          ...(argsRef && { argsRef }),
          ...(inlineArgs && { args: inlineArgs }),
          toolCallId: event.toolCallId,
        },
      });
      if (argsRef) {
        this.broadcastAttachmentBytes(sessionId, argsRef).catch((err) => {
          logger.warn({ err, sessionId, attachmentId: argsRef.id }, 'failed to broadcast args bytes');
        });
      }
      // Track key files from tool usage
      if (event.toolName === 'read_file' || event.toolName === 'write_file' || event.toolName === 'view' ||
          event.toolName === 'edit' || event.toolName === 'create') {
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
      // Recompute headline from the args we stashed at start; falls back to
      // toolName if args aren't available.
      const stashedArgs = this.lastArgsByToolCallId.get(event.toolCallId ?? '');
      const headline = makeHeadline(event.toolName, stashedArgs ?? {});
      const resultRef = this.offloadResult(sessionId, event.toolName, event.result);
      const argsRef = this.lastArgsRefByToolCallId.get(event.toolCallId ?? '');
      // Ship stashed args inline when below the offload floor
      const inlineArgs = !argsRef && stashedArgs && Object.keys(stashedArgs).length > 0 ? stashedArgs : undefined;
      if (event.toolCallId) {
        this.lastArgsByToolCallId.delete(event.toolCallId);
        this.lastArgsRefByToolCallId.delete(event.toolCallId);
        const inflight = this.sessionToolCallIds.get(sessionId);
        if (inflight) {
          inflight.delete(event.toolCallId);
          if (inflight.size === 0) this.sessionToolCallIds.delete(sessionId);
        }
      }
      this.send({
        type: 'tool_complete',
        sessionId,
        payload: {
          toolName: event.toolName,
          headline,
          ...(resultRef && { resultRef }),
          ...(argsRef && { argsRef }),
          ...(inlineArgs && { args: inlineArgs }),
          toolCallId: event.toolCallId,
          ...(event.success === false && { success: false }),
          ...(event.attachments?.length && { attachments: event.attachments }),
        },
      });
      if (resultRef) {
        this.broadcastAttachmentBytes(sessionId, resultRef).catch((err) => {
          logger.warn({ err, sessionId, attachmentId: resultRef.id }, 'failed to broadcast result bytes');
        });
      }
    };

    this.adapter.onAttachmentBytes = (sessionId, event) => {
      // Fire-and-forget — chunks are streamed from disk and pushed via the
      // normal broadcast queue. We deliberately don't block onToolComplete
      // on chunk delivery; both events ride the same WS queue so ordering
      // (ref-first, chunks-after) is preserved naturally.
      for (const ref of event.refs) {
        this.broadcastAttachmentBytes(sessionId, ref).catch((err) => {
          logger.warn({ err, sessionId, attachmentId: ref.id }, 'failed to broadcast attachment bytes');
        });
      }
    };

    this.adapter.onIdle = (sessionId) => {
      this.sessionManager.markIdle(sessionId);
      const usage = this.adapter.getSessionUsage(sessionId) ?? undefined;
      if (usage) this.sessionManager.setUsage(sessionId, usage);
      this.send({ type: 'idle', sessionId, payload: { usage } });
      this.maybeGenerateTitle(sessionId);
    };

    this.adapter.onFlushComplete = (sessionId) => {
      this.eventsWatcher?.resume(sessionId);
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
      this.purgeSessionToolState(sessionId);
      this.broadcastedAttachmentIds.delete(sessionId);
      this.send({
        type: 'session_ended',
        sessionId,
        payload: { reason: event.reason },
      });
    };

    // Idle-session eviction: keep meta state consistent with runtime load-
    // state by marking the session `disconnected` on eviction. No arm
    // broadcast — load-state is internal; the next user interaction goes
    // through ensureSessionResumed and lazy-loads transparently.
    this.adapter.onSessionEvicted = (sessionId) => {
      this.sessionManager.markDisconnected(sessionId);
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

  /**
   * On startup, sessions remain `disconnected` on disk — they are NOT eagerly
   * loaded into the runtime. Instead, each session is lazily resumed on first
   * user interaction via {@link ensureSessionResumed}. This avoids the O(N)
   * memory cost of loading every historical session into the runtime process.
   *
   * We force-normalise any sessions still in `active`/`idle` state from a
   * previous (possibly un-graceful) daemon exit to `disconnected`, restoring
   * the invariant "active/idle == loaded in the runtime". Without this, a
   * leftover `active` state from a crash would make ensureSessionResumed
   * skip resume (because state ≠ 'disconnected') even though the runtime
   * has no handle for the session.
   */
  private async resumeDisconnectedSessions(): Promise<void> {
    const resumable = this.sessionManager.getResumableSessions();
    let normalised = 0;
    for (const meta of resumable) {
      // Pre-register agent mapping so message routing works BEFORE the session
      // is lazy-resumed on first interaction. Without this, any message that
      // arrives before ensureSessionResumed runs (approve/deny/answer/kill/
      // abort/set_session_mode, or the very first send_input on an active/idle
      // meta that skips the lazy-resume gate) hits MultiAgentAdapter with no
      // known agent → falls through to the default (first) adapter → fails
      // with "Session not found" for claude/pi sessions. registerSessionAgent
      // is a no-op on single-agent adapters and idempotent on the multi one.
      this.adapter.registerSessionAgent(meta.id, meta.agent);
      if (meta.state === 'active' || meta.state === 'idle') {
        this.sessionManager.markDisconnected(meta.id);
        normalised++;
      }
    }
    if (resumable.length > 0) {
      logger.info(
        { count: resumable.length, normalised },
        'Sessions available for lazy resume on first interaction',
      );
    }
  }

  /**
   * Ensure a session is loaded into the adapter runtime, resuming it from
   * disk if it is still in `disconnected` state. This is the lazy-resume
   * counterpart to the old eager `resumeDisconnectedSessions` flow.
   *
   * Concurrent calls for the same sessionId share a single in-flight resume
   * so we don't double-resume into the SDK and corrupt the session entry.
   *
   * Returns true if the session was freshly resumed, false if it was already
   * active/idle (or the resume failed).
   */
  private async ensureSessionResumed(sessionId: string): Promise<boolean> {
    const existing = this.resumeInFlight.get(sessionId);
    if (existing) return existing;

    const meta = this.sessionManager.getMeta(sessionId);
    if (!meta || meta.state !== 'disconnected') return false;

    const promise = (async () => {
      try {
        const result = this.sessionManager.resumeSession(sessionId);
        if (!result) return false;
        // Tell the adapter which agent owns this session (for multi-agent routing)
        this.adapter.registerSessionAgent(sessionId, meta.agent);
        await this.adapter.resumeSession(sessionId, result.context);
        // Restore permission mode from persisted meta
        if (meta.mode) {
          this.adapter.setSessionMode(sessionId, meta.mode);
        }
        // Restore the user-selected model on resume. The SDK's session
        // state remembers the last model used for prior turns, but that
        // model may be retired by the time we resume (e.g. after Copilot
        // rotates its model lineup). Pushing kraki's persisted meta.model
        // back into the SDK ensures the next turn uses the model the user
        // intended, not whatever the SDK happened to write last.
        if (meta.model) {
          try {
            await this.adapter.setSessionModel(sessionId, meta.model);
          } catch (err) {
            logger.warn(
              { err, sessionId, model: meta.model },
              'Failed to restore session model on resume — SDK will use its persisted model',
            );
          }
        }
        // Restore persisted usage totals so accumulation continues
        if (meta.usage) {
          this.adapter.setSessionUsage(sessionId, meta.usage);
        }
        logger.info({ sessionId }, 'Session lazily resumed on first interaction');
        return true;
      } catch (err) {
        logger.warn({ err, sessionId }, 'Lazy session resume failed; leaving as disconnected');
        this.sessionManager.markDisconnected(sessionId);
        return false;
      } finally {
        this.resumeInFlight.delete(sessionId);
      }
    })();
    this.resumeInFlight.set(sessionId, promise);
    return promise;
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
    this.sendReliableUnicastTo(targetDeviceId, compactPubKey, msg);
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
      if (!RelayClient.PERSISTENT_TYPES.has(entry.type)) continue;
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
    this.sendReliableUnicastTo(requesterDeviceId, requesterKey, batchMsg);
  }

  /**
   * Handle a turn-aware session messages request.
   */
  private handleSessionMessages(requesterDeviceId: string, sessionId: string, beforeSeq: number | undefined): void {
    const requesterKey = this.consumerKeys.get(requesterDeviceId);
    if (!requesterKey) {
      logger.warn({ requesterDeviceId }, 'Session messages requested but no encryption key for requester');
      return;
    }

    const meta = this.sessionManager.getMeta(sessionId);
    if (!meta) {
      this.sendReliableUnicastTo(requesterDeviceId, requesterKey, {
        type: 'session_messages_batch',
        deviceId: this.authInfo?.deviceId ?? '',
        seq: ++this.seqCounter,
        timestamp: new Date().toISOString(),
        payload: { sessionId, messages: [], firstSeq: 0, lastSeq: 0, containsHead: true },
      });
      return;
    }

    const headSeq = meta.lastSeq ?? 0;
    const endSeqExclusive = beforeSeq ?? headSeq + 1;

    if (endSeqExclusive <= 1) {
      this.sendReliableUnicastTo(requesterDeviceId, requesterKey, {
        type: 'session_messages_batch',
        deviceId: this.authInfo?.deviceId ?? '',
        seq: ++this.seqCounter,
        timestamp: new Date().toISOString(),
        payload: { sessionId, messages: [], firstSeq: 1, lastSeq: 0, containsHead: endSeqExclusive > headSeq },
      });
      return;
    }

    let startSeq = this.sessionManager.findTurnAlignedStart(sessionId, endSeqExclusive);

    const HARD_CAP = 500;
    if (endSeqExclusive - startSeq > HARD_CAP) {
      startSeq = endSeqExclusive - HARD_CAP;
    }

    const endSeqInclusive = endSeqExclusive - 1;
    const logged = this.sessionManager
      .getMessagesAfterSeq(sessionId, startSeq - 1)
      .filter(e => e.seq <= endSeqInclusive);

    const parsed: Array<Record<string, unknown>> = [];
    for (const entry of logged) {
      if (!RelayClient.PERSISTENT_TYPES.has(entry.type)) continue;
      try {
        const msg = JSON.parse(entry.payload);
        msg.seq = entry.seq;
        parsed.push(msg);
      } catch {
        logger.warn({ seq: entry.seq, sessionId }, 'Failed to parse session message for turn-aware batch');
      }
    }

    const batchMsg = {
      type: 'session_messages_batch',
      deviceId: this.authInfo?.deviceId ?? '',
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId,
        messages: parsed,
        firstSeq: parsed.length > 0 ? parsed[0].seq as number : startSeq,
        lastSeq: parsed.length > 0 ? (parsed.at(-1) as Record<string, unknown>).seq as number : startSeq - 1,
        containsHead: endSeqInclusive >= headSeq,
      },
    };
    logger.info(
      { requesterDeviceId, sessionId, beforeSeq, startSeq, endSeqInclusive, count: parsed.length },
      'Replied to turn-aware session messages request',
    );
    this.sendReliableUnicastTo(requesterDeviceId, requesterKey, batchMsg);
  }

  /**
   * Server-side hard cap on messages returned by a single
   * `request_session_messages_range` reply. Defensive backstop —
   * clients should chunk their own requests well below this. When
   * the cap triggers, the reply's `truncated` flag is set.
   */
  private static readonly RANGE_MAX_COUNT = 500;

  /**
   * Handle an exact seq-range messages request.
   *
   * Used for gap recovery (push delivered a seq jump and the arm wants
   * to fill the missing seqs) and for range queries (web's IndexedDB
   * cache filling holes). Distinct from `handleSessionMessages` —
   * range queries are NOT turn-aligned and return exactly the seqs
   * requested, subject to defensive clamping.
   *
   * Robustness contract:
   *  - `fromSeq < 1`     → clamped to 1
   *  - `toSeq > headSeq` → clamped to headSeq (informational, not lossy)
   *  - `fromSeq > toSeq` (post-clamp) → empty batch, truncated=false
   *  - range > `RANGE_MAX_COUNT` → keep newer end, `truncated: true`
   *    so caller can iterate for older seqs
   *  - session not found → empty batch, truncated=false
   */
  private handleSessionMessagesRange(
    requesterDeviceId: string,
    sessionId: string,
    fromSeq: number,
    toSeq: number,
  ): void {
    const requesterKey = this.consumerKeys.get(requesterDeviceId);
    if (!requesterKey) {
      logger.warn({ requesterDeviceId }, 'Session messages range requested but no encryption key for requester');
      return;
    }

    const sendEmpty = (): void => {
      this.sendReliableUnicastTo(requesterDeviceId, requesterKey, {
        type: 'session_messages_range_batch',
        deviceId: this.authInfo?.deviceId ?? '',
        seq: ++this.seqCounter,
        timestamp: new Date().toISOString(),
        payload: { sessionId, messages: [], firstSeq: 0, lastSeq: 0, truncated: false },
      });
    };

    const meta = this.sessionManager.getMeta(sessionId);
    if (!meta) {
      logger.info({ requesterDeviceId, sessionId, fromSeq, toSeq }, 'Range request for unknown session — empty reply');
      sendEmpty();
      return;
    }

    const headSeq = meta.lastSeq ?? 0;

    // Sanitize bounds — never trust client input.
    let lo = Math.max(1, Math.floor(fromSeq));
    let hi = Math.min(headSeq, Math.floor(toSeq));

    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
      logger.info({ requesterDeviceId, sessionId, fromSeq, toSeq, lo, hi, headSeq }, 'Range request empty after clamping');
      sendEmpty();
      return;
    }

    // Server-side hard cap — keep newer end so client can iterate older.
    let truncated = false;
    if (hi - lo + 1 > RelayClient.RANGE_MAX_COUNT) {
      lo = hi - RelayClient.RANGE_MAX_COUNT + 1;
      truncated = true;
    }

    const logged = this.sessionManager
      .getMessagesAfterSeq(sessionId, lo - 1)
      .filter(e => e.seq <= hi);

    const parsed: Array<Record<string, unknown>> = [];
    for (const entry of logged) {
      // Defensive: only PERSISTENT_TYPES ever get a seq, but older logs
      // may contain stragglers. Keep parity with handleSessionMessages.
      if (!RelayClient.PERSISTENT_TYPES.has(entry.type)) continue;
      try {
        const m = JSON.parse(entry.payload);
        m.seq = entry.seq;
        parsed.push(m);
      } catch {
        logger.warn({ seq: entry.seq, sessionId }, 'Failed to parse session message for range batch');
      }
    }

    const batchMsg = {
      type: 'session_messages_range_batch',
      deviceId: this.authInfo?.deviceId ?? '',
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId,
        messages: parsed,
        firstSeq: parsed.length > 0 ? (parsed[0].seq as number) : 0,
        lastSeq: parsed.length > 0 ? ((parsed.at(-1) as Record<string, unknown>).seq as number) : 0,
        truncated,
      },
    };
    logger.info(
      { requesterDeviceId, sessionId, fromSeq, toSeq, lo, hi, headSeq, count: parsed.length, truncated },
      'Replied to range session messages request',
    );
    this.sendReliableUnicastTo(requesterDeviceId, requesterKey, batchMsg);
  }

  // ── Attachment bytes ────────────────────────────────

  /** Plaintext chunk budget for `attachment_data` envelopes.
   *  Stays under the relay's 10 MB frame cap after base64 + envelope. */
  private static readonly ATTACHMENT_CHUNK_BYTES = 2 * 1024 * 1024;

  /**
   * Stream an attachment's bytes to all connected consumers as
   * `attachment_data` chunks. Called immediately after the producer fires
   * a `tool_complete` carrying the matching `ContentRef`. Skipped if
   * we've already broadcast this id within the session.
   */
  private async broadcastAttachmentBytes(
    sessionId: string,
    ref: import('@kraki/protocol').ContentRef,
  ): Promise<void> {
    if (!this.attachmentStore) {
      logger.warn({ sessionId, attachmentId: ref.id }, 'no attachment store — skipping broadcast');
      return;
    }
    let seen = this.broadcastedAttachmentIds.get(sessionId);
    if (!seen) {
      seen = new Set();
      this.broadcastedAttachmentIds.set(sessionId, seen);
    }
    if (seen.has(ref.id)) return;
    seen.add(ref.id);

    const total = Math.max(1, Math.ceil(ref.size / RelayClient.ATTACHMENT_CHUNK_BYTES));
    let index = 0;
    for (const chunk of this.attachmentStore.stream(sessionId, ref.id, RelayClient.ATTACHMENT_CHUNK_BYTES)) {
      this.send({
        type: 'attachment_data',
        sessionId,
        payload: {
          id: ref.id,
          index,
          total,
          mimeType: ref.mimeType,
          data: chunk.toString('base64'),
        },
      });
      index += 1;
    }
    if (index === 0) {
      // The ref was emitted but bytes are no longer on disk — odd state, but
      // notify consumers with a structured error so they don't sit on a
      // pending placeholder forever.
      logger.warn({ sessionId, attachmentId: ref.id }, 'no bytes on disk for ref, sending error chunk');
      this.send({
        type: 'attachment_data',
        sessionId,
        payload: { id: ref.id, index: 0, total: 0, mimeType: ref.mimeType, data: '', error: 'not_found' },
      });
    }
  }

  /**
   * Serve a `request_attachment` from a consumer device. Reads from the
   * AttachmentStore, encrypts chunked unicasts to the requester only.
   */
  private async handleRequestAttachment(msg: ConsumerMessage): Promise<void> {
    if (msg.type !== 'request_attachment') return;
    const { id, sessionId } = msg.payload;
    const requesterDeviceId = msg.deviceId;
    const requesterKey = this.consumerKeys.get(requesterDeviceId);
    if (!requesterKey) {
      logger.warn({ requesterDeviceId }, 'request_attachment: no key for requester');
      return;
    }
    if (!this.attachmentStore) {
      this.unicastAttachmentError(requesterDeviceId, requesterKey, sessionId, id, 'not_found');
      return;
    }
    const got = this.attachmentStore.read(sessionId, id);
    if (!got) {
      this.unicastAttachmentError(requesterDeviceId, requesterKey, sessionId, id, 'not_found');
      return;
    }
    const total = Math.max(1, Math.ceil(got.bytes.length / RelayClient.ATTACHMENT_CHUNK_BYTES));
    for (let i = 0; i < total; i++) {
      const slice = got.bytes.subarray(
        i * RelayClient.ATTACHMENT_CHUNK_BYTES,
        Math.min((i + 1) * RelayClient.ATTACHMENT_CHUNK_BYTES, got.bytes.length),
      );
      const chunkMsg = {
        type: 'attachment_data' as const,
        deviceId: this.authInfo?.deviceId ?? '',
        sessionId,
        seq: ++this.seqCounter,
        timestamp: new Date().toISOString(),
        payload: {
          id,
          index: i,
          total,
          mimeType: got.meta.mimeType,
          data: slice.toString('base64'),
        },
      };
      this.sendReliableUnicastTo(requesterDeviceId, requesterKey, chunkMsg);
    }
  }

  private unicastAttachmentError(
    requesterDeviceId: string,
    requesterKey: string,
    sessionId: string,
    id: string,
    error: 'not_found' | 'unauthorized' | 'too_large',
  ): void {
    const errorMsg = {
      type: 'attachment_data' as const,
      deviceId: this.authInfo?.deviceId ?? '',
      sessionId,
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload: { id, index: 0, total: 0, mimeType: '', data: '', error },
    };
    this.sendReliableUnicastTo(requesterDeviceId, requesterKey, errorMsg);
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

    // Coalesce streaming deltas to amortize per-recipient RSA cost.
    // Skip the buffer when we're already inside a flush (the recursive
    // send below) — otherwise the merged delta would just be re-buffered.
    if (
      msg.type === 'agent_message_delta'
      && msg.sessionId
      && !this.flushingDeltas.has(msg.sessionId)
    ) {
      const content = (msg.payload as { content?: string } | undefined)?.content ?? '';
      this.bufferDelta(msg.sessionId, content);
      return;
    }

    // Any non-delta message for a session with pending deltas must
    // flush first so the merged delta arrives before the subsequent
    // agent_message / tool_start / idle / etc.
    if (msg.sessionId && this.deltaBuffers.has(msg.sessionId)) {
      this.flushDelta(msg.sessionId);
    }

    // NOTE: do NOT update lastActivityAt here. Outbound send() writes to a
    // local TCP buffer (or to a proxy on 127.0.0.1) and always succeeds
    // synchronously — it does not prove the bytes reached the relay. During
    // an outbound-only network blip (e.g. proxy reconnecting upstream),
    // counting our own sends as activity makes the stale-detector think the
    // link is healthy while the relay times us out. Track inbound traffic
    // only — those frames are proof of bidirectional connectivity.

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
    if (sessionId && RelayClient.PERSISTENT_TYPES.has(type)) {
      enriched.seq = this.sessionManager.appendMessage(sessionId, type, JSON.stringify(enriched));
    }

    // Advance the events watcher past any events the adapter just wrote,
    // so the watcher only picks up external changes (CLI, VS Code).
    // Only for persistent message types — transient metadata doesn't touch events.jsonl.
    if (sessionId && this.eventsWatcher && RelayClient.PERSISTENT_TYPES.has(type)) {
      this.eventsWatcher.skipToEnd(sessionId);
    }

    if (this.consumerKeys.size === 0) {
      // No consumer keys at all — queue until a device registers
      if (this.pendingE2eQueue.length < 1000) {
        this.pendingE2eQueue.push(msg);
      } else {
        logger.warn({ type: (msg as Partial<ProducerMessage>).type }, 'E2E queue full (1000) — dropping message');
      }
      return;
    }

    // Broadcast to all known devices (online get it via WS, offline via pushPreview).
    // Everything rides pulse — there is no non-E2E plaintext path (a keyManager is
    // always present; daemon-worker constructs one unconditionally).
    this.sendEncrypted(msg);

    // Also queue if no online consumers, so new devices get it on connect
    if (this.onlineConsumers.size === 0) {
      if (this.pendingE2eQueue.length < 1000) {
        this.pendingE2eQueue.push(msg);
      }
    }
  }

  /** Append to a session's delta buffer, arming a flush timer on first append. */
  private bufferDelta(sessionId: string, content: string): void {
    if (!content) return;
    let entry = this.deltaBuffers.get(sessionId);
    if (!entry) {
      entry = {
        content: '',
        timer: setTimeout(() => this.flushDelta(sessionId), RelayClient.DELTA_DEBOUNCE_MS),
      };
      this.deltaBuffers.set(sessionId, entry);
    }
    entry.content += content;
  }

  /** Emit one merged delta for a session and drop its buffer. Safe to call
   *  from a timer or synchronously before another send. */
  private flushDelta(sessionId: string): void {
    const entry = this.deltaBuffers.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.deltaBuffers.delete(sessionId);
    if (!entry.content) return;
    this.flushingDeltas.add(sessionId);
    try {
      this.send({
        type: 'agent_message_delta',
        sessionId,
        payload: { content: entry.content },
      });
    } finally {
      this.flushingDeltas.delete(sessionId);
    }
  }

  /** Drop all pending delta timers without flushing. Used at intentional
   *  shutdown so the event loop can exit promptly. */
  private clearAllDeltaTimers(): void {
    for (const entry of this.deltaBuffers.values()) {
      clearTimeout(entry.timer);
    }
    this.deltaBuffers.clear();
  }

  /**
   * Encrypt a producer message to all consumers and send it over pulse.
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

      // Track last agent message for idle push preview (needed by both paths).
      if (msg.type === 'agent_message' && msg.sessionId) {
        const content = (msg.payload as Record<string, unknown>).content as string;
        if (content) this.lastAgentContent.set(msg.sessionId as string, content);
      }

      // All producer messages ride the per-hop pulse endpoint to head (head fans
      // out + acks + durably holds for offline arms). The pulse frame's payload
      // carries BOTH the ciphertext blob AND the per-recipient keys, so everything
      // the receiver needs travels together through head (head never touches keys).
      //
      // The push preview (for notification-worthy messages) rides the SAME pulse
      // envelope — the head reads `pushPreview` off it in its broadcast branch — so
      // there is no separate raw send.
      this.pendingPushPreview = this.buildPushPreview(msg, recipients);
      this.pulse.send(JSON.stringify({ blob, keys }));
      this.pendingPushPreview = undefined;
    } catch (err) {
      logger.error({ err }, 'Encrypted broadcast failed');
    }
  }

  /** Put a pulse frame on the wire. With no target it rides a BROADCAST envelope
   *  (head fans out to all the user's apps); with a `targetDeviceId` it rides a
   *  UNICAST envelope so head forwards it to exactly that one app. head reads
   *  `pulse` for transport (+ `to` for unicast routing); the payload ({blob,keys})
   *  is inside the frame. */
  private sendPulseEnvelope(pulseB64: string, targetDeviceId?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const envelope: Record<string, unknown> = targetDeviceId
      ? { type: 'unicast', to: targetDeviceId, pulse: pulseB64, blob: '', keys: {} }
      : { type: 'broadcast', pulse: pulseB64, blob: '', keys: {} };
    // Attach a pending push preview (broadcast messages only) to this same
    // envelope so the head's push manager reaches offline devices — no separate
    // raw send. Consume it so it rides exactly one frame.
    if (!targetDeviceId && this.pendingPushPreview) {
      envelope.pushPreview = this.pendingPushPreview;
      this.pendingPushPreview = undefined;
    }
    this.ws.send(JSON.stringify(envelope));
  }

  /** A reliable consumer message was delivered in order by pulse (arm→tentacle),
   *  OR a plaintext head-originated control message ({from:'@head'} — presence).
   *  `payloadJson` is a JSON string of either shape; dispatch accordingly. */
  private handlePulseDelivered(payloadJson: string): void {
    if (!this.keyManager || !this.authInfo) return;
    let parsed: { from?: string; msg?: Record<string, unknown>; blob?: string; keys?: Record<string, string> };
    try {
      parsed = JSON.parse(payloadJson);
    } catch (err) {
      logger.error({ err }, 'Pulse delivered payload parse failed');
      return;
    }
    // Head-originated plaintext control (device_joined/left/removed, etc.): route
    // back through the normal presence handling in handleMessage. This is
    // load-bearing — device_joined registers the app's consumer key.
    if (parsed.from === HEAD_PULSE_TARGET && parsed.msg) {
      this.handleMessage(parsed.msg);
      return;
    }
    try {
      const { blob, keys } = parsed as { blob: string; keys: Record<string, string> };
      const decrypted = decryptFromBlob(
        { blob, keys },
        this.authInfo.deviceId,
        this.keyManager.getKeyPair().privateKey,
      );
      this.handleConsumerMessage(JSON.parse(decrypted) as ConsumerMessage);
    } catch (err) {
      logger.error({ err }, 'Pulse delivered payload decrypt failed');
    }
  }

  /** Build the encrypted push preview for a notification-worthy message, or
   *  undefined if the message isn't one. The preview rides the SAME pulse
   *  envelope as the reliable message (attached by sendPulseEnvelope), so the
   *  head's push manager can notify offline devices without a separate raw send. */
  private buildPushPreview(
    msg: Partial<ProducerMessage>,
    recipients: RecipientKey[],
  ): { blob: string; keys: Record<string, string> } | undefined {
    let previewSummary: string | undefined;
    if (msg.type === 'permission') {
      previewSummary = (msg.payload as Record<string, unknown>).description as string;
    } else if (msg.type === 'question') {
      previewSummary = (msg.payload as Record<string, unknown>).question as string;
    } else if (msg.type === 'idle') {
      previewSummary = this.lastAgentContent.get(msg.sessionId as string);
    }
    if (!previewSummary) return undefined;
    try {
      const preview = JSON.stringify({ type: msg.type, summary: previewSummary.slice(0, 50), sessionId: msg.sessionId });
      const previewBlob = encryptToBlob(preview, recipients);
      return { blob: previewBlob.blob, keys: previewBlob.keys };
    } catch (err) {
      logger.debug({ err }, 'Pulse push-preview build failed');
      return undefined;
    }
  }

  /**
   * Reliable per-app send over pulse. Encrypts `msg` for exactly one app, then
   * hands the {blob,keys} to the pulse endpoint addressed to that app (head
   * forwards it over the second pulse hop). Non-durable by default — sync
   * snapshots (session_list, greeting) self-heal on reconnect, so we don't
   * persist them in head's offline outbox.
   */
  private sendReliableUnicastTo(
    targetDeviceId: string,
    compactPubKey: string,
    msg: Record<string, unknown>,
    durable = false,
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.keyManager) return;

    try {
      const recipientPubKey = importPublicKey(compactPubKey);
      const { blob, keys } = encryptToBlob(JSON.stringify(msg), [
        { deviceId: targetDeviceId, publicKey: recipientPubKey },
      ]);
      this.pulse.send(JSON.stringify({ blob, keys }), targetDeviceId, durable);
    } catch (err) {
      logger.error({ err, targetDeviceId }, 'Reliable unicast failed');
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
        agents: this.options.device.capabilities?.agents,
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
        agents: this.options.device.capabilities?.agents,
        version: this.options.version,
      },
    };
    this.sendReliableUnicastTo(targetDeviceId, compactPubKey, greeting);
  }

  /**
   * Flush queued E2E messages once consumer keys become available.
   */
  private flushE2eQueue(): void {
    if (this.onlineConsumers.size === 0 || this.pendingE2eQueue.length === 0) return;
    const queued = this.pendingE2eQueue.splice(0);
    for (const msg of queued) {
      this.sendEncrypted(msg);
    }
  }

  private updateConsumerKeys(devices: DeviceSummary[]): void {
    this.consumerKeys.clear();
    this.onlineConsumers.clear();
    this.legacyReplayWarned.clear();
    for (const d of devices) {
      if (d.role === 'app') {
        const key = d.encryptionKey ?? d.publicKey;
        if (key) {
          this.consumerKeys.set(d.id, key);
          if (d.online) this.onlineConsumers.add(d.id);
        }
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
    this.staleCheckLastTickAt = 0;
    this.staleCheckTimer = setInterval(() => {
      const now = Date.now();
      // Drive pulse heartbeat + liveness (5s tick, finer than 15s heartbeat).
      this.pulse.tick();
      // Tick instrumentation: detect timer drift / event-loop block
      if (this.staleCheckLastTickAt > 0) {
        const tickDrift = now - this.staleCheckLastTickAt - RelayClient.STALE_CHECK_INTERVAL;
        if (tickDrift > 2_000) {
          logger.warn(
            { tickDriftMs: tickDrift, intervalMs: RelayClient.STALE_CHECK_INTERVAL },
            'staleCheck tick was late (event-loop block or timer drift)',
          );
        }
      }
      this.staleCheckLastTickAt = now;

      if (this.state !== 'connected' && this.state !== 'authenticating') return;
      const elapsed = now - this.lastActivityAt;
      // Warn before kill so we capture context for slow-but-not-yet-stale connections
      if (elapsed > RelayClient.STALE_THRESHOLD / 2 && elapsed <= RelayClient.STALE_THRESHOLD) {
        logger.info(
          { elapsedSec: Math.round(elapsed / 1000), thresholdSec: RelayClient.STALE_THRESHOLD / 1000 },
          'Activity gap approaching stale threshold',
        );
      }
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
