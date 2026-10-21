/**
 * Relay client — connects the tentacle to the relay via WebSocket.
 *
 * Translates adapter events into protocol messages and broadcasts them to apps.
 * Receives unicast consumer actions from apps and routes them to the adapter.
 * Handles auth, E2E encryption, reconnection, and session lifecycle.
 */

import { wsProxyOptions } from './proxy.js';
import { WebSocket } from 'ws';
import { ACCOUNT_DELETED_CLOSE_CODE } from '@kraki/protocol';
import type { AgentCapabilities, ProducerMessage, DeviceInfo, AuthOkMessage, AuthErrorMessage, DeviceSummary, AuthMethod, BroadcastEnvelope, UnicastEnvelope, MulticastEnvelope } from '@kraki/protocol';
import type { DeviceUpdateInfo, DeviceUpdatePhase } from '@kraki/protocol';
import { HEAD_CONTROL_TYPES, HEAD_PULSE_TARGET, PAYLOAD_FRAGMENT_FEATURE, PayloadAssembler, fragmentPayload, isPayloadFragment } from '@kraki/protocol';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { signChallenge, DEVICE_TRUST_FEATURE, type SignedMessage } from '@kraki/crypto';
import type { AgentAdapter } from './adapters/base.js';
import { type SessionManager, type PendingHumanAction } from './session-manager.js';
import type { KeyManager } from './key-manager.js';
import type { AccountUsage, UsageHistorySample } from '@kraki/protocol';
import { EventsWatcher } from './events-watcher.js';
import { getKrakiHome } from './config.js';
import { TentaclePulse, streamForType, type PulseDeliveryTarget } from './tentacle-pulse.js';
import { CardManager } from './card-manager.js';
import { AttachmentPacer } from './attachment-pacer.js';
import { SleepGuard } from './sleep-guard.js';
import { LocalLinkServer } from './local-link.js';
import { TrustStore } from './trust-store.js';
import { DeviceTrust, TRUST_ADMIN_TYPES } from './relay/device-trust.js';
import { restoreAccountAccess } from './account-access.js';
import { broadcastAccountUsage, sendAccountUsageTo } from './relay/account-usage.js';
import { wireAdapterEvents } from './relay/adapter-events.js';
import { sendAttachmentChunk } from './relay/attachments.js';
import { handleConsumerMessage } from './relay/consumer-messages.js';
import { dispatchPushPreview } from './relay/push-preview.js';
import { latestOpenAttention, restorePendingHumanActions } from './relay/questions.js';
import { initEventsWatcher, maybeAutoArchive } from './relay/session-commands.js';
import { resumeDisconnectedSessions } from './relay/session-resume.js';
import { logger, traceLog, type RelayClientOptions, DEFAULT_AUTO_ARCHIVE_DAYS, type RelayClientState, coalesceKeyFor, isAcceptableRegionRedirect, isHeadAuthNonce } from './relay/shared.js';
export { SessionResumeError, type RelayClientOptions, DEFAULT_AUTO_ARCHIVE_DAYS, type RelayClientState, coalesceKeyFor, isAcceptableRegionRedirect } from './relay/shared.js';

export class RelayClient {
  private ws: WebSocket | null = null;
  adapter: AgentAdapter;
  sessionManager: SessionManager;
  private keyManager: KeyManager | null;
  options: RelayClientOptions;
  state: RelayClientState = 'disconnected';
  /** Set after the first auth_ok of this process (see resumeDisconnectedSessions). */
  startupSessionsNormalised = false;
  private reconnectAttempts = 0;
  /** Inputs (session + clientId) this process has admitted. Bounded by the
   *  process lifetime's input count (small strings). */
  admittedInputs = new Set<string>();
  /** Behaviours each online app declared with `client_features` on its
   *  current connection (e.g. `fragments`). Cleared when it (re)joins/leaves. */
  appFeatures = new Map<string, Set<string>>();
  /** Reassembles fragmented payloads from apps. */
  private payloadAssembler = new PayloadAssembler();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;
  authInfo: AuthOkMessage | null = null;
  /** Cached consumer public keys for E2E encryption (includes offline devices for pushPreview) */
  consumerKeys = new Map<string, string>();
  /** Device IDs of consumers the Head reports online. */
  onlineConsumers = new Set<string>();
  /** Registered signing keys (compact SPKI) of this account's App devices —
   *  used to authenticate same-machine Apps on the local link. */
  private appSigningKeys = new Map<string, string>();
  /** Pinned app keys, signatures and pairing (see relay/device-trust.ts). */
  readonly deviceTrust: DeviceTrust | null;
  /** Enforced trust: online apps the Head reports that are not paired with
   *  this computer (deviceId → relay-reported RSA key). They get only a
   *  `trust_required` notice until they pair. */
  private unpairedApps = new Map<string, string>();
  /** Latest summary the Head reported for each app of the account, and which
   *  of them the Head reports online — so access can be re-evaluated when
   *  trust changes (pairing, revocation, policy). */
  private relayAppDevices = new Map<string, DeviceSummary>();
  private headOnlineApps = new Set<string>();
  private trustRefreshTimer: ReturnType<typeof setInterval> | null = null;
  /** X25519 key each paired app had when last seen trusted, so an app that
   *  loses trust can still be told so (signed) on its old key. */
  private pinnedKeys = new Map<string, string>();
  /** Same-machine loopback transport to local Apps. Lazily started on
   *  the first auth_ok, when this device's identity is confirmed. */
  localLink: LocalLinkServer | null = null;
  /** Accepted in-memory single-session subscription for each connected Arm. */
  currentSessionByArm = new Map<string, string | null>();
  /** High-frequency live card types filtered by current session subscription. */
  private static readonly SUBSCRIBER_ONLY_TYPES = new Set(['agent_message_delta', 'card_action']);

  /** Messages with explicit reconnect authorities; never replay as generic events. */
  private static readonly NO_OFFLINE_REPLAY_TYPES = new Set([
    'agent_message_delta',
    'card_action',
    'compacting',
    'session_list',
    'active',
    'idle',
    'user_message',
    'agent_message',
  ]);

  /** Maps pre-generated sessionId → requestId for concurrent create_session correlation */
  pendingRequestIds = new Map<string, string>();
  /** Message types that write to events.jsonl and should be persisted to messages.jsonl.
   *  New types default to NOT persisting/pausing the watcher — safer than the inverse.
   *
   *  Three-axis redesign: `tool_start`/`tool_complete` were removed. Tool
   *  activity keeps flowing live as a transient broadcast (like
   *  agent_message_delta) but no longer occupies a per-session spine seq nor
   *  persists here — it is mirrored to `trace.jsonl` and pulled on demand via
   *  `turn_trace_batch`, keyed by the concluding bubble's seq. */
  static readonly PERSISTENT_TYPES = new Set([
    'session_created',
    'agent_message',
    'user_message',
    'error',
    'system_message',
    'interrupted_turn',
    'turn_status',
    'session_ended',
    'idle',
  ]);
  /** Persisted boundaries that preserve/create a lastSeq > readSeq gap. Idle is
   *  contextual: only sendTurnIdle marks it, while create/fork/import idles do
   *  not manufacture unread state. */
  private static readonly UNREAD_BOUNDARY_TYPES = new Set([
    'system_message',
    'interrupted_turn',
  ]);
  /** Tool/narration steps of the in-progress turn. No longer broadcast live —
   *  the tentacle folds them into the server-owned status card (see
   *  {@link CardManager}) and mirrors the raw step to `trace.jsonl` for the
   *  lazy "Steps" history (pulled per-turn via `request_turn_trace`). Permission
   *  prompts likewise surface only as the card's action slot. Questions are
   *  spine messages (`agent_message` carrying `question`). */
  private static readonly TRACE_TYPES = new Set([
    'tool_start',
    'tool_complete',
    'agent_narration',
  ]);
  /** Global seq counter for envelope ordering (not used for replay — per-session seq handles that). */
  seqCounter = 0;
  /** Per-session running count of the current turn's TRACE steps (tool_start +
   *  agent_narration). Reset on each user_message, incremented as steps stream,
   *  and stamped onto the turn's concluding bubble(s) (agent_message /
   *  system_message) as `payload.steps` so a concluded bubble can show its
   *  "Steps" affordance from replay alone. In-memory: a tentacle restart
   *  mid-turn just resets the count (the trace.jsonl data is unaffected). */
  turnStepCounts = new Map<string, number>();
  /** Sessions whose current turn already has a spine outcome (reply, system
   *  notice or terminal status). Reset with the step counter per user turn. */
  turnHasOutcome = new Set<string>();
  legacyReplayWarned = new Set<string>();
  /** Prefer challenge auth when the relay already knows this device */
  private preferChallengeAuth = true;
  private reRegisteredKey = false;

  // ── Title generation state ──────────────────────────
  /** Turn count per session (for title generation scheduling) */
  turnCounts = new Map<string, number>();
  /** Sessions currently generating a title (prevent concurrent generation) */
  titleGenerationInFlight = new Set<string>();

  // ── Lazy resume state ──────────────────────────────
  /** In-flight `ensureSessionResumed` promises keyed by sessionId, so two
   *  concurrent callers don't double-resume the same SDK session. */
  resumeInFlight = new Map<string, Promise<boolean>>();

  /** Normal prompts are serialized until the preceding turn reaches idle. */
  inputChains = new Map<string, Promise<void>>();
  /** All adapter submissions are serialized only until transport acceptance.
   *  This lets an active-turn steer follow the original prompt ACK immediately
   *  without waiting for the whole turn to become idle. */
  inputDispatches = new Map<string, Promise<void>>();
  /** Idle has no turn identity. Hold it while a steer is awaiting adapter ACK so
   *  pre-steer completion cannot settle the newly accepted interjection. */
  steerAcceptanceInFlight = new Set<string>();
  idleDuringSteerAcceptance = new Set<string>();
  turnIdleWaiters = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  /** Adapter errors become terminal only when the same logical turn reaches
   *  idle. Keeping them pending avoids freezing recoverable tool failures. */
  pendingTerminalErrors = new Map<string, { message: string; code?: string; source: 'adapter' | 'backend' | 'process'; turnId?: string }>();
  /** Last adapter idle boundary per logical turn. The old implementation used
   *  one Session-wide boolean, which let a late callback cross a turn boundary. */
  settledAdapterTurnIds = new Map<string, string>();

  activeInputTurnIds = new Map<string, string>();
  nextInputTurnAnchors = new Map<string, number>();
  /** Turn id ('' when none) whose Stop is awaiting the adapter, per session:
   *  a second Stop for the same turn joins it instead of settling again. */
  abortsInFlight = new Map<string, string>();

  // ── Push preview state ─────────────────────────────
  /** Final reply of the CURRENT turn per session (for the turn-end push).
   *  Cleared when a new user turn starts, so a turn that ends without a reply
   *  (steps only, failed) never re-sends the previous turn's text. */
  lastAgentContent = new Map<string, string>();
  /** Terminal failure message of the turn currently closing, read by the
   *  closing idle's push preview. Set and cleared around sendTurnIdle. */
  closingTurnPush = new Map<string, { failure?: string }>();

  // ── Streaming delta debounce ───────────────────────
  // Each agent_message_delta otherwise triggers a full hybrid encryption
  // (sync RSA-4096 wrap per recipient + AES-GCM) on the JS main thread.
  // Coalescing a short window of token-sized deltas into one merged
  // payload roughly drops main-thread crypto work proportionally without
  // changing the on-the-wire content seen by arms.
  private static readonly DELTA_DEBOUNCE_MS = 40;
  private deltaBuffers = new Map<string, { content: string; reset: boolean; timer: ReturnType<typeof setTimeout> }>();
  /** Sessions currently inside flushDelta — prevents the recursive send()
   *  from re-buffering the already-merged delta. */
  private flushingDeltas = new Set<string>();

  /** Owns the server-formed status card ({message, action}) per session. The
   *  tentacle is the sole authority for what the card shows; arms render it
   *  verbatim. Broadcasts route back through {@link send} (which coalesces the
   *  `agent_message_delta` text deltas). */
  /** Idle-sleep assertion while any turn runs (see sleep-guard.ts). */
  readonly sleepGuard = new SleepGuard();

  /** Turn whose first adapter error was already persisted, per session. */
  errorPersistedForTurn = new Map<string, string>();
  card = new CardManager((msg) => this.send(msg as Partial<ProducerMessage>));

  /** Sessions whose agent runtime is currently compacting context. The reason
   *  determines whether new user work may queue behind it: threshold/manual
   *  compaction is maintenance; overflow compaction remains part of recovery. */
  compactingSessions = new Map<string, 'manual' | 'threshold' | 'overflow' | undefined>();
  /** Turn identity that started the currently active maintenance compaction.
   *  Compaction may finish after a queued follow-up has opened a newer logical
   *  turn, so its end callback must not be fenced against that newer turn. */
  compactionTurnIds = new Map<string, string | undefined>();
  /** Follow-up inputs accepted while maintenance is active. They remain
   *  conversationally idle until compaction ends, then become active. */
  maintenanceFollowUps = new Map<string, { accepted: boolean }>();

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
  eventsWatcher: EventsWatcher | null = null;
  /** True while send() relays an external events.jsonl change (see initEventsWatcher). */
  mirroringExternalEvent = false;

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
    this.deviceTrust = this.keyManager
      ? new DeviceTrust(
          this.keyManager,
          // Next to this computer's keys (`<KRAKI_HOME>/trust`), so an
          // isolated KeyManager (tests, chaos stack) gets an isolated store.
          new TrustStore(this.keyManager.keysDir ? this.keyManager.trustDir : null),
          options.deviceTrust === 'policy' ? undefined : options.deviceTrust ?? 'compatible',
          () => this.authInfo?.deviceId,
        )
      : null;
    if (this.deviceTrust) {
      // Explicit modes exist only for historical wire/transition fixtures.
      // Shipping clients always use account access, even with an old on-disk
      // policy, environment variable or an old app trying to re-enable it.
      if (options.deviceTrust === undefined) restoreAccountAccess(this.deviceTrust.store);
      for (const d of this.deviceTrust.store.list()) this.pinnedKeys.set(d.id, d.encryptionKey);
      this.deviceTrust.store.onExternalChange = () => {
        this.reevaluateAllApps();
        this.broadcastTrustedDevices();
      };
    }
    // Per-hop pulse endpoint to the relay — the reliable-delivery layer.
    this.pulse = new TentaclePulse(
      {
        now: () => Date.now(),
        sendPulseFrame: (pulseB64, target) => this.sendPulseEnvelope(pulseB64, target),
        onDelivered: (blobB64) => this.handlePulseDelivered(blobB64, undefined, 'head'),
      },
      `tentacle:${options.device.deviceId ?? 'local'}:${Date.now()}`,
    );
    wireAdapterEvents(this);
  }

  readonly pulse: TentaclePulse;

  readonly attachmentStore?: import('./attachment-store.js').AttachmentStore;

  /** Inline floor for offloading args. Below this we don't bother creating
   *  a ContentRef + chunk push — the round-trip overhead would exceed the
   *  bytes saved. Above it we always offload. */
  static readonly ARGS_INLINE_FLOOR = 256;

  /** Stash args (and the matching argsRef if we created one) at tool_start
   *  so tool_complete can recompute the headline and carry the same argsRef
   *  forward. Keyed by toolCallId. Cleaned on complete OR on session end. */
  lastArgsByToolCallId = new Map<string, Record<string, unknown>>();
  lastArgsRefByToolCallId = new Map<string, import('@kraki/protocol').ContentRef>();
  /** Reverse index of in-flight toolCallIds per session — so we can purge
   *  the two `lastArgs*` maps when a session ends with tool calls that
   *  never received a matching `tool_complete`. Without this, the toolCallId-
   *  keyed maps leak entries permanently (Phase 1 had the identical issue
   *  in the Copilot adapter; same fix here). */
  sessionToolCallIds = new Map<string, Set<string>>();

  /** Pending permissions used for stable sidebar attention previews. */
  openPermissions = new Map<string, Map<string, { text: string; openedAt: string }>>();

  /** Open ask_user questions per session — the adapter is blocked waiting on
   *  the human. The question itself is on the spine; this map routes answers
   *  (`send_input.answerTo`) to the adapter and drives the session_list
   *  attention preview. Populated on onQuestionRequest, drained on answer /
   *  auto-resolve, cleared when the turn ends. Insertion order is preserved so
   *  the newest open question wins the preview slot. */
  openQuestions = new Map<string, Map<string, PendingHumanAction>>();
  /** `${sessionId}\u0000${questionId}` of answers being delivered. Claimed
   *  before the first await, so a competing answer sees it as no longer open. */
  answeringQuestions = new Set<string>();

  /**
   * Connect to the relay. Auto-reconnects on disconnect.
   */
  connect(): void {
    if (this.ws) return;
    this.intentionalDisconnect = false;
    this.setState('connecting');

    // Bound the TCP/TLS/upgrade phase: a black-holed connect (Wi-Fi switch,
    // captive portal) otherwise waits for the OS TCP timeout before retrying.
    const ws = new WebSocket(this.options.relayUrl, { handshakeTimeout: 15_000, ...wsProxyOptions(this.options.relayUrl) });
    this.ws = ws;

    ws.on('open', () => {
      this.setState('authenticating');
      this.lastActivityAt = Date.now();
      this.startStaleCheck();
      this.startTrustRefresh();
      const device = {
        ...this.options.device,
        publicKey: this.keyManager?.getCompactPublicKey(),
        // Pulse ≥0.5.1: progress heartbeats never trigger resends.
        pulseProgressAck: true,
      };
      // The keys exist now (a fresh install just created them and its default
      // policy). Make sure device-trust keys exist on upgraded installs too
      // (same-Mac pairing reads them), then load the policy before anything
      // from the relay is accepted.
      this.ensureDeviceTrustReady();
      let auth: AuthMethod;
      try {
        auth = this.buildAuthPayload(device);
      } catch (err) {
        // A throw inside the ws 'open' listener is an uncaughtException: the
        // worker would exit and the supervisor restart it into the same state.
        this.onFatalError?.(err instanceof Error ? err.message : String(err));
        this.disconnect();
        return;
      }
      ws.send(JSON.stringify({ type: 'auth', auth, device }));
    });

    ws.on('message', (data) => {
      const wsRxNs = process.hrtime.bigint();
      this.lastActivityAt = Date.now();
      try {
        const rawLen = (data as Buffer | ArrayBuffer | string).toString ? (data as Buffer).length : 0;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return; // Ignore malformed frames from head
        }
        traceLog.info({
          ns: wsRxNs.toString(),
          comp: 'tentacle',
          evt: 'WS-RX',
          type: msg.type,
          from: msg.from,
          to: msg.to,
          hasPulse: typeof msg.pulse === 'string',
          rawLen,
        });
        // Only the relay itself writes raw frames (peers' data arrives inside
        // pulse frames), so this cannot be forged by another device.
        if (msg.type === 'account_deleted') {
          this.accountDeleted();
          return;
        }
        this.handleMessage(msg);
      } catch (err) {
        // A handler bug, not a malformed frame: never swallow it silently.
        logger.error({ err }, 'Error handling relay message');
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason?.toString?.() || '';
      this.stopStaleCheck();
      this.ws = null;
      logger.info({ code, reason: reasonStr, intentional: this.intentionalDisconnect }, 'WS closed');
      this.setState('disconnected');
      this.pulse.onDisconnected();
      if (code === ACCOUNT_DELETED_CLOSE_CODE) {
        this.accountDeleted();
        return;
      }
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
  lastAutoArchiveAt = 0;

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.sleepGuard.stop();
    this.stopStaleCheck();
    this.stopTrustRefresh();
    this.deviceTrust?.store.flushReplay();
    this.clearAllDeltaTimers();
    this.compactingSessions.clear();
    this.compactionTurnIds.clear();
    this.maintenanceFollowUps.clear();
    if (this.eventsWatcher) {
      this.eventsWatcher.close();
      this.eventsWatcher = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.localLink?.stop();
    this.localLink = null;
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

  /**
   * The account was deleted from an app (or while this computer was offline).
   * Stop for good: never reconnect, which would sign up a new account with
   * the saved token. The daemon forgets its credentials (onAccountDeleted).
   */
  private accountDeleted(): void {
    if (this.accountDeletedHandled) return;
    this.accountDeletedHandled = true;
    logger.warn('Kraki account was deleted; disconnecting for good');
    this.disconnect();
    this.onAccountDeleted?.();
  }

  private accountDeletedHandled = false;

  /** Called once when the relay reports that the account was deleted. */
  onAccountDeleted: (() => void) | null = null;
  /** The relay no longer knows this device and no credential remains to sign
   *  in again (removed from the account while offline). Permanent until the
   *  user runs setup; restarting cannot help. */
  onDeviceRemoved: (() => void) | null = null;

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.type === 'auth_ok') {
      this.authInfo = msg as unknown as AuthOkMessage;
      this.preferChallengeAuth = true;
      this.reconnectAttempts = 0;
      this.deviceTrust?.store.refresh();
      // Cache consumer device public keys for E2E
      if (this.authInfo.devices) {
        this.updateConsumerKeys(this.authInfo.devices);
      }
      this.setState('connected');
      this.onAuthenticated?.(this.authInfo);
      this.ensureLocalLink();
      // Bring up the pulse endpoint to the relay (resume the stream).
      this.pulse.onConnected();
      // Initialize events watcher for imported sessions
      initEventsWatcher(this);
      restorePendingHumanActions(this);
      resumeDisconnectedSessions(this);
      this.sendGreetingBroadcast();
      broadcastAccountUsage(this);
      this.runAutoArchive();
      this.lastAutoArchiveAt = Date.now();
      this.broadcastSessionList();
      return;
    }

    if (msg.type === 'auth_error') {
      const authError = msg as unknown as AuthErrorMessage;
      if (authError.code === 'account_deleted') {
        this.accountDeleted();
        return;
      }
      if (authError.code === 'wrong_region' && authError.redirect) {
        if (!isAcceptableRegionRedirect(this.options.relayUrl, authError.redirect)) {
          logger.warn({ to: authError.redirect }, 'Ignoring region redirect to an untrusted relay');
          this.onFatalError?.('The relay redirected to an untrusted address');
          this.disconnect();
          return;
        }
        logger.info({ to: authError.redirect }, 'Relay requested reconnect to assigned region');
        this.options.relayUrl = authError.redirect;
        this.ws?.close();
        return;
      }
      if (authError.code === 'unknown_device' && this.preferChallengeAuth && this.options.device.deviceId && this.keyManager) {
        if (!this.hasFullAuthCredential()) {
          // Removed from the account (e.g. while offline) and no token to sign
          // in again with: nothing will ever succeed until the user signs in.
          logger.warn('This computer was removed from the account and has no saved sign-in');
          this.disconnect();
          if (this.onDeviceRemoved) this.onDeviceRemoved();
          else this.onFatalError?.('This computer was removed from your Kraki account. Run `kraki` to sign in again.');
          return;
        }
        logger.warn('Challenge auth rejected for unknown device; retrying with full auth');
        this.preferChallengeAuth = false;
        this.ws?.close();
        return;
      }
      // The relay holds a different key for this device than the one on
      // disk (an earlier install raced two key generators). Signing in again
      // with the account token re-registers the current key; without this the
      // computer could never come back online. Once per process.
      if (authError.code === 'invalid_signature' && this.preferChallengeAuth && this.options.token
        && this.options.authMethod !== 'open' && !this.reRegisteredKey) {
        logger.warn('Relay has a different key for this device; signing in again to re-register it');
        this.reRegisteredKey = true;
        this.preferChallengeAuth = false;
        this.ws?.close();
        return;
      }
      // The relay marks account-backend outages as retryable. Treating them
      // as fatal left a live daemon permanently offline until a manual restart.
      if (authError.code === 'service_unavailable' || authError.code === 'auth_unavailable') {
        logger.warn({ code: authError.code }, 'Relay auth temporarily unavailable; reconnecting');
        this.ws?.close();
        return;
      }
      this.onFatalError?.(authError.message);
      this.disconnect();
      return;
    }

    if (msg.type === 'auth_challenge') {
      if (!isHeadAuthNonce(msg.nonce)) {
        // No reply: the Head's auth deadline closes the socket and we reconnect.
        logger.warn('Refusing to sign an auth challenge that is not a Head nonce');
        return;
      }
      if (this.keyManager && this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          const signature = signChallenge(msg.nonce, this.keyManager.getKeyPair().privateKey);
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
        if (device.publicKey) this.appSigningKeys.set(device.id, device.publicKey);
        this.relayAppDevices.set(device.id, device);
        this.headOnlineApps.add(device.id);
        const key = this.appKeyFor(device);
        if (!key) {
          this.noteUnpairedApp(device);
          return;
        }
        if (key && this.localLink?.has(device.id)) {
          // Served over the local link; the Head joining it changes nothing
          // for this Tentacle (its subscription lives on the local link).
          this.onlineConsumers.add(device.id);
          this.consumerKeys.set(device.id, key);
        } else if (key) {
          this.consumerKeys.set(device.id, key);
          this.onlineConsumers.add(device.id);
          this.appFeatures.delete(device.id);
          this.attachmentPacer.notifyOnline(device.id);
          this.currentSessionByArm.set(device.id, null);
          // Send a greeting unicast so the app learns our capabilities
          this.sendGreetingTo(device.id, key);
          sendAccountUsageTo(this, device.id, key);
          // Send session list so the app can sync and establish its reconnect barrier.
          this.sendSessionListTo(device.id, key);
          this.sendTrustedDevicesTo(device.id);
        }
      }
      return;
    }

    if (msg.type === 'device_left') {
      const deviceId = msg.deviceId as string;
      this.onlineConsumers.delete(deviceId);
      this.unpairedApps.delete(deviceId);
      this.headOnlineApps.delete(deviceId);
      // Still on the local link: its features and subscription are live there.
      if (this.localLink?.has(deviceId)) return;
      this.appFeatures.delete(deviceId);
      this.currentSessionByArm.delete(deviceId);
      return;
    }

    if (msg.type === 'device_removed') {
      const deviceId = msg.deviceId as string;
      // Removal only ever takes trust away, so the Head is believed here:
      // removing a device from the account revokes it on this computer too.
      const wasTrusted = this.deviceTrust?.store.remove(deviceId) ?? false;
      this.pinnedKeys.delete(deviceId);
      this.unpairedApps.delete(deviceId);
      this.relayAppDevices.delete(deviceId);
      this.headOnlineApps.delete(deviceId);
      if (wasTrusted) queueMicrotask(() => this.broadcastTrustedDevices());
      this.appFeatures.delete(deviceId);
      this.consumerKeys.delete(deviceId);
      this.appSigningKeys.delete(deviceId);
      this.onlineConsumers.delete(deviceId);
      this.currentSessionByArm.delete(deviceId);
      this.attachmentPacer.drop(deviceId);
      this.localLink?.disconnectPeer(deviceId, 'device_removed');
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
        const opened = this.deviceTrust!.open({ blob: msg.blob, keys: msg.keys }, undefined);
        if (opened.kind === 'message') this.dispatchAppMessage(opened.inner, opened.signed, opened.toAll);
        else if (opened.kind === 'pair_request') this.handlePairRequest(opened.signed, opened.inner);
      } catch {
        // Can't decrypt — not for us or corrupted
      }
      return;
    }

    // Anything else is not a consumer message. Consumer messages are accepted
    // ONLY after E2E decryption above (or via the Pulse path); a plaintext
    // frame from the relay must never reach handleConsumerMessage.
    logger.debug({ type: msg.type }, 'Ignoring unrecognized relay frame');
  }

  /** Whether a non-challenge sign-in is possible (open relay, or a saved token/key). */
  private hasFullAuthCredential(): boolean {
    const method = this.options.authMethod;
    return method === 'open' || !!this.options.token;
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

  /** Forks in progress: their adapter's onSessionCreated must not announce
   *  them; handleForkSession does, with the fork's full state. */
  forkingSessions = new Set<string>();

  // ── Local session sync handlers ───────────────────────

  // ── Events watcher for imported sessions ──────────────

  // ── Adapter event wiring ────────────────────────────

  // ── Session resume on reconnect ─────────────────────

  // ── Session sync & replay ───────────────────────────

  /**
   * Send the session_list to a specific device (used on device_joined).
   */
  private sendSessionListTo(targetDeviceId: string, compactPubKey: string): void {
    const sessions = this.enrichSessionList(this.sessionManager.getSessionList());
    const msg = {
      type: 'session_list',
      deviceId: this.authInfo?.deviceId ?? '',
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload: this.sessionListPayload(sessions),
    };
    this.sendReliableUnicastTo(targetDeviceId, compactPubKey, msg);
  }

  /**
   * Broadcast session_list to all connected apps (used on auth_ok).
   */
  broadcastSessionList(): void {
    const sessions = this.enrichSessionList(this.sessionManager.getSessionList());
    this.sendEncrypted({
      type: 'session_list',
      deviceId: this.authInfo?.deviceId ?? '',
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload: this.sessionListPayload(sessions),
    } as ProducerMessage);
  }

  private sessionListPayload<T>(sessions: T[]): { sessions: T[]; archivedCount: number; autoArchiveDays: number } {
    return {
      sessions,
      archivedCount: this.sessionManager.countArchived(),
      autoArchiveDays: this.autoArchiveDays,
    };
  }

  // ── Archive (F2) ────────────────────────────────────

  private get autoArchiveDays(): number {
    return this.options.autoArchiveDays ?? DEFAULT_AUTO_ARCHIVE_DAYS;
  }

  /** Archive sessions idle past the configured days; true if any changed. */
  runAutoArchive(now = Date.now()): boolean {
    const keep = (id: string) =>
      this.openPermissions.get(id)?.size ? true
        : this.openQuestions.get(id)?.size ? true
          : this.compactingSessions.has(id);
    const archived = this.sessionManager.autoArchive(this.autoArchiveDays, keep, now);
    if (archived.length) logger.info({ count: archived.length, days: this.autoArchiveDays }, 'Auto-archived inactive sessions');
    return archived.length > 0;
  }

  /** Override each digest's `preview` with the live open question (if any) so a
   *  reloading arm can render the "pending" status - the question no longer
   *  persists to the spine, so the file-based preview can't surface it.
   *
   *  Compaction is intentionally NOT overlaid onto `state`: conversation state
   *  stays active/idle while the transient `compacting` envelope owns the
   *  orthogonal maintenance indicator. */
  enrichSessionList<
    T extends { id: string; state: import('@kraki/protocol').SessionState; preview?: import('@kraki/protocol').SessionPreviewDigest },
  >(sessions: T[]): T[] {
    return sessions.map((s) => {
      const compactingReason = this.compactingSessions.get(s.id);
      const attention = latestOpenAttention(this, s.id);
      if (compactingReason === undefined && !this.compactingSessions.has(s.id) && attention === undefined) return s;
      return {
        ...s,
        ...(this.compactingSessions.has(s.id) && {
          runtimeStatus: {
            status: 'compacting' as const,
            ...(compactingReason && { reason: compactingReason }),
          },
        }),
        ...(attention !== undefined && {
          preview: {
            type: attention.type,
            text: attention.text.slice(0, 200),
            timestamp: attention.openedAt,
          },
        }),
      };
    });
  }

  /**
   * Server-side hard cap on messages returned by a single
   * `request_session_messages_range` reply. Defensive backstop —
   * clients should chunk their own requests well below this. When
   * the cap triggers, the reply's `truncated` flag is set.
   */
  static readonly RANGE_MAX_COUNT = 500;

  /** Keep encrypted frames small so control messages can interleave between
   *  attachment chunks. */
  /** Chunk size for attachment_data. Small enough that one chunk (about 2.4x
   *  on the wire after encryption and framing) never holds the relay link for
   *  long in front of chat traffic and liveness pings. */
  static readonly ATTACHMENT_CHUNK_BYTES = 128 * 1024;

  /** Serializes and rate-limits attachment bytes (see AttachmentPacer). */
  readonly attachmentPacer = new AttachmentPacer({
    chunkBytes: RelayClient.ATTACHMENT_CHUNK_BYTES,
    isOnline: (deviceId) => this.isAppOnline(deviceId),
    sendChunk: (job, index, total, slice) => {
      const key = this.consumerKeys.get(job.deviceId);
      if (!key) return 0;
      return sendAttachmentChunk(this, job.deviceId, key, job.sessionId, job.id, job.mimeType, index, total, slice, false);
    },
  });

  // ── Client log shipping ─────────────────────────────

  /**
   * Write web app debug logs to a local file.
   */
  /** Largest web-client.log before it is rotated to web-client.log.1. */
  static readonly CLIENT_LOG_MAX_BYTES = 5 * 1024 * 1024;

  // ── Send to relay ───────────────────────────────────

  // TODO: Make send() accept a discriminated union of ProducerMessage types
  // instead of Partial<ProducerMessage> so TypeScript enforces correct payload
  // shape per message type (e.g. user_message must have payload.content).
  // ── Local link (same-machine Apps) ────────────────────────────

  private relayOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Apps reachable either through the Head or over the local link. */
  private onlineApps(): string[] {
    const ids = new Set(this.onlineConsumers);
    for (const id of this.localLink?.peerIds() ?? []) ids.add(id);
    return [...ids];
  }

  isAppOnline(deviceId: string): boolean {
    return this.onlineConsumers.has(deviceId) || this.localLink?.has(deviceId) === true;
  }

  /** Frames this Tentacle put on the Head socket; `framesToLinkedApps` counts
   *  frames addressed to an App that was on the local link at the time. */
  private headTx = { frames: 0, bytes: 0, framesToLinkedApps: 0 };
  private lastStatsLine = '';

  /** Local-link counters (for diagnostics/tests); null when not running. */
  getLocalLinkStats(): (ReturnType<LocalLinkServer['getStats']> & { head: { frames: number; bytes: number; framesToLinkedApps: number } }) | null {
    const stats = this.localLink?.getStats();
    return stats ? { ...stats, head: { ...this.headTx } } : null;
  }

  private logLocalLinkStats(): void {
    const stats = this.getLocalLinkStats();
    if (!stats) return;
    const line = JSON.stringify(stats);
    if (line === this.lastStatsLine) return;
    this.lastStatsLine = line;
    logger.info({ localLink: stats }, 'Local link stats');
  }

  private ensureLocalLink(): void {
    if (this.localLink || !this.keyManager || !this.authInfo) return;
    // Kraki for Mac and the Windows/Linux desktop app connect to it.
    const enabled = this.options.localLink ?? process.env.KRAKI_LOCAL_LINK !== '0';
    if (!enabled) return;
    const server = new LocalLinkServer({
      tentacleId: () => this.authInfo?.deviceId,
      privateKeyPem: () => this.keyManager?.getKeyPair().privateKey,
      appSigningKey: (appId) => this.appSigningKeys.get(appId),
      onPeerUp: (appId) => this.onLocalAppUp(appId),
      onPeerDown: (appId) => this.onLocalAppDown(appId),
      onDelivered: (appId, payloadJson) => this.onLocalDelivered(appId, payloadJson),
    }, getKrakiHome());
    this.localLink = server;
    server.start().catch((err) => {
      logger.warn({ err: (err as Error).message }, 'Local link failed to start; Apps stay on the Head');
      if (this.localLink === server) this.localLink = null;
    });
  }

  /** A same-machine App authenticated on the local link. Same bootstrap as a
   *  Head `device_joined`, but routed locally: the session_list is the App's
   *  new subscription barrier for this Tentacle. */
  private onLocalAppUp(appId: string): void {
    const key = this.consumerKeys.get(appId);
    if (!key) {
      logger.warn({ appId }, 'Local link App has no encryption key; dropping link');
      this.localLink?.disconnectPeer(appId, 'no_key');
      return;
    }
    logger.info({ appId }, 'App switched to the local link');
    this.appFeatures.delete(appId);
    this.currentSessionByArm.set(appId, null);
    this.attachmentPacer.notifyOnline(appId);
    this.sendGreetingTo(appId, key);
    sendAccountUsageTo(this, appId, key);
    this.sendSessionListTo(appId, key);
  }

  /** The local link dropped. If the Head still sees the App, fall back to it
   *  with a fresh barrier; otherwise forget its connection-scoped state. */
  private onLocalAppDown(appId: string): void {
    this.appFeatures.delete(appId);
    const key = this.consumerKeys.get(appId);
    if (this.onlineConsumers.has(appId) && key && this.relayOpen()) {
      logger.info({ appId }, 'App fell back from the local link to the Head');
      this.currentSessionByArm.set(appId, null);
      this.sendGreetingTo(appId, key);
      sendAccountUsageTo(this, appId, key);
      this.sendSessionListTo(appId, key);
    } else {
      this.currentSessionByArm.delete(appId);
    }
  }

  /** The authenticated link is the sender: stamp it like the Head stamps
   *  `src`, and never accept Head-control wrappers from an App. */
  private onLocalDelivered(appId: string, payloadJson: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payloadJson);
    } catch {
      return;
    }
    if (parsed.from !== undefined) {
      logger.warn({ appId }, 'Dropped Head-control wrapper received on the local link');
      return;
    }
    parsed.src = appId;
    this.handlePulseDelivered(JSON.stringify(parsed), undefined, 'link');
  }

  send(msg: Partial<ProducerMessage>, createsUnread = false, opts: { persist?: boolean } = {}): void {
    // Durable outcomes must reach the local spine even while the relay is
    // offline. Reconnect replay pulls from that spine; there is no event queue
    // to recover a reply discarded here. Only live-only deltas may be dropped.
    if (msg.type === 'agent_message_delta' && !this.relayOpen() && !this.localLink?.peerIds().length) return;

    // Coalesce streaming card text deltas to amortize per-recipient RSA cost.
    // Skip the buffer when we're already inside a flush (the recursive send
    // below) — otherwise the merged delta would just be re-buffered. Non-empty
    // deltas are coalesced; a reset boundary flushes the prior segment first,
    // and an empty-content reset (card clear) is emitted immediately.
    if (
      msg.type === 'agent_message_delta'
      && msg.sessionId
      && !this.flushingDeltas.has(msg.sessionId)
    ) {
      const p = msg.payload as { content?: string; reset?: boolean } | undefined;
      const content = p?.content ?? '';
      const reset = p?.reset ?? false;
      if (reset && this.deltaBuffers.has(msg.sessionId)) {
        this.flushDelta(msg.sessionId);
      }
      if (content !== '') {
        this.bufferDelta(msg.sessionId, content, reset);
        return;
      }
      // empty reset (clear) falls through to send immediately below
    }

    traceLog.info({
      ns: process.hrtime.bigint().toString(),
      comp: 'tentacle',
      evt: 'APP-OUT',
      type: msg.type,
      sessionId: msg.sessionId,
      clientId: (msg.payload as { clientId?: string } | undefined)?.clientId,
    });

    // Any non-delta send for a session with pending card deltas must flush
    // first so the merged text arrives before the subsequent card_action /
    // agent_message / idle / etc.
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
    // TRACE-step counter: track the current turn's step count so the concluding
    // bubble can advertise `payload.steps` (a replay-visible "has steps" hint).
    // Reset on the turn's user_message; the per-step increment lives in
    // recordTrace() (tool_start / agent_narration flow there, NOT through send());
    // stamp the running total onto agent_message / system_message bubbles here.
    if (sessionId) {
      const input = type === 'user_message' ? enriched.payload as { delivery?: string; answerTo?: string } | undefined : undefined;
      if (type === 'user_message' && input?.delivery !== 'steer') {
        // An answer to the agent's question continues the turn that asked: its
        // steps keep counting, but what follows the answer needs its own
        // outcome (reply or steps-only anchor).
        if (!input?.answerTo) this.turnStepCounts.set(sessionId, 0);
        this.turnHasOutcome.delete(sessionId);
        this.lastAgentContent.delete(sessionId);
      } else if (type === 'agent_message' || type === 'system_message' || type === 'interrupted_turn' || type === 'turn_status') {
        this.turnHasOutcome.add(sessionId);
        const p = enriched.payload as Record<string, unknown> | undefined;
        if (p && typeof p === 'object') p.steps = this.turnStepCounts.get(sessionId) ?? 0;
      }
    }
    if (opts.persist === false) {
      // Announcement only (a fork's session_created): no spine row. Seq 0
      // tells apps not to store it as history either.
      enriched.seq = 0;
    } else if (sessionId && RelayClient.PERSISTENT_TYPES.has(type)) {
      enriched.seq = this.sessionManager.appendMessage(
        sessionId,
        type,
        JSON.stringify(enriched),
        createsUnread || RelayClient.UNREAD_BOUNDARY_TYPES.has(type),
      );
    } else if (sessionId && RelayClient.TRACE_TYPES.has(type)) {
      // Off-spine tool activity: mirror to trace.jsonl (keyed to the current
      // turn) and keep broadcasting transiently below. No per-session seq.
      this.sessionManager.appendTrace(sessionId, type, JSON.stringify(enriched));
    }

    // Advance the events watcher past any events the adapter just wrote,
    // so the watcher only picks up external changes (CLI, VS Code).
    // Only for persistent message types — transient metadata doesn't touch events.jsonl.
    // (Not for the watcher's own mirrored events: pausing there stopped the
    // live sync after its first batch.)
    if (sessionId && this.eventsWatcher && !this.mirroringExternalEvent && RelayClient.PERSISTENT_TYPES.has(type)) {
      this.eventsWatcher.skipToEnd(sessionId);
    }

    if (msg.type === 'agent_message' && msg.sessionId) {
      const p = msg.payload as { content?: string; question?: unknown } | undefined;
      if (p?.content && !p.question) this.lastAgentContent.set(msg.sessionId, p.content);
    }

    // Keep the machine awake while any session's turn is running.
    if (sessionId) {
      this.sleepGuard.touch(sessionId);
      if (type === 'active') this.sleepGuard.hold(sessionId);
      else if (type === 'idle' || type === 'session_ended' || type === 'session_deleted') this.sleepGuard.release(sessionId);
    }

    // Push is a separate Head-bound operation and must happen even when there
    // are zero online live recipients.
    dispatchPushPreview(this, msg);

    // Everything with a reconnect authority is recovered by session_list,
    // subscription snapshot, spine range, or TRACE/attachment pull. Do not keep
    // a generic offline event queue.
    this.sendEncrypted(msg);
  }

  /** Append to a session's card-text buffer, arming a flush timer on first
   *  append. `reset` marks the buffered segment as a new narrative segment. */
  private bufferDelta(sessionId: string, content: string, reset: boolean): void {
    if (!content) return;
    let entry = this.deltaBuffers.get(sessionId);
    if (!entry) {
      entry = {
        content: '',
        reset,
        timer: setTimeout(() => this.flushDelta(sessionId), RelayClient.DELTA_DEBOUNCE_MS),
      };
      this.deltaBuffers.set(sessionId, entry);
    }
    entry.content += content;
  }

  /** Emit one merged agent_message_delta for a session and drop its buffer. Safe
   *  to call from a timer or synchronously before another send. */
  flushDelta(sessionId: string): void {
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
        payload: { content: entry.content, reset: entry.reset },
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

  /** Encrypt a producer message once for its explicit online target set. */
  sendEncrypted(msg: Partial<ProducerMessage>): void {
    if (!this.keyManager) return;
    // Offline from the Head, only local-link Apps are reachable.
    const reachable = this.relayOpen() ? this.onlineApps() : (this.localLink?.peerIds() ?? []);
    if (reachable.length === 0) return;

    const type = msg.type;
    const sessionId = msg.sessionId;
    const targetIds = type && RelayClient.SUBSCRIBER_ONLY_TYPES.has(type)
      ? reachable.filter((deviceId) => this.currentSessionByArm.get(deviceId) === sessionId)
      : reachable;

    if (targetIds.length === 0) {
      traceLog.info({ ns: process.hrtime.bigint().toString(), comp: 'tentacle', evt: 'SEND-DECISION', type, sessionId, droppedReason: 'targets-empty' });
      return;
    }

    const usableTargets = targetIds.filter((deviceId) => this.consumerKeys.has(deviceId));
    if (usableTargets.length === 0) return;

    traceLog.info({ ns: process.hrtime.bigint().toString(), comp: 'tentacle', evt: 'SEND-OK', type, sessionId, recipients: usableTargets, coalesceKey: coalesceKeyFor(msg) });

    try {
      const plaintext = JSON.stringify(msg);
      // Paired apps: one signed X25519 payload to their pinned keys. Others
      // (compatible mode only): the legacy RSA payload.
      // One payload per encryption group; each group supersedes only its
      // own earlier updates (a shared coalesce key would let the legacy
      // payload drop the paired apps' one from the retransmit outbox).
      const coalesceKey = coalesceKeyFor(msg);
      for (const sealed of this.deviceTrust!.seal(plaintext, usableTargets, (id) => this.consumerKeys.get(id))) {
        const groupKey = coalesceKey && sealed.group === 'trusted' ? `${coalesceKey}:trusted` : coalesceKey;
        this.sendPayload(sealed.payload, sealed.targets, false, groupKey, streamForType(msg.type));
      }
    } catch (err) {
      logger.error({ err }, 'Encrypted multicast failed');
    }
  }

  /** Put a pulse frame on the wire using the sender-retained delivery target. */
  private sendPulseEnvelope(pulseB64: string, target?: PulseDeliveryTarget): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.headTx.frames++;
    this.headTx.bytes += pulseB64.length;
    const targets = Array.isArray(target) ? target : target ? [target] : [];
    if (targets.some((t) => this.localLink?.has(t))) this.headTx.framesToLinkedApps++;
    const envelope: UnicastEnvelope | MulticastEnvelope | BroadcastEnvelope = Array.isArray(target)
      ? { type: 'multicast', to: target, pulse: pulseB64, blob: '', keys: {} }
      : target
        ? { type: 'unicast', to: target, pulse: pulseB64, blob: '', keys: {} }
        : { type: 'broadcast', pulse: pulseB64, blob: '', keys: {} };
    const raw = JSON.stringify(envelope);
    traceLog.info({
      ns: process.hrtime.bigint().toString(),
      comp: 'tentacle',
      evt: 'WS-TX',
      type: envelope.type,
      to: Array.isArray(target) ? target : target,
      rawLen: raw.length,
    });
    this.ws.send(raw);
  }

  /** A reliable consumer message was delivered in order by pulse (arm→tentacle),
   *  OR a plaintext head-originated control message ({from:'@head'} — presence).
   *  `payloadJson` is a JSON string of either shape; dispatch accordingly. */
  /**
   * Send an E2E payload to app targets. Large payloads go as fragments to the
   * targets that declared `fragments` (each part is a small Pulse message, so
   * a slow link keeps showing progress) and whole to the others. Parts never
   * carry the coalesce key (a superseded part must not be dropped from a set);
   * a large coalesced payload therefore trades supersession for progress.
   */
  private sendPayload(payloadJson: string, target: string | string[], durable: boolean, coalesceKey: string | undefined, stream: number): void {
    let targets = Array.isArray(target) ? target : [target];
    // Same-machine Apps take the loopback link; the ciphertext is identical
    // (already encrypted to every recipient), only the transport differs.
    // Loopback has no slow-uplink problem, so payloads go whole.
    if (this.localLink) {
      const local = targets.filter((t) => this.localLink!.has(t));
      if (local.length > 0) {
        for (const appId of local) this.localLink.send(appId, payloadJson, durable, coalesceKey, stream);
        targets = targets.filter((t) => !local.includes(t));
        if (targets.length === 0) return;
        target = Array.isArray(target) ? targets : targets[0];
      }
    }
    const fragmenting = targets.filter((t) => this.appFeatures.get(t)?.has(PAYLOAD_FRAGMENT_FEATURE));
    const parts = fragmenting.length > 0 ? fragmentPayload(payloadJson, randomUUID()) : null;
    if (!parts) {
      this.pulse.send(payloadJson, target, durable, coalesceKey, stream);
      return;
    }
    // Same envelope shape as before (unicast string / multicast array).
    const shape = (ids: string[]): string | string[] => (Array.isArray(target) ? ids : ids[0]);
    const whole = targets.filter((t) => !fragmenting.includes(t));
    if (whole.length > 0) this.pulse.send(payloadJson, shape(whole), durable, coalesceKey, stream);
    for (const part of parts) this.pulse.send(part, shape(fragmenting), durable, undefined, stream);
  }

  private handlePulseDelivered(payloadJson: string, fragmentSender: string | undefined, route: 'head' | 'link'): void {
    if (!this.keyManager || !this.authInfo) return;
    let parsed: { from?: string; src?: string; msg?: Record<string, unknown>; blob?: string; keys?: Record<string, string> };
    try {
      parsed = JSON.parse(payloadJson);
    } catch (err) {
      logger.error({ err }, 'Pulse delivered payload parse failed');
      return;
    }
    if (isPayloadFragment(parsed)) {
      const whole = this.payloadAssembler.accept(parsed);
      // Every part of a set is stamped by the head with the same sender; carry
      // it to the reassembled payload, which itself has no `src`.
      if (whole !== null) this.handlePulseDelivered(whole, parsed.src, route);
      return;
    }
    // Head-originated plaintext control (device_joined/left/removed, etc.): route
    // back through the normal presence handling in handleMessage. This is
    // load-bearing — device_joined registers the app's consumer key. Only the
    // head's own control types are accepted from this plaintext wrapper; auth
    // frames and consumer messages arriving this way are forged and dropped.
    // Head control never arrives over the local link, whole or reassembled.
    if (route === 'link' && parsed.from !== undefined) {
      logger.warn({ src: fragmentSender }, 'Dropped Head-control wrapper received on the local link');
      return;
    }
    if (parsed.from === HEAD_PULSE_TARGET) {
      const type = parsed.msg?.type;
      if (parsed.msg && typeof type === 'string' && HEAD_CONTROL_TYPES.has(type)) {
        this.handleMessage(parsed.msg);
      } else {
        logger.warn({ type }, 'Dropped non-control message in head pulse wrapper');
      }
      return;
    }
    const sender = parsed.src ?? fragmentSender;
    try {
      const decryptStart = process.hrtime.bigint();
      // Decrypt and authenticate. With device trust the signature (checked
      // against the key pinned at pairing) decides who sent a message; the
      // Head's `src` stamp must only agree with it.
      const opened = this.deviceTrust!.open(parsed as Record<string, unknown>, sender);
      if (opened.kind === 'rejected') return;
      if (opened.kind === 'pair_request') {
        this.handlePairRequest(opened.signed, opened.inner);
        return;
      }
      const inner = opened.inner;
      // The head stamps the authenticated sender (`src`). The deviceId inside
      // the encrypted message is chosen by the sender, so it must match.
      if (sender !== undefined) {
        const claimed = (inner as { deviceId?: unknown }).deviceId;
        if (typeof claimed === 'string' && claimed !== '' && claimed !== sender) {
          logger.warn({ src: sender, claimed, type: (inner as { type?: string }).type }, 'Dropped consumer message whose deviceId does not match its sender');
          return;
        }
        // Replies and per-app state key off deviceId: use the verified sender.
        (inner as { deviceId?: string }).deviceId = sender;
      }
      // A subscription arriving through the Head from an App that is on the
      // local link was sent before the switch and is stale: applying it would
      // replace the link's current subscription. Other commands still apply
      // (an approve or answer sent just before the switch must not be lost).
      if (route === 'head' && sender !== undefined && this.localLink?.has(sender)
        && (inner as { type?: string }).type === 'set_session_subscription') {
        logger.info({ appId: sender }, 'Dropped stale Head-routed subscription from a linked App');
        return;
      }
      traceLog.info({
        ns: process.hrtime.bigint().toString(),
        comp: 'tentacle',
        evt: 'APP-DECRYPT',
        type: (inner as { type?: string }).type,
        sessionId: (inner as { sessionId?: string }).sessionId,
        clientId: (inner as { payload?: { clientId?: string } }).payload?.clientId,
        decryptNs: (process.hrtime.bigint() - decryptStart).toString(),
      });
      this.dispatchAppMessage(inner, opened.signed, opened.toAll);
    } catch (err) {
      logger.error({ err }, 'Pulse delivered payload decrypt failed');
    }
  }

  /**
   * Reliable per-app send over pulse. Encrypts `msg` for exactly one app, then
   * hands the {blob,keys} to the pulse endpoint addressed to that app (head
   * forwards it over the second pulse hop). Non-durable by default — sync
   * snapshots (session_list, greeting) self-heal on reconnect, so we don't
   * persist them in head's offline outbox.
   */
  sendReliableUnicastTo(
    targetDeviceId: string,
    compactPubKey: string,
    msg: Record<string, unknown>,
    durable = false,
  ): void {
    if (!this.keyManager) return;
    if (!this.relayOpen() && !this.localLink?.has(targetDeviceId)) return;

    try {
      for (const sealed of this.deviceTrust!.seal(JSON.stringify(msg), [targetDeviceId], () => compactPubKey)) {
        this.sendPayload(sealed.payload, targetDeviceId, durable, undefined, streamForType((msg as { type?: string }).type));
      }
    } catch (err) {
      logger.error({ err, targetDeviceId }, 'Reliable unicast failed');
    }
  }

  // ── Subscription account usage ───────────────────────

  accountUsage: AccountUsage[] | null = null;
  /** Advertised as the `account_usage` feature so apps can tell "no accounts" from "too old". */
  accountUsageEnabled = false;
  setAccountUsageEnabled(enabled: boolean): void {
    if (this.accountUsageEnabled === enabled) return;
    this.accountUsageEnabled = enabled;
    if (this.state === 'connected') this.sendGreetingBroadcast();
  }
  accountUsageRefresher: (() => Promise<AccountUsage[]>) | null = null;
  usageRefreshInFlight: Promise<AccountUsage[]> | null = null;
  usageRefreshRequests = new Map<string, string>();

  setAccountUsageRefresher(refresh: (() => Promise<AccountUsage[]>) | null): void {
    this.accountUsageRefresher = refresh;
    if (this.state === 'connected') this.sendGreetingBroadcast();
  }

  /** Reads the local quota history file for `request_usage_history`. */
  usageHistoryReader: ((since: number) => UsageHistorySample[]) | null = null;
  static readonly USAGE_HISTORY_MAX_SAMPLES = 20_000;

  /** Latest read-only quota of this machine's subscription accounts; broadcast to online apps. */
  updateAccountUsage(accounts: AccountUsage[]): void {
    this.accountUsage = accounts;
    if (this.state === 'connected') broadcastAccountUsage(this);
  }

  /** Set by the daemon when remote update is wired (remote-update.ts). */
  onUpdateRequest: ((requestId: string, when?: 'now' | 'idle') => Promise<void>) | null = null;

  /** Progress/outcome of a remote update, to every online app. */
  sendUpdateStatus(payload: { phase: DeviceUpdatePhase; requestId?: string; from?: string; to?: string; progress?: number; runningSessions?: number; error?: string }): void {
    if (this.state !== 'connected') return;
    this.sendEncrypted({
      type: 'device_update_status',
      deviceId: this.authInfo?.deviceId ?? '',
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload,
    } as ProducerMessage);
  }

  /** Sessions with a turn running right now (asked before an update). */
  /** Sessions an update would interrupt. A turn that is only waiting for the
   *  person's answer to a question doesn't count: the question is persisted
   *  (pending-human-action.json) and answering it after a restart continues
   *  the session, as it does for a session whose agent already stopped. A
   *  waiting permission does count — it is not persisted. */
  runningSessionCount(): number {
    return this.sessionManager.getSessionList({ all: true }).filter((s) => s.state === 'active'
      && !(this.openQuestions.get(s.id)?.size && !this.openPermissions.get(s.id)?.size)).length;
  }

  private updateInfo: DeviceUpdateInfo | null = null;
  get currentUpdateInfo(): DeviceUpdateInfo | null { return this.updateInfo; }
  /** Latest answer to "is a newer Kraki available here" (update-status.ts); re-greets apps. */
  setUpdateInfo(info: DeviceUpdateInfo): void {
    this.updateInfo = info;
    if (this.state === 'connected') this.sendGreetingBroadcast();
  }

  /** Replace the advertised agent capabilities (e.g. a model list that was
   *  unavailable at startup) and re-greet connected apps. Apps replace a
   *  device's agents on every greeting, so no new message type is needed; the
   *  next reconnect/auth also carries the updated capabilities. */
  updateAgentCapabilities(agents: AgentCapabilities[]): void {
    this.options.device.capabilities = agents.length ? { ...this.options.device.capabilities, agents } : undefined;
    if (this.state === 'connected') this.sendGreetingBroadcast();
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
      payload: this.greetingPayload(),
    } as ProducerMessage);
  }

  /** The one greeting payload. Apps read `features` from whichever greeting
   *  arrived last, so every greeting must carry all of them. */
  private greetingPayload() {
    return {
      name: this.options.device.name,
      kind: this.options.device.kind,
      agents: this.options.device.capabilities?.agents,
      version: this.options.version,
      features: ['idempotent_input', PAYLOAD_FRAGMENT_FEATURE, ...(this.accountUsageEnabled ? ['account_usage'] : []),
        ...(this.accountUsageEnabled && this.accountUsageRefresher ? ['account_usage_refresh'] : []),
        ...(this.deviceTrust ? [DEVICE_TRUST_FEATURE] : [])],
      ...(this.deviceTrust ? { trust: { enforced: this.deviceTrust.enforced } } : {}),
      ...(this.updateInfo ? { update: this.updateInfo } : {}),
    };
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
      payload: this.greetingPayload(),
    };
    this.sendReliableUnicastTo(targetDeviceId, compactPubKey, greeting);
  }

  // ── Device trust ────────────────────────────────────

  private ensureDeviceTrustReady(): void {
    const km = this.keyManager as (KeyManager & { getPublicIdentity?: () => unknown }) | null;
    if (km && typeof km.getPublicIdentity === 'function' && km.keysDir) {
      try { km.getPublicIdentity(); } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Could not create device-trust keys');
      }
    }
    if (this.deviceTrust?.store.refresh()) this.reevaluateAllApps();
  }

  /** The key an app is reached with, or undefined when it may not be. A
   *  paired app's pinned key always wins over the one the Head reports; with
   *  trust enforced, an unpaired app gets nothing. */
  private appKeyFor(device: DeviceSummary): string | undefined {
    const pinned = this.deviceTrust?.consumerKeyFor(device.id);
    if (pinned) return pinned;
    if (this.deviceTrust?.enforced) return undefined;
    return device.encryptionKey ?? device.publicKey;
  }

  /** Enforced trust: an online app that is not paired learns that it must
   *  pair (a signed notice with nothing secret in it) and nothing else. */
  private noteUnpairedApp(device: DeviceSummary): void {
    const relayKey = device.encryptionKey ?? device.publicKey;
    if (!this.deviceTrust?.enforced || !relayKey) return;
    this.unpairedApps.set(device.id, relayKey);
    const self = this.authInfo?.deviceId;
    if (!self) return;
    try {
      const notice = JSON.stringify({
        type: 'trust_required',
        deviceId: self,
        seq: 0,
        timestamp: new Date().toISOString(),
        payload: { tentacleId: self, name: this.options.device.name },
      });
      this.sendPayload(this.deviceTrust.sealSignedToRelayKey(notice, device.id, relayKey), device.id, false, undefined, 0);
    } catch (err) {
      logger.warn({ err: (err as Error).message, appId: device.id }, 'trust_required notice failed');
    }
    logger.info({ appId: device.id }, 'Unpaired app — waiting for it to pair');
  }

  /** An app asked to pair. Answer it (to the key it enrolled), and on
   *  success bring it up exactly like a newly joined app. */
  private handlePairRequest(signed: SignedMessage, inner: Record<string, unknown>): void {
    if (!this.deviceTrust) return;
    const outcome = this.deviceTrust.handlePairRequest(signed, inner);
    const self = this.authInfo?.deviceId ?? '';
    const appId = outcome.appId;
    if (outcome.encryptionKey) {
      const reply = JSON.stringify({
        type: 'pair_result',
        deviceId: self,
        seq: 0,
        timestamp: new Date().toISOString(),
        payload: {
          ok: outcome.ok,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
          tentacleId: self,
          name: this.options.device.name,
          enforced: this.deviceTrust.enforced,
        },
      });
      try {
        this.sendPayload(this.deviceTrust.sealToKey(reply, appId, outcome.encryptionKey), appId, false, undefined, 0);
      } catch (err) {
        logger.warn({ err: (err as Error).message, appId }, 'pair_result failed');
      }
    }
    if (!outcome.ok) return;
    const key = this.deviceTrust.consumerKeyFor(appId);
    if (!key) return;
    if (outcome.device) this.pinnedKeys.set(appId, outcome.device.encryptionKey);
    logger.info({ appId }, 'App paired');
    this.headOnlineApps.add(appId);
    this.unpairedApps.delete(appId);
    this.consumerKeys.set(appId, key);
    this.onlineConsumers.add(appId);
    this.appFeatures.delete(appId);
    this.attachmentPacer.notifyOnline(appId);
    this.currentSessionByArm.set(appId, null);
    this.sendGreetingTo(appId, key);
    sendAccountUsageTo(this, appId, key);
    this.sendSessionListTo(appId, key);
    this.broadcastTrustedDevices();
  }

  /** Route an authenticated app message. Trust administration is accepted
   *  only from a paired app's signed message. */
  private dispatchAppMessage(inner: Record<string, unknown>, signed: boolean, toAll = false): void {
    const type = typeof inner.type === 'string' ? inner.type : '';
    if (TRUST_ADMIN_TYPES.has(type)) {
      const from = inner.deviceId as string | undefined;
      // Signed for this computer specifically: a message addressed to several
      // computers can be replayed by the relay to any one of them.
      if (!signed || toAll || !from || !this.deviceTrust?.isTrusted(from)) {
        logger.warn({ type, from }, 'Dropped trust administration from an unpaired app');
        return;
      }
      this.handleTrustAdmin(from, type, (inner.payload ?? {}) as Record<string, unknown>);
      return;
    }
    handleConsumerMessage(this, inner as never);
  }

  private handleTrustAdmin(from: string, type: string, payload: Record<string, unknown>): void {
    const trust = this.deviceTrust!;
    if (type === 'request_trusted_devices') {
      this.sendTrustedDevicesTo(from);
      return;
    }
    if (type === 'revoke_device') {
      const target = typeof payload.deviceId === 'string' ? payload.deviceId : '';
      logger.info({ by: from, target }, 'Device revoke requested');
      // Its access goes before the store forgets it, so nothing more is sent.
      if (target && trust.store.remove(target)) this.reevaluateApp(target);
      this.broadcastTrustedDevices();
      if (target === from) this.sendTrustRequired(from);
      return;
    }
    if (type === 'set_trust_policy') {
      if (trust.policyLocked) {
        this.sendTrustedDevicesTo(from);
        return;
      }
      const enforce = payload.enforce === true;
      // The request names the revision the app saw; an older one (e.g. a
      // request the relay withheld) cannot undo a newer choice — checked
      // against the file, under the lock the CLI also takes.
      const wasEnforced = trust.enforced;
      const revision = typeof payload.revision === 'number' ? payload.revision : -1;
      if (!trust.store.setPolicy({ enforce }, revision)) {
        logger.warn({ by: from, enforce, revision, current: trust.store.policyRevision }, 'Stale device trust policy request ignored');
        if (trust.enforced !== wasEnforced) this.reevaluateAllApps();
        this.broadcastTrustedDevices();
        return;
      }
      logger.info({ by: from, enforce }, 'Device trust policy changed by a paired app');
      if (enforce !== wasEnforced) this.reevaluateAllApps();
      this.broadcastTrustedDevices();
    }
  }

  /** The trusted-devices list, for paired apps' Settings. */
  private trustedDevicesMessage(): Record<string, unknown> {
    const trust = this.deviceTrust!;
    // Report what is on disk now (the CLI may have just changed it), so the
    // revision an app's next request names is current.
    if (trust.store.refresh()) queueMicrotask(() => this.reevaluateAllApps());
    return {
      type: 'trusted_devices',
      deviceId: this.authInfo?.deviceId ?? '',
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload: {
        enforced: trust.enforced,
        policyLocked: trust.policyLocked,
        policyRevision: trust.store.policyRevision,
        devices: trust.store.list().map((d) => ({
          id: d.id,
          name: d.name ?? this.relayAppDevices.get(d.id)?.name ?? d.id,
          via: d.via,
          pairedAt: d.pairedAt,
        })),
      },
    };
  }

  private sendTrustedDevicesTo(appId: string): void {
    if (!this.deviceTrust?.isTrusted(appId) || !this.isAppOnline(appId)) return;
    const key = this.consumerKeys.get(appId);
    if (key) this.sendReliableUnicastTo(appId, key, this.trustedDevicesMessage());
  }

  broadcastTrustedDevices(): void {
    if (!this.deviceTrust) return;
    for (const appId of this.deviceTrust.store.ids()) this.sendTrustedDevicesTo(appId);
  }

  private sendTrustRequired(appId: string): void {
    const device = this.relayAppDevices.get(appId);
    if (device) this.noteUnpairedApp(device);
  }

  /** Withdraw everything an app had: keys, presence, link, subscription. */
  private dropAppAccess(appId: string): void {
    this.consumerKeys.delete(appId);
    this.onlineConsumers.delete(appId);
    this.appFeatures.delete(appId);
    this.currentSessionByArm.delete(appId);
    this.attachmentPacer.drop(appId);
    this.localLink?.disconnectPeer(appId, 'untrusted');
  }

  /**
   * Apply the current trust state to one app: grant (and bring up) or
   * withdraw access. Used when pairing, revocation or the policy changes.
   */
  private reevaluateApp(appId: string): void {
    const device = this.relayAppDevices.get(appId);
    const trusted = this.deviceTrust?.store.get(appId);
    const formerKey = this.pinnedKeys.get(appId);
    const lostTrust = !trusted && formerKey !== undefined;
    if (trusted) this.pinnedKeys.set(appId, trusted.encryptionKey);
    else if (formerKey) {
      this.pinnedKeys.delete(appId);
      this.sendTrustRevoked(appId, formerKey);
    }
    const key = device ? this.appKeyFor(device) : this.deviceTrust?.consumerKeyFor(appId);
    const online = this.headOnlineApps.has(appId) || this.localLink?.has(appId) === true;
    if (!key) {
      if (this.consumerKeys.has(appId)) this.dropAppAccess(appId);
      if (online && device) this.noteUnpairedApp(device);
      return;
    }
    const previous = this.consumerKeys.get(appId);
    this.consumerKeys.set(appId, key);
    // A changed trust status re-sends the snapshot on the new channel.
    if (!online || (previous === key && this.onlineConsumers.has(appId) && !lostTrust)) return;
    this.unpairedApps.delete(appId);
    this.onlineConsumers.add(appId);
    this.appFeatures.delete(appId);
    this.attachmentPacer.notifyOnline(appId);
    this.currentSessionByArm.set(appId, null);
    this.sendGreetingTo(appId, key);
    sendAccountUsageTo(this, appId, key);
    this.sendSessionListTo(appId, key);
    this.sendTrustedDevicesTo(appId);
  }

  /**
   * Tell an app that this computer no longer trusts it — signed, on the key it
   * was paired with (the only one it accepts from us). In compatible mode it
   * then goes back to the unpaired connection; enforced, it must pair again.
   */
  private sendTrustRevoked(appId: string, formerKey: string): void {
    const online = this.headOnlineApps.has(appId) || this.localLink?.has(appId) === true;
    const self = this.authInfo?.deviceId;
    if (!online || !self || !this.deviceTrust) return;
    try {
      const notice = JSON.stringify({
        type: 'trust_revoked',
        deviceId: self,
        seq: 0,
        timestamp: new Date().toISOString(),
        payload: { enforced: this.deviceTrust.enforced },
      });
      this.sendPayload(this.deviceTrust.sealToKey(notice, appId, formerKey), appId, false, undefined, 0);
      logger.info({ appId }, 'Told app its pairing was revoked');
    } catch (err) {
      logger.warn({ err: (err as Error).message, appId }, 'trust_revoked notice failed');
    }
  }

  private reevaluateAllApps(): void {
    const ids = new Set([...this.relayAppDevices.keys(), ...this.consumerKeys.keys()]);
    for (const id of ids) this.reevaluateApp(id);
  }

  /** Changes made by another process (`kraki devices …`, Kraki for Mac). */
  private startTrustRefresh(): void {
    if (this.trustRefreshTimer || !this.deviceTrust?.store.persistent) return;
    this.trustRefreshTimer = setInterval(() => {
      if (!this.deviceTrust?.store.refresh()) return;
      logger.info({ enforced: this.deviceTrust.enforced, trusted: this.deviceTrust.store.ids().length }, 'Device trust changed on disk');
      this.reevaluateAllApps();
      this.broadcastTrustedDevices();
    }, 2_000);
    this.trustRefreshTimer.unref?.();
  }

  private stopTrustRefresh(): void {
    if (this.trustRefreshTimer) clearInterval(this.trustRefreshTimer);
    this.trustRefreshTimer = null;
  }

  private updateConsumerKeys(devices: DeviceSummary[]): void {
    // A Head reconnect does not touch Apps on the local link: keep their
    // features and subscriptions, which belong to that link.
    const localIds = new Set(this.localLink?.peerIds() ?? []);
    const keptFeatures = new Map([...this.appFeatures].filter(([id]) => localIds.has(id)));
    const keptSubs = new Map([...this.currentSessionByArm].filter(([id]) => localIds.has(id)));
    // An App that stayed online across this Tentacle's reconnect still holds
    // its confirmed subscription: when the Head replaces our old socket it
    // sends the App no device_left, so the App never re-subscribes. Keep it.
    const previousSubs = this.currentSessionByArm;
    this.consumerKeys.clear();
    this.onlineConsumers.clear();
    this.appFeatures = keptFeatures;
    this.currentSessionByArm = keptSubs;
    this.appSigningKeys.clear();
    this.unpairedApps.clear();
    this.relayAppDevices.clear();
    this.headOnlineApps.clear();
    this.legacyReplayWarned.clear();
    for (const d of devices) {
      if (d.role === 'app') {
        if (d.publicKey) this.appSigningKeys.set(d.id, d.publicKey);
        this.relayAppDevices.set(d.id, d);
        if (d.online) this.headOnlineApps.add(d.id);
        const key = this.appKeyFor(d);
        if (!key) {
          if (d.online) this.noteUnpairedApp(d);
          continue;
        }
        if (localIds.has(d.id)) {
          this.consumerKeys.set(d.id, key);
          if (d.online) this.onlineConsumers.add(d.id);
          continue;
        }
        if (key) {
          this.consumerKeys.set(d.id, key);
          if (d.online) {
            this.onlineConsumers.add(d.id);
            this.currentSessionByArm.set(d.id, previousSubs.get(d.id) ?? null);
          }
        }
      }
    }
    // A linked App that is no longer an App of this account (removed while
    // this Tentacle could not hear device_removed) must not keep its link.
    const appIds = new Set(devices.filter((d) => d.role === 'app').map((d) => d.id));
    for (const id of localIds) {
      if (!appIds.has(id)) this.localLink?.disconnectPeer(id, 'device_removed');
    }
  }

  // ── Title generation scheduling ──────────────────────

  // ── Stale connection detection ───────────────────────

  private startStaleCheck(): void {
    this.stopStaleCheck();
    this.staleCheckLastTickAt = 0;
    this.staleCheckTimer = setInterval(() => {
      const now = Date.now();
      // Drive pulse heartbeat + liveness (5s tick, finer than 15s heartbeat).
      this.pulse.tick();
      maybeAutoArchive(this, now);
      this.logLocalLinkStats();
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

    // Exponential backoff with jitter from `reconnectDelay` (first retry) to
    // 30 s, reset on authentication: a Relay restart does not reconnect every
    // Tentacle in lockstep, and a long outage does not spin every few seconds.
    const base = this.options.reconnectDelay ?? 1000;
    const delay = Math.round(Math.min(30_000, base * 2 ** Math.min(this.reconnectAttempts, 5)) * (0.8 + Math.random() * 0.4));
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
