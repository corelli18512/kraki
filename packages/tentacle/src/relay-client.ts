/**
 * Relay client — connects the tentacle to the relay via WebSocket.
 *
 * Translates adapter events into protocol messages and broadcasts them to apps.
 * Receives unicast consumer actions from apps and routes them to the adapter.
 * Handles auth, E2E encryption, reconnection, and session lifecycle.
 */

import { wsProxyOptions } from './proxy.js';
import { WebSocket } from 'ws';
import { DEFAULT_SESSION_MODE, normalizeSessionMode, toWireSessionMode, ACCOUNT_DELETED_CLOSE_CODE } from '@kraki/protocol';
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  AgentCapabilities,
  ProducerMessage, ConsumerMessage,
  DeviceInfo, AuthOkMessage, AuthErrorMessage, DeviceSummary, AuthMethod,
  BroadcastEnvelope, UnicastEnvelope, MulticastEnvelope, CardActionState,
  SessionLiveSnapshot, SessionDigest, IdleMessage,
} from '@kraki/protocol';
import type { DeviceUpdateInfo, DeviceUpdatePhase } from '@kraki/protocol';
import { HEAD_CONTROL_TYPES, HEAD_PULSE_TARGET, PAYLOAD_FRAGMENT_FEATURE, PayloadAssembler, fragmentPayload, isPayloadFragment } from '@kraki/protocol';
import { randomUUID } from 'node:crypto';
import { importPublicKey, encryptToBlob, decryptFromBlob, signChallenge } from '@kraki/crypto';
import type { RecipientKey } from '@kraki/crypto';
import type { AgentAdapter } from './adapters/base.js';
import { isSafeId, toWellFormedText, type SessionManager, type SessionContext, type PendingHumanAction, type InputLedgerEntry } from './session-manager.js';
import type { KeyManager } from './key-manager.js';
import type { AccountUsage, UsageHistorySample } from '@kraki/protocol';
import { scanLocalSessions, filterSessions } from './session-scanner.js';
import { parseSessionHistory } from './history-parser.js';
import { EventsWatcher } from './events-watcher.js';
import { createLogger } from './logger.js';
import { getKrakiHome } from './config.js';
import { makeHeadline } from './tool-headline.js';
import { markdownToPlainText, truncateUtf8, PUSH_SUMMARY_MAX_BYTES } from './push-preview-text.js';
import { TentaclePulse, streamForType, type PulseDeliveryTarget } from './tentacle-pulse.js';
import { CardManager } from './card-manager.js';
import { AttachmentPacer } from './attachment-pacer.js';
import { SleepGuard } from './sleep-guard.js';

const logger = createLogger('relay-client');
/** Pulse-trace is OFF by default. Enable with env `KRAKI_TRACE_PULSE=1`
 *  before daemon start. See tentacle-pulse.ts for why (event-loop
 *  starvation via pino sync-fsync under stream storms). */
const TRACE_ENABLED = process.env.KRAKI_TRACE_PULSE === '1';
const traceLogger = createLogger('pulse-trace');
const traceLog = {
  info: TRACE_ENABLED
    ? (obj: Record<string, unknown>) => traceLogger.info(obj)
    : (_obj: Record<string, unknown>) => { /* no-op */ },
};

const GENERIC_TERMINAL_ERROR = 'Agent request failed';

const AGENT_LABELS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot', pi: 'Pi' };

/** A session could not be reattached to its agent after a restart/eviction. */
export class SessionResumeError extends Error {
  constructor(agent: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`${AGENT_LABELS[agent] ?? agent} couldn't reopen this session: ${reason}`);
    this.name = 'SessionResumeError';
  }
}

/** User-facing text for a failed command: no "Failed to x:" stacking for
 *  errors that already explain themselves. */
function describeFailure(prefix: string, err: unknown): string {
  if (err instanceof SessionResumeError) return err.message;
  return `${prefix}: ${(err as Error)?.message ?? String(err)}`;
}

function normalizeTerminalErrorMessage(
  value: unknown,
): { message: string; quality: number } {
  if (typeof value !== 'string') {
    return { message: GENERIC_TERMINAL_ERROR, quality: 0 };
  }
  const message = value.trim();
  if (
    !message ||
    /^(success|unknown|error_during_execution)$/i.test(message)
  ) {
    return { message: GENERIC_TERMINAL_ERROR, quality: 0 };
  }
  const concrete =
    /\b(?:HTTP\s*)?[45]\d\d\b|status code|request id|provider|API error/i.test(
      message,
    );
  return { message, quality: concrete ? 2 : 1 };
}

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
  /** Days without messages before an unpinned session is archived; 0 = never.
   *  Default 14 (F2). */
  autoArchiveDays?: number;
  /** Persist a new auto-archive setting chosen from an app. */
  saveAutoArchiveDays?: (days: number) => void;
}

export const DEFAULT_AUTO_ARCHIVE_DAYS = 14;
const AUTO_ARCHIVE_SWEEP_MS = 6 * 3600_000;

export type RelayClientState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';

/**
 * Send-time coalesce key for the pulse reliable-transport layer (pulse spec §12).
 * Messages that share a key supersede each other in the outbox: a later send
 * with the same key drops earlier ones before transmission. This means a peer
 * that was offline receives exactly ONE latest value per key on reconnect — not
 * a burst of stale frames.
 *
 * Only state-covering messages get a key:
 *   - `card_action` - the current status-card state; stale actions are noise.
 *   - `compacting` - the current runtime state; stale phases are noise.
 *
 * Event messages (`agent_message`, `user_message`, `tool_start`, etc.) return
 * `undefined` - every event must be delivered.
 */
export function coalesceKeyFor(msg: Partial<ProducerMessage>): string | undefined {
  // NOT agent_message_delta: deltas are append chunks, so superseding an
  // unacked chunk with a later one drops text from the middle of the draft.
  // A reconnecting Arm is re-seeded by its subscription snapshot instead.
  if (msg.type === 'card_action' && msg.sessionId) {
    return `card_action:${msg.sessionId}`;
  }
  if (msg.type === 'compacting' && msg.sessionId) {
    return `compacting:${msg.sessionId}`;
  }
  return undefined;
}

/**
 * Whether to follow a relay's `wrong_region` redirect. From an official
 * relay only to another official one (`wss://kraki.chat` or a subdomain); a
 * self-hosted relay may send its users elsewhere, but only over TLS (plain
 * `ws://` only to this machine). The computer authenticates at the redirect
 * target, so a hostile redirect would hand its connection to anyone.
 */
export function isAcceptableRegionRedirect(current: string, redirect: string): boolean {
  let to: URL;
  let from: URL | null = null;
  try { to = new URL(redirect); } catch { return false; }
  try { from = new URL(current); } catch { /* unknown current relay */ }
  const official = (u: URL) => u.hostname === 'kraki.chat' || u.hostname.endsWith('.kraki.chat');
  const loopback = (u: URL) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  if (to.protocol !== 'wss:' && !(to.protocol === 'ws:' && loopback(to))) return false;
  if (from && official(from)) return to.protocol === 'wss:' && official(to);
  return true;
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private adapter: AgentAdapter;
  private sessionManager: SessionManager;
  private keyManager: KeyManager | null;
  private options: RelayClientOptions;
  private state: RelayClientState = 'disconnected';
  /** Set after the first auth_ok of this process (see resumeDisconnectedSessions). */
  private startupSessionsNormalised = false;
  private reconnectAttempts = 0;
  /** Inputs (session + clientId) this process has admitted. Bounded by the
   *  process lifetime's input count (small strings). */
  private admittedInputs = new Set<string>();
  /** Behaviours each online app declared with `client_features` on its
   *  current connection (e.g. `fragments`). Cleared when it (re)joins/leaves. */
  private appFeatures = new Map<string, Set<string>>();
  /** Reassembles fragmented payloads from apps. */
  private payloadAssembler = new PayloadAssembler();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;
  private authInfo: AuthOkMessage | null = null;
  /** Cached consumer public keys for E2E encryption (includes offline devices for pushPreview) */
  private consumerKeys = new Map<string, string>();
  /** Device IDs of currently connected consumers. */
  private onlineConsumers = new Set<string>();
  /** Accepted in-memory single-session subscription for each connected Arm. */
  private currentSessionByArm = new Map<string, string | null>();
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
  private pendingRequestIds = new Map<string, string>();
  /** Message types that write to events.jsonl and should be persisted to messages.jsonl.
   *  New types default to NOT persisting/pausing the watcher — safer than the inverse.
   *
   *  Three-axis redesign: `tool_start`/`tool_complete` were removed. Tool
   *  activity keeps flowing live as a transient broadcast (like
   *  agent_message_delta) but no longer occupies a per-session spine seq nor
   *  persists here — it is mirrored to `trace.jsonl` and pulled on demand via
   *  `turn_trace_batch`, keyed by the concluding bubble's seq. */
  private static readonly PERSISTENT_TYPES = new Set([
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
  private seqCounter = 0;
  /** Per-session running count of the current turn's TRACE steps (tool_start +
   *  agent_narration). Reset on each user_message, incremented as steps stream,
   *  and stamped onto the turn's concluding bubble(s) (agent_message /
   *  system_message) as `payload.steps` so a concluded bubble can show its
   *  "Steps" affordance from replay alone. In-memory: a tentacle restart
   *  mid-turn just resets the count (the trace.jsonl data is unaffected). */
  private turnStepCounts = new Map<string, number>();
  /** Sessions whose current turn already has a spine outcome (reply, system
   *  notice or terminal status). Reset with the step counter per user turn. */
  private turnHasOutcome = new Set<string>();
  private legacyReplayWarned = new Set<string>();
  /** Prefer challenge auth when the relay already knows this device */
  private preferChallengeAuth = true;
  private reRegisteredKey = false;

  // ── Title generation state ──────────────────────────
  /** Turn count per session (for title generation scheduling) */
  private turnCounts = new Map<string, number>();
  /** Sessions currently generating a title (prevent concurrent generation) */
  private titleGenerationInFlight = new Set<string>();

  // ── Lazy resume state ──────────────────────────────
  /** In-flight `ensureSessionResumed` promises keyed by sessionId, so two
   *  concurrent callers don't double-resume the same SDK session. */
  private resumeInFlight = new Map<string, Promise<boolean>>();

  /** Normal prompts are serialized until the preceding turn reaches idle. */
  private inputChains = new Map<string, Promise<void>>();
  /** All adapter submissions are serialized only until transport acceptance.
   *  This lets an active-turn steer follow the original prompt ACK immediately
   *  without waiting for the whole turn to become idle. */
  private inputDispatches = new Map<string, Promise<void>>();
  /** Idle has no turn identity. Hold it while a steer is awaiting adapter ACK so
   *  pre-steer completion cannot settle the newly accepted interjection. */
  private steerAcceptanceInFlight = new Set<string>();
  private idleDuringSteerAcceptance = new Set<string>();
  private turnIdleWaiters = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  /** Adapter errors become terminal only when the same logical turn reaches
   *  idle. Keeping them pending avoids freezing recoverable tool failures. */
  private pendingTerminalErrors = new Map<string, { message: string; code?: string; source: 'adapter' | 'backend' | 'process'; turnId?: string }>();
  /** Last adapter idle boundary per logical turn. The old implementation used
   *  one Session-wide boolean, which let a late callback cross a turn boundary. */
  private settledAdapterTurnIds = new Map<string, string>();

  private activeInputTurnIds = new Map<string, string>();
  private nextInputTurnAnchors = new Map<string, number>();

  private beginAdapterTurn(sessionId: string, turnId?: string): string {
    const resolvedTurnId = turnId ?? `${sessionId}:${(this.nextInputTurnAnchors.get(sessionId) ?? 0) + 1}`;
    if (!turnId) this.nextInputTurnAnchors.set(sessionId, (this.nextInputTurnAnchors.get(sessionId) ?? 0) + 1);
    this.activeInputTurnIds.set(sessionId, resolvedTurnId);
    this.adapter.setTurnIdentity?.(sessionId, resolvedTurnId);
    return resolvedTurnId;
  }

  /** A terminal adapter event must identify the accepted turn it belongs to.
   *  Legacy adapters/tests may omit the token; those events retain the old
   *  fallback behavior, while tokenized events are strictly fenced. */
  private acceptsAdapterTurn(sessionId: string, turnId?: string): boolean {
    if (!turnId) return true;
    const activeTurnId = this.activeInputTurnIds.get(sessionId);
    if (activeTurnId === turnId) return true;
    traceLog.info({
      ns: process.hrtime.bigint().toString(),
      comp: 'tentacle',
      evt: 'ADAPTER-LATE-CALLBACK',
      sessionId,
      turnId,
      activeTurnId,
    });
    return false;
  }

  /** Non-terminal events must not mutate a turn after its terminal boundary.
   * Legacy untagged callbacks retain compatibility; real adapters tag every
   * turn-scoped event so a same-turn late callback is rejected here. */
  private acceptsAdapterEvent(sessionId: string, turnId?: string): boolean {
    if (!this.acceptsAdapterTurn(sessionId, turnId)) return false;
    if (turnId && this.settledAdapterTurnIds.get(sessionId) === turnId) {
      traceLog.info({
        ns: process.hrtime.bigint().toString(),
        comp: 'tentacle',
        evt: 'ADAPTER-SETTLED-CALLBACK',
        sessionId,
        turnId,
      });
      return false;
    }
    return true;
  }

  private inputFingerprint(
    text: string,
    attachments?: import('@kraki/protocol').Attachment[],
  ): { contentLength: number; contentHash: string } {
    const attachmentShape = (attachments ?? []).map((attachment) => ({
      type: attachment.type,
      mimeType: 'mimeType' in attachment ? attachment.mimeType : undefined,
      id: 'id' in attachment ? attachment.id : undefined,
      size: 'size' in attachment ? attachment.size : undefined,
      data: 'data' in attachment ? attachment.data : undefined,
    }));
    const content = JSON.stringify({ text, attachments: attachmentShape });
    return {
      contentLength: text.length,
      contentHash: createHash('sha256').update(content).digest('hex'),
    };
  }

  private reserveInput(
    sessionId: string,
    clientId: string | undefined,
    requestedDelivery: 'prompt' | 'steer',
    text: string,
    attachments?: import('@kraki/protocol').Attachment[],
  ): { duplicate: boolean; conflict: boolean; recovery: boolean; effectiveDelivery: 'prompt' | 'steer'; turnId: string; entry?: InputLedgerEntry } {
    const meta = this.sessionManager.getMeta(sessionId);
    const adapterSettled = this.adapter.isTurnSettled?.(sessionId) === true;
    const staleSteer = requestedDelivery === 'steer'
      && (
        meta?.state === 'idle'
        || meta?.state === 'disconnected'
        || adapterSettled
      );
    if (requestedDelivery === 'steer' && adapterSettled && meta?.state === 'active') {
      // Reconcile a terminal callback that Relay missed before opening the new
      // prompt. Otherwise the prior normal-input chain remains blocked forever
      // waiting for an idle the adapter has already crossed.
      const settledTurnId = this.activeInputTurnIds.get(sessionId);
      this.settleAdapterIdle(sessionId, settledTurnId ? { turnId: settledTurnId } : undefined);
    }
    const effectiveDelivery = staleSteer ? 'prompt' : requestedDelivery;
    const proposedAnchor = effectiveDelivery === 'steer'
      ? (meta?.currentTurnStartSeq ?? meta?.lastSeq ?? 0)
      : (meta?.lastSeq ?? 0) + 1;
    const turnAnchor = effectiveDelivery === 'steer'
      ? proposedAnchor
      : Math.max(proposedAnchor, (this.nextInputTurnAnchors.get(sessionId) ?? 0) + 1);
    if (effectiveDelivery === 'prompt') this.nextInputTurnAnchors.set(sessionId, turnAnchor);
    // An accepted active-turn steer stays inside the provider run that is
    // already in flight. Reuse its identity so provider callbacks captured at
    // that run boundary remain admissible; only a stale steer opens a new turn.
    const turnId = effectiveDelivery === 'steer' && !staleSteer
      ? this.activeInputTurnIds.get(sessionId) ?? `${sessionId}:${turnAnchor}`
      : `${sessionId}:${turnAnchor}`;
    if (!clientId) return { duplicate: false, conflict: false, recovery: false, effectiveDelivery, turnId };

    const fingerprint = this.inputFingerprint(text, attachments);
    const ledgerEntries = this.sessionManager.getInputLedger?.(sessionId) ?? [];
    const existing = this.sessionManager.getInputLedgerEntry?.(sessionId, clientId)
      ?? ledgerEntries.find((entry) => entry.clientId === clientId)
      ?? null;
    if (existing) {
      if (existing.contentHash !== fingerprint.contentHash) {
        return { duplicate: true, conflict: true, recovery: false, effectiveDelivery, turnId };
      }
      // Admitted by this process: it is queued or running right now. A client
      // retry (lost echo, reconnect) must not dispatch it a second time; the
      // recovery paths below are only for entries left by a previous process.
      if (this.admittedInputs.has(`${sessionId}\u0000${clientId}`) && existing.status !== 'rejected') {
        return { duplicate: true, conflict: false, recovery: false, effectiveDelivery, turnId, entry: existing };
      }
      // `persisted` means the user_message is durable but adapter dispatch has
      // not started. It is the only restart state that is safe to recover by
      // sending the replayed payload again. `dispatching` is deliberately
      // treated as at-most-once: the daemon may have crossed the adapter
      // boundary before it crashed, so replaying it could duplicate the turn.
      if ((existing.status === 'persisted' || existing.status === 'rejected') && existing.userSeq !== undefined) {
        // A rejected adapter call is known not to have been acknowledged. The
        // transcript row already exists, so retry the same clientId without
        // appending another user_message. `dispatching` remains at-most-once:
        // a crash may have crossed the adapter boundary before the state write.
        this.admittedInputs.add(`${sessionId}\u0000${clientId}`);
        return { duplicate: false, conflict: false, recovery: true, effectiveDelivery: existing.delivery === 'steer' ? 'steer' : 'prompt', turnId: existing.turnId, entry: existing };
      }
      if (existing.status === 'pending') {
        const recoveredSeq = this.sessionManager.findUserMessageSeqByClientId(sessionId, clientId);
        if (recoveredSeq !== null) {
          const recovered: InputLedgerEntry = {
            ...existing,
            status: 'persisted',
            userSeq: recoveredSeq,
            updatedAt: new Date().toISOString(),
          };
          this.sessionManager.recordInputLedger(sessionId, recovered);
          this.admittedInputs.add(`${sessionId}\u0000${clientId}`);
        return { duplicate: false, conflict: false, recovery: true, effectiveDelivery: recovered.delivery === 'steer' ? 'steer' : 'prompt', turnId: recovered.turnId, entry: recovered };
        }
        // The reservation survived but the transcript append did not. Reuse
        // its identity and perform the normal persistence path exactly once.
        this.admittedInputs.add(`${sessionId}\u0000${clientId}`);
        return { duplicate: false, conflict: false, recovery: false, effectiveDelivery: existing.delivery === 'steer' ? 'steer' : 'prompt', turnId: existing.turnId, entry: existing };
      }
      return { duplicate: true, conflict: false, recovery: false, effectiveDelivery, turnId, entry: existing };
    }

    // Only legacy sessions with no ledger need the compatibility transcript
    // scan. Once the durable index exists, the hot input path is O(1) in the
    // number of historical messages.
    const recoveredSeq = ledgerEntries.length === 0
      ? this.sessionManager.findUserMessageSeqByClientId(sessionId, clientId)
      : null;
    if (recoveredSeq !== null) {
      const recovered: InputLedgerEntry = {
        version: 1,
        clientId,
        status: 'persisted',
        requestedDelivery,
        delivery: effectiveDelivery,
        turnId,
        contentLength: fingerprint.contentLength,
        contentHash: fingerprint.contentHash,
        userSeq: recoveredSeq,
        updatedAt: new Date().toISOString(),
      };
      this.sessionManager.recordInputLedger(sessionId, recovered);
      // Without a matching ledger entry we cannot prove the replayed body is
      // the original body, so preserve at-most-once behavior for legacy data.
      return { duplicate: true, conflict: false, recovery: false, effectiveDelivery, turnId, entry: recovered };
    }

    const entry: InputLedgerEntry = {
      version: 1,
      clientId,
      status: 'pending',
      requestedDelivery,
      delivery: effectiveDelivery,
      turnId,
      contentLength: fingerprint.contentLength,
      contentHash: fingerprint.contentHash,
      updatedAt: new Date().toISOString(),
    };
    this.sessionManager.recordInputLedger(sessionId, entry);
    this.admittedInputs.add(`${sessionId}\u0000${clientId}`);
    return { duplicate: false, conflict: false, recovery: false, effectiveDelivery, turnId, entry };
  }

  private updateInputLedger(
    sessionId: string,
    clientId: string | undefined,
    status: InputLedgerEntry['status'],
    userSeq?: number,
  ): void {
    if (!clientId) return;
    const existing = this.sessionManager.getInputLedgerEntry(sessionId, clientId);
    if (!existing) return;
    this.sessionManager.recordInputLedger(sessionId, {
      ...existing,
      status,
      ...(userSeq !== undefined && { userSeq }),
      updatedAt: new Date().toISOString(),
    });
  }

  private waitForTurnIdle(sessionId: string): Promise<void> {
    const existing = this.turnIdleWaiters.get(sessionId);
    if (existing) return existing.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    this.turnIdleWaiters.set(sessionId, { promise, resolve });
    return promise;
  }

  private resolveTurnIdle(sessionId: string): void {
    // A terminal turn boundary also retires its transport-acceptance gate. Pi
    // can acknowledge abort while an older prompt RPC is still waiting behind
    // preflight compaction; that stale Promise must not serialize later input.
    // The underlying task remains observed and is fenced by its turn identity
    // if it ever completes, while a new dispatch may start immediately.
    this.inputDispatches.delete(sessionId);
    const waiter = this.turnIdleWaiters.get(sessionId);
    if (!waiter) return;
    this.turnIdleWaiters.delete(sessionId);
    waiter.resolve();
  }

  private beginSteerAcceptance(sessionId: string): void {
    this.steerAcceptanceInFlight.add(sessionId);
  }

  private finishSteerAcceptance(sessionId: string, accepted: boolean): void {
    this.steerAcceptanceInFlight.delete(sessionId);
    const deferredIdle = this.idleDuringSteerAcceptance.delete(sessionId);
    if (!deferredIdle) return;
    if (accepted) {
      // The old provider error was already broadcast immediately. A successful
      // interjection recovered the session, so it must not freeze as the outcome
      // of the newer work when that work eventually idles.
      this.pendingTerminalErrors.delete(sessionId);
    } else {
      this.settleAdapterIdle(sessionId);
    }
  }

  private settleAdapterIdle(sessionId: string, event?: { turnId?: string }): void {
    if (!this.acceptsAdapterTurn(sessionId, event?.turnId)) return;
    // Tokenized callbacks use their source identity. Only legacy callbacks fall
    // back to the currently active relay turn.
    const turnId = event?.turnId ?? this.activeInputTurnIds.get(sessionId);
    const idleTurnId = turnId ?? '__unidentified__';
    if (this.settledAdapterTurnIds.get(sessionId) === idleTurnId) return;
    const stagedError = this.pendingTerminalErrors.get(sessionId);
    const terminalError = stagedError && (!stagedError.turnId || stagedError.turnId === idleTurnId)
      ? stagedError
      : undefined;
    if (stagedError?.turnId && stagedError.turnId !== idleTurnId) {
      this.pendingTerminalErrors.delete(sessionId);
    }
    if (this.soleOpenQuestion(sessionId) && !terminalError) return;
    this.settledAdapterTurnIds.set(sessionId, idleTurnId);
    this.errorPersistedForTurn.delete(sessionId);
    if (turnId) {
      this.sessionManager.markInputLedgerSettled(sessionId, turnId);
      traceLog.info({
        ns: process.hrtime.bigint().toString(),
        comp: 'tentacle',
        evt: 'INPUT-SETTLED',
        sessionId,
        turnId,
        willRetry: false,
      });
    }
    if (terminalError) {
      this.pendingTerminalErrors.delete(sessionId);
      const { turnId: _turnId, ...terminalPayload } = terminalError;
      this.finishTurnWithStatus(sessionId, {
        type: 'failed',
        payload: {
          ...terminalPayload,
          failedAt: new Date().toISOString(),
        },
      });
    } else {
      this.clearOpenQuestions(sessionId);
      this.anchorStepsOnlyTurn(sessionId);
    }
    this.resolveTurnIdle(sessionId);
    this.sessionManager.markIdle(sessionId);
    // Compaction is an orthogonal maintenance axis. A successful turn may be
    // idle while threshold/manual compaction continues; its own end event clears
    // the runtime indicator. Overflow recovery never reaches this idle path.
    const usage = this.adapter.getSessionUsage(sessionId) ?? undefined;
    if (usage) this.sessionManager.setUsage(sessionId, usage);
    this.sendTurnIdle(
      sessionId,
      { usage, ...(terminalError && { reason: 'failed' as const }) },
      terminalError ? { failure: terminalError.message } : {},
    );
    // The closing idle changes the turn boundary — the agent reply / terminal
    // outcome now replaces the user_message as the preview anchor. Broadcast so
    // every arm's digest-derived preview advances authoritatively. Without this
    // a question/permission-less turn would never refresh the sidebar preview
    // (broadcastSessionList otherwise only fires on question/permission events).
    this.broadcastSessionList();
    this.maybeGenerateTitle(sessionId);
  }

  /** A turn that ended on tool calls with no closing prose is relayed as-is:
   *  it has Steps but no reply. Give those Steps a spine anchor (protocol
   *  SystemMessage kind `no_reply`, which clients render as a steps-only
   *  section) — for every agent alike, instead of each adapter improvising. */
  private anchorStepsOnlyTurn(sessionId: string): void {
    if (this.turnHasOutcome.has(sessionId)) return;
    if ((this.turnStepCounts.get(sessionId) ?? 0) === 0) return;
    this.card.onBubble(sessionId);
    this.send({ type: 'system_message', sessionId, payload: { kind: 'no_reply' } });
  }

  /** Persist the durable user-visible outputs of a genuine completed turn on
   *  its closing idle. Initialization/import/fork idles deliberately bypass
   *  this helper because they do not close a user turn. */
  private sendTurnIdle(
    sessionId: string,
    payload: Omit<IdleMessage['payload'], 'turnArtifacts'>,
    push: { failure?: string } | null = {},
  ): void {
    const turnArtifacts = this.sessionManager.readCurrentTurnArtifacts(sessionId);
    if (push) this.closingTurnPush.set(sessionId, push);
    else this.closingTurnPush.delete(sessionId);
    this.send({
      type: 'idle',
      sessionId,
      payload: {
        ...payload,
        ...(turnArtifacts.length > 0 && { turnArtifacts }),
      },
    }, payload.reason !== 'aborted');
    this.closingTurnPush.delete(sessionId);
  }

  private dispatchInput(sessionId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.inputDispatches.get(sessionId);
    const next = previous ? previous.catch(() => {}).then(task) : task();
    this.inputDispatches.set(sessionId, next);
    const cleanup = () => {
      if (this.inputDispatches.get(sessionId) === next) this.inputDispatches.delete(sessionId);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  // ── Push preview state ─────────────────────────────
  /** Final reply of the CURRENT turn per session (for the turn-end push).
   *  Cleared when a new user turn starts, so a turn that ends without a reply
   *  (steps only, failed) never re-sends the previous turn's text. */
  private lastAgentContent = new Map<string, string>();
  /** Terminal failure message of the turn currently closing, read by the
   *  closing idle's push preview. Set and cleared around sendTurnIdle. */
  private closingTurnPush = new Map<string, { failure?: string }>();

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
  private readonly sleepGuard = new SleepGuard();

  /** Turn whose first adapter error was already persisted, per session. */
  private errorPersistedForTurn = new Map<string, string>();
  private card = new CardManager((msg) => this.send(msg as Partial<ProducerMessage>));

  /** Sessions whose agent runtime is currently compacting context. The reason
   *  determines whether new user work may queue behind it: threshold/manual
   *  compaction is maintenance; overflow compaction remains part of recovery. */
  private compactingSessions = new Map<string, 'manual' | 'threshold' | 'overflow' | undefined>();
  /** Turn identity that started the currently active maintenance compaction.
   *  Compaction may finish after a queued follow-up has opened a newer logical
   *  turn, so its end callback must not be fenced against that newer turn. */
  private compactionTurnIds = new Map<string, string | undefined>();
  /** Follow-up inputs accepted while maintenance is active. They remain
   *  conversationally idle until compaction ends, then become active. */
  private maintenanceFollowUps = new Map<string, { accepted: boolean }>();

  /** Enter/leave transient compaction maintenance. This no longer overwrites
   *  the conversational session state: a completed turn may stay `idle` while
   *  threshold compaction runs, keeping the composer available. */
  private setCompacting(sessionId: string, active: boolean, reason?: 'manual' | 'threshold' | 'overflow'): void {
    if (active) {
      if (!this.compactingSessions.has(sessionId)) {
        this.compactingSessions.set(sessionId, reason);
        this.send({ type: 'compacting', sessionId, payload: { phase: 'start', ...(reason && { reason }) } });
      }
    } else if (this.compactingSessions.delete(sessionId)) {
      this.compactionTurnIds.delete(sessionId);
      const queued = this.maintenanceFollowUps.get(sessionId);
      const activate = queued?.accepted === true;
      const metaState = this.sessionManager.getMeta(sessionId)?.state;
      const nextState = activate || metaState === 'active' ? 'active' : 'idle';
      if (activate) {
        this.maintenanceFollowUps.delete(sessionId);
        this.sessionManager.markActive(sessionId);
      }
      this.send({ type: 'compacting', sessionId, payload: { phase: 'end', nextState } });
      if (activate) this.send({ type: 'active', sessionId, payload: {} });
    }
  }

  private acceptMaintenanceFollowUp(sessionId: string): void {
    const queued = this.maintenanceFollowUps.get(sessionId);
    if (!queued) return;
    queued.accepted = true;
    if (!this.compactingSessions.has(sessionId)) {
      this.maintenanceFollowUps.delete(sessionId);
      this.sessionManager.markActive(sessionId);
      this.send({ type: 'active', sessionId, payload: {} });
    }
  }

  /** Clear stale compacting for a session (idle / active turn start / end /
   *  process loss). Safe no-op when not compacting. */
  private clearCompacting(sessionId: string): void {
    this.setCompacting(sessionId, false);
  }

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
  /** True while send() relays an external events.jsonl change (see initEventsWatcher). */
  private mirroringExternalEvent = false;

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
        sendPulseFrame: (pulseB64, target) => this.sendPulseEnvelope(pulseB64, target),
        onDelivered: (blobB64) => this.handlePulseDelivered(blobB64),
      },
      `tentacle:${options.device.deviceId ?? 'local'}:${Date.now()}`,
    );
    this.wireAdapterEvents();
  }

  private readonly pulse: TentaclePulse;

  private readonly attachmentStore?: import('./attachment-store.js').AttachmentStore;

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

  /** Pending permissions used for stable sidebar attention previews. */
  private openPermissions = new Map<string, Map<string, { text: string; openedAt: string }>>();

  /** Open ask_user questions per session — the adapter is blocked waiting on
   *  the human. The question itself is on the spine; this map routes answers
   *  (`send_input.answerTo`) to the adapter and drives the session_list
   *  attention preview. Populated on onQuestionRequest, drained on answer /
   *  auto-resolve, cleared when the turn ends. Insertion order is preserved so
   *  the newest open question wins the preview slot. */
  private openQuestions = new Map<string, Map<string, PendingHumanAction>>();

  /** Record a newly-opened question and persist it for answer routing after a restart. */
  private addOpenQuestion(sessionId: string, pending: PendingHumanAction): void {
    let map = this.openQuestions.get(sessionId);
    if (!map) {
      map = new Map();
      this.openQuestions.set(sessionId, map);
    }
    map.set(pending.questionId, pending);
    this.sessionManager.savePendingHumanAction(sessionId, pending);
  }

  /** Drop a resolved/cancelled question for a session. */
  private removeOpenQuestion(sessionId: string, questionId: string): void {
    const map = this.openQuestions.get(sessionId);
    if (!map) return;
    map.delete(questionId);
    if (map.size === 0) {
      this.openQuestions.delete(sessionId);
      this.sessionManager.clearPendingHumanAction(sessionId);
    } else {
      let newest: PendingHumanAction | undefined;
      for (const pending of map.values()) newest = pending;
      if (newest) this.sessionManager.savePendingHumanAction(sessionId, newest);
    }
  }

  /** Clear all open human attention for a session (turn ended / session gone). */
  private clearOpenQuestions(sessionId: string): void {
    // Delete both maps independently: `a || b` short-circuited and leaked a
    // permission when a question was also open on the same session.
    const qChanged = this.openQuestions.delete(sessionId);
    const pChanged = this.openPermissions.delete(sessionId);
    this.sessionManager.clearPendingHumanAction(sessionId);
    if (qChanged || pChanged) this.broadcastSessionList();
  }

  private soleOpenQuestion(sessionId: string): PendingHumanAction | null {
    const map = this.openQuestions.get(sessionId);
    if (!map || map.size !== 1) return null;
    return map.values().next().value ?? null;
  }

  /** The newest open human attention item, preserving its original openedAt. */
  private latestOpenAttention(sessionId: string): { type: 'permission' | 'question'; text: string; openedAt: string } | undefined {
    let latest: { type: 'permission' | 'question'; text: string; openedAt: string } | undefined;
    for (const permission of this.openPermissions.get(sessionId)?.values() ?? []) {
      if (!latest || permission.openedAt >= latest.openedAt) latest = { type: 'permission', ...permission };
    }
    for (const question of this.openQuestions.get(sessionId)?.values() ?? []) {
      const candidate = { type: 'question' as const, text: question.question, openedAt: question.createdAt };
      if (!latest || candidate.openedAt >= latest.openedAt) latest = candidate;
    }
    return latest;
  }

  /** Rehydrate open questions (answer routing) before session-list snapshots. */
  private restorePendingHumanActions(): void {
    for (const meta of this.sessionManager.getSessionList({ all: true })) {
      const pending = this.sessionManager.getPendingHumanAction(meta.id);
      if (!pending) continue;
      let map = this.openQuestions.get(meta.id);
      if (!map) {
        map = new Map();
        this.openQuestions.set(meta.id, map);
      }
      map.set(pending.questionId, pending);
    }
  }

  /** Deliver through the original live request when possible. If the daemon/Pi
   *  process was reconstructed, continue transparently with a recovery prompt.
   *  The answer itself is already on the spine (`user_message.answerTo`). */
  private async deliverQuestionAnswer(
    sessionId: string,
    pending: PendingHumanAction,
    answer: { text: string; attachments?: import('@kraki/protocol').Attachment[] },
    turnId?: string,
  ): Promise<void> {
    // Choices are shortcuts: an answer equal to one of them is a pick.
    const wasFreeform = !(pending.choices ?? []).includes(answer.text);
    await this.ensureSessionResumed(sessionId);
    const result = await this.adapter.respondToQuestion(sessionId, pending.questionId, answer, wasFreeform);
    if (result !== 'accepted') {
      const answerText = answer.text || (answer.attachments?.length ? '[image attachment]' : '(no text)');
      const recoveryPrompt = [
        'A previous turn was interrupted while waiting for the user to answer this question:',
        pending.question,
        '',
        'The user has now answered:',
        answerText,
        '',
        'Continue the previous task using this answer. Do not ask the same question again unless the answer is genuinely insufficient.',
      ].join('\n');
      this.send({ type: 'active', sessionId, payload: {} });
      this.beginAdapterTurn(sessionId, turnId);
      this.sessionManager.markActive(sessionId);
      await this.sendToAdapter(sessionId, recoveryPrompt, answer.attachments);
    }

    this.removeOpenQuestion(sessionId, pending.questionId);
    this.broadcastSessionList();
  }

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

  /** Freeze the live card into a durable terminal status and close every
   *  unfinished TRACE action with the appropriate non-success outcome. */
  private finishTurnWithStatus(
    sessionId: string,
    action: Extract<CardActionState, { type: 'user_abort' | 'failed' }>,
  ): void {
    const termination = action.type === 'user_abort' ? 'cancelled' : 'interrupted';
    const snapshot = this.card.terminate(sessionId, action);

    for (const tool of snapshot.runningTools) {
      this.recordTrace({
        type: 'tool_complete',
        sessionId,
        payload: {
          ...tool.payload,
          success: false,
          termination,
          ...(tool.payload.subagent && { subagent: { ...tool.payload.subagent, status: termination === 'cancelled' ? 'stopped' : 'failed' } }),
        },
      });
      const id = tool.payload.toolCallId;
      if (id) {
        this.lastArgsByToolCallId.delete(id);
        this.lastArgsRefByToolCallId.delete(id);
      }
    }
    this.sessionToolCallIds.delete(sessionId);

    if (snapshot.previousAction?.type === 'permission' && !snapshot.previousAction.payload.decision) {
      this.recordTrace({
        type: 'permission',
        sessionId,
        payload: { ...snapshot.previousAction.payload, cancelled: true },
      });
    }

    const finishedAt = action.type === 'user_abort' ? action.payload.abortedAt : action.payload.failedAt;
    const steps = this.turnStepCounts.get(sessionId) ?? 0;
    this.send({
      type: 'turn_status',
      sessionId,
      payload: { draft: snapshot.draft, action, finishedAt, steps },
    }, action.type === 'failed');
    this.clearOpenQuestions(sessionId);
    this.card.clear(sessionId);
  }

  /** Drop any in-flight toolCallId state for a session — called when a
   *  session ends or is deleted. Without this, the toolCallId-keyed
   *  `lastArgs*` maps would leak entries for any tool call that didn't
   *  receive a matching `tool_complete` before the session went away. */
  private purgeSessionToolState(sessionId: string): void {
    this.errorPersistedForTurn.delete(sessionId);
    this.clearOpenQuestions(sessionId);
    this.turnStepCounts.delete(sessionId);
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

    // Bound the TCP/TLS/upgrade phase: a black-holed connect (Wi-Fi switch,
    // captive portal) otherwise waits for the OS TCP timeout before retrying.
    const ws = new WebSocket(this.options.relayUrl, { handshakeTimeout: 15_000, ...wsProxyOptions(this.options.relayUrl) });
    this.ws = ws;

    ws.on('open', () => {
      this.setState('authenticating');
      this.lastActivityAt = Date.now();
      this.startStaleCheck();
      const device = {
        ...this.options.device,
        publicKey: this.keyManager?.getCompactPublicKey(),
        // @coinfra/pulse ≥0.5.1: progress heartbeats never trigger resends.
        pulseProgressAck: true,
      };
      const auth = this.buildAuthPayload(device);
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
  private lastAutoArchiveAt = 0;

  /** Called from the 5s stale-check tick; sweeps at most every 6 hours. */
  private maybeAutoArchive(now: number): void {
    if (now - this.lastAutoArchiveAt < AUTO_ARCHIVE_SWEEP_MS) return;
    this.lastAutoArchiveAt = now;
    try {
      if (this.runAutoArchive(now)) this.broadcastSessionList();
    } catch (err) {
      logger.warn({ err }, 'Auto-archive sweep failed');
    }
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.sleepGuard.stop();
    this.stopStaleCheck();
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

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.type === 'auth_ok') {
      this.authInfo = msg as unknown as AuthOkMessage;
      this.preferChallengeAuth = true;
      this.reconnectAttempts = 0;
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
      this.restorePendingHumanActions();
      this.resumeDisconnectedSessions();
      this.sendGreetingBroadcast();
      this.broadcastAccountUsage();
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
          this.appFeatures.delete(device.id);
          this.attachmentPacer.notifyOnline(device.id);
          this.currentSessionByArm.set(device.id, null);
          // Send a greeting unicast so the app learns our capabilities
          this.sendGreetingTo(device.id, key);
          this.sendAccountUsageTo(device.id, key);
          // Send session list so the app can sync and establish its reconnect barrier.
          this.sendSessionListTo(device.id, key);
        }
      }
      return;
    }

    if (msg.type === 'device_left') {
      const deviceId = msg.deviceId as string;
      this.appFeatures.delete(deviceId);
      this.onlineConsumers.delete(deviceId);
      this.currentSessionByArm.delete(deviceId);
      return;
    }

    if (msg.type === 'device_removed') {
      const deviceId = msg.deviceId as string;
      this.appFeatures.delete(deviceId);
      this.consumerKeys.delete(deviceId);
      this.onlineConsumers.delete(deviceId);
      this.currentSessionByArm.delete(deviceId);
      this.attachmentPacer.drop(deviceId);
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

    // Anything else is not a consumer message. Consumer messages are accepted
    // ONLY after E2E decryption above (or via the Pulse path); a plaintext
    // frame from the relay must never reach handleConsumerMessage.
    logger.debug({ type: msg.type }, 'Ignoring unrecognized relay frame');
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

  /** An App that is sending to us is online. Presence frames from the Head can
   *  arrive stale (a `device_left` from before our last `auth_ok`, replayed by
   *  Pulse resume after a Tentacle restart), which would silently stop every
   *  broadcast to a connected App until it reconnects. */
  private noteAppAlive(deviceId: string | undefined): void {
    if (!deviceId || this.onlineConsumers.has(deviceId) || !this.consumerKeys.has(deviceId)) return;
    this.onlineConsumers.add(deviceId);
    if (!this.currentSessionByArm.has(deviceId)) this.currentSessionByArm.set(deviceId, null);
    this.attachmentPacer.notifyOnline(deviceId);
    logger.warn({ deviceId }, 'App marked offline is sending; restored as online');
  }

  /**
   * Apply an app's permission decision. The resolution is announced only when
   * a live pending request took it. A request that is still open here but gone
   * from the agent (timed out, session ended) is closed as cancelled so apps
   * stop showing it; a duplicate of an earlier decision (Pulse resend) is
   * ignored and never overrides the announced outcome.
   */
  private resolvePermission(sessionId: string, permissionId: string, decision: 'approve' | 'deny' | 'always_allow', reason: string): void {
    const verb = { approve: 'approve', deny: 'deny', always_allow: 'set always-allow for' }[decision];
    (reason
      ? this.adapter.respondToPermission(sessionId, permissionId, decision, reason)
      : this.adapter.respondToPermission(sessionId, permissionId, decision))
      .then((result) => {
        const wasOpen = this.openPermissions.get(sessionId)?.delete(permissionId) === true;
        if (result === 'not_found' || result === 'session_gone') {
          if (!wasOpen) return;
          this.card.resolvePrompt(sessionId, permissionId);
          this.broadcastSessionList();
          this.send({ type: 'permission_resolved', sessionId, payload: { permissionId, resolution: 'cancelled', reason: 'This request is no longer pending.' } });
          return;
        }
        this.card.resolvePrompt(sessionId, permissionId, { decision });
        this.broadcastSessionList();
        this.recordTrace({ type: 'permission', sessionId, payload: { id: permissionId, description: '', toolName: '', args: {}, decision } });
        const resolution = decision === 'approve'
          ? { resolution: 'approved' as const }
          : decision === 'deny'
            ? { resolution: 'denied' as const, ...(reason && { reason }) }
            : { resolution: 'always_allowed' as const };
        this.send({ type: 'permission_resolved', sessionId, payload: { permissionId, ...resolution } });
      })
      .catch((err) => {
        logger.error({ err, sessionId }, 'respondToPermission failed');
        this.send({ type: 'error', sessionId, payload: { message: `Failed to ${verb} permission: ${(err as Error).message}` } });
      });
  }

  private handleConsumerMessage(msg: ConsumerMessage): void {
    this.noteAppAlive(msg.deviceId);
    // Session/attachment ids become filesystem paths. Reject anything that is
    // not one of our id shapes before it reaches a handler.
    const p = (msg as { payload?: Record<string, unknown> }).payload ?? {};
    const ids = [msg.sessionId, p.sessionId, p.sourceSessionId, p.localSessionId,
      msg.type === 'request_attachment' ? p.id : undefined];
    if (ids.some((id) => id !== undefined && id !== null && id !== '' && !isSafeId(id))) {
      logger.warn({ type: msg.type, deviceId: msg.deviceId }, 'Dropped consumer message with an unsafe id');
      return;
    }
    if (msg.type === 'client_features') {
      const features = Array.isArray(msg.payload?.features) ? msg.payload.features.filter((f) => typeof f === 'string') : [];
      this.appFeatures.set(msg.deviceId, new Set(features));
      logger.info({ deviceId: msg.deviceId, features }, 'App features');
      return;
    }

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

    // request_turn_trace — pull one turn's tool trace (TRACE axis), keyed by
    // the concluding bubble's spine seq.
    if (msg.type === 'request_turn_trace') {
      this.handleTurnTrace(msg.deviceId, msg.payload.sessionId, msg.payload.bubbleSeq);
      return;
    }

    // set_session_subscription — atomically replace this Arm's one current
    // session and return the bounded live-ready snapshot in the ACK.
    if (msg.type === 'set_session_subscription') {
      if (msg.payload.sessionId && isSafeId(msg.payload.sessionId)) this.unarchiveOnUse(msg.payload.sessionId);
      this.handleSetSessionSubscription(msg.deviceId, msg.payload.sessionId);
      return;
    }

    // request_card — legacy explicit card pull. Subscription ACK is the normal
    // reconnect/session-open authority, but keep this endpoint for diagnostics.
    if (msg.type === 'request_card') {
      this.handleRequestCard(msg.deviceId, msg.payload.sessionId);
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

    // ── Archive (no sessionId) ───────────────────────────
    if (msg.type === 'request_archived_sessions') {
      this.handleRequestArchivedSessions(msg.deviceId, msg.payload?.requestId);
      return;
    }
    if (msg.type === 'set_auto_archive_days') {
      this.handleSetAutoArchiveDays(msg.payload?.days);
      return;
    }
    if (msg.type === 'delete_archived_sessions') {
      this.handleDeleteArchivedSessions();
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

    if (msg.type === 'update_device') {
      const p = msg.payload as { requestId?: unknown; when?: unknown } | undefined;
      const requestId = typeof p?.requestId === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(p.requestId) ? p.requestId : '';
      const when = p?.when === 'now' || p?.when === 'idle' ? p.when : undefined;
      if (this.onUpdateRequest) void this.onUpdateRequest(requestId, when);
      else this.sendUpdateStatus({ phase: 'failed', requestId, error: 'This computer can’t be updated remotely.' });
      return;
    }

    if (msg.type === 'refresh_account_usage') {
      void this.handleRefreshAccountUsage(msg.deviceId, msg.payload?.requestId);
      return;
    }

    if (msg.type === 'request_usage_history') {
      this.handleRequestUsageHistory(msg.deviceId, msg.payload?.since);
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
      if (msg.type === 'send_input' && isSafeId(sessionId)) this.unarchiveOnUse(sessionId);
      switch (msg.type) {
        case 'archive_session': {
          const archived = msg.payload.archived === true;
          // A running session stays in the list.
          if (archived && this.sessionManager.getSessionList({ all: true }).find((s) => s.id === sessionId)?.state === 'active') break;
          if (this.sessionManager.setArchived(sessionId, archived)) this.broadcastSessionList();
          break;
        }
        case 'send_input': {
          const clientId = msg.payload.clientId as string | undefined;
          const requestedDelivery = msg.payload.delivery === 'steer' ? 'steer' as const : 'prompt' as const;
          const reservation = this.reserveInput(
            sessionId,
            clientId,
            requestedDelivery,
            msg.payload.text,
            msg.payload.attachments,
          );
          traceLog.info({
            ns: process.hrtime.bigint().toString(),
            comp: 'tentacle',
            evt: reservation.conflict ? 'INPUT-REJECTED' : reservation.duplicate ? 'INPUT-DUPLICATE' : 'APP-SEND-INPUT',
            sessionId,
            clientId,
            textLen: (msg.payload.text || '').length,
            hasAttachments: !!msg.payload.attachments?.length,
            requestedDelivery,
            delivery: reservation.effectiveDelivery,
            turnId: reservation.turnId,
            recovery: reservation.recovery,
            contentHash: reservation.entry?.contentHash,
          });
          if (reservation.conflict) {
            this.send({ type: 'error', sessionId, payload: { message: 'Input clientId was already used for different content.' } });
            break;
          }
          if (reservation.duplicate) {
            // A retry of an input we already hold (its echo was lost or is
            // still queued). Re-echo the stored row to the sender so it can
            // settle the optimistic bubble; never run the turn twice.
            if (clientId) this.reechoInput(msg.deviceId, sessionId, clientId);
            break;
          }

          const inputEntry = reservation.entry;
          const effectiveDelivery = reservation.effectiveDelivery;
          // An answer targets an open question explicitly (`answerTo`); a
          // composer message without it answers the sole open question. An
          // `answerTo` for a question that is no longer open is delivered as
          // an ordinary message (not recorded as an answer).
          const requestedAnswerTo = msg.payload.answerTo as string | undefined;
          const answering = requestedAnswerTo
            ? this.openQuestions.get(sessionId)?.get(requestedAnswerTo) ?? null
            : this.soleOpenQuestion(sessionId);
          let persistedSeq = inputEntry?.userSeq;
          if (!reservation.recovery) {
            const userMessage = {
              type: 'user_message' as const,
              sessionId,
              payload: {
                content: msg.payload.text,
                ...(msg.payload.attachments?.length && { attachments: msg.payload.attachments }),
                ...(msg.payload.clientId && { clientId: msg.payload.clientId }),
                ...(effectiveDelivery === 'steer' && !answering && { delivery: 'steer' as const }),
                ...(answering && { answerTo: answering.questionId }),
              },
            };
            this.send(userMessage);
            // send() assigns the per-session sequence by mutating the outbound
            // message. Reuse it instead of rescanning messages.jsonl.
            persistedSeq = (userMessage as typeof userMessage & { seq?: number }).seq;
            this.updateInputLedger(sessionId, clientId, 'persisted', persistedSeq);
          }
          traceLog.info({
            ns: process.hrtime.bigint().toString(),
            comp: 'tentacle',
            evt: 'INPUT-PERSISTED',
            sessionId,
            clientId,
            seq: persistedSeq ?? undefined,
            turnId: reservation.turnId,
            textLen: msg.payload.text.length,
            contentHash: inputEntry?.contentHash,
          });

          if (answering) {
            this.updateInputLedger(sessionId, clientId, 'dispatching');
            const delivery = this.deliverQuestionAnswer(sessionId, answering, {
              text: msg.payload.text === '[image]' ? '' : msg.payload.text,
              attachments: msg.payload.attachments,
            }, reservation.turnId);
            void delivery.then(() => {
              this.updateInputLedger(sessionId, clientId, 'delivered');
            }).catch((err) => {
              this.updateInputLedger(sessionId, clientId, 'rejected');
              logger.error({ err, sessionId }, 'question answer from composer failed');
              this.send({ type: 'error', sessionId, payload: { message: describeFailure('Failed to deliver answer', err) } });
            });
            break;
          }
          if (!requestedAnswerTo && (this.openQuestions.get(sessionId)?.size ?? 0) > 1) {
            this.updateInputLedger(sessionId, clientId, 'rejected');
            this.send({ type: 'error', sessionId, payload: { message: 'Multiple questions are pending. Answer the intended question directly.' } });
            break;
          }

          if (effectiveDelivery === 'steer') {
            void this.dispatchInput(sessionId, async () => {
              this.beginSteerAcceptance(sessionId);
              await this.ensureSessionResumed(sessionId);
              // Reassert active after resume so an idle/send race cannot leave a
              // successfully accepted interjection running behind an idle UI.
              this.send({ type: 'active', sessionId, payload: {} });
              this.beginAdapterTurn(sessionId, reservation.turnId);
              this.sessionManager.markActive(sessionId);
              traceLog.info({ ns: process.hrtime.bigint().toString(), comp: 'tentacle', evt: 'APP-ADAPTER-STEER', sessionId, clientId, turnId: reservation.turnId });
              this.updateInputLedger(sessionId, clientId, 'dispatching');
              const delivery = this.sendToAdapter(sessionId, msg.payload.text, msg.payload.attachments, { delivery: 'steer' });
              await delivery;
              this.updateInputLedger(sessionId, clientId, 'delivered');
              traceLog.info({
                ns: process.hrtime.bigint().toString(),
                comp: 'tentacle',
                evt: 'INPUT-DELIVERED',
                sessionId,
                clientId,
                turnId: reservation.turnId,
                delivery: 'steer',
              });
              // The adapter ACK is the ownership boundary for the interjection.
              // Reassert active so an idle from the pre-steer work that raced the
              // ACK cannot become the final visible state. A later provider idle
              // still settles the steered work normally.
              this.finishSteerAcceptance(sessionId, true);
              this.send({ type: 'active', sessionId, payload: {} });
              this.sessionManager.markActive(sessionId);
            }).catch((err) => {
              this.updateInputLedger(sessionId, clientId, 'rejected');
              this.finishSteerAcceptance(sessionId, false);
              logger.error({ err, sessionId }, 'steer input failed');
              this.send({ type: 'error', sessionId, payload: { message: describeFailure('Failed to steer agent', err) } });
            });
            break;
          }

          const previous = this.inputChains.get(sessionId);
          const deliver = async () => {
            const idle = this.waitForTurnIdle(sessionId);
            try {
              const dispatch = this.dispatchInput(sessionId, async () => {
                await this.ensureSessionResumed(sessionId);
                const compactionReason = this.compactingSessions.get(sessionId);
                const queueBehindMaintenance = this.sessionManager.getMeta(sessionId)?.state === 'idle'
                  && (compactionReason === 'threshold' || compactionReason === 'manual');
                if (queueBehindMaintenance) {
                  this.maintenanceFollowUps.set(sessionId, { accepted: false });
                } else {
                  this.send({ type: 'active', sessionId, payload: {} });
                  this.sessionManager.markActive(sessionId);
                }
                this.beginAdapterTurn(sessionId, reservation.turnId);
                traceLog.info({ ns: process.hrtime.bigint().toString(), comp: 'tentacle', evt: 'APP-ADAPTER-SEND', sessionId, clientId, queueBehindMaintenance, turnId: reservation.turnId });
                this.updateInputLedger(sessionId, clientId, 'dispatching');
                const delivery = queueBehindMaintenance
                  ? this.sendToAdapter(sessionId, msg.payload.text, msg.payload.attachments, { delivery: 'follow_up' })
                  : this.sendToAdapter(sessionId, msg.payload.text, msg.payload.attachments);
                await delivery;
                // Abort/process-loss may terminalize this turn while its adapter
                // submission is still unresolved. Never let a late completion
                // regress a settled ledger row or activate stale maintenance.
                if (!this.acceptsAdapterEvent(sessionId, reservation.turnId)
                  || this.adapter.isTurnSettled(sessionId)) return;
                if (queueBehindMaintenance) this.acceptMaintenanceFollowUp(sessionId);
                this.updateInputLedger(sessionId, clientId, 'delivered');
                traceLog.info({
                  ns: process.hrtime.bigint().toString(),
                  comp: 'tentacle',
                  evt: 'INPUT-DELIVERED',
                  sessionId,
                  clientId,
                  turnId: reservation.turnId,
                  delivery: queueBehindMaintenance ? 'follow_up' : 'prompt',
                });
                traceLog.info({ ns: process.hrtime.bigint().toString(), comp: 'tentacle', evt: 'APP-ADAPTER-DONE', sessionId, clientId, turnId: reservation.turnId });
              });
              // Usually transport acceptance wins and we then wait for provider
              // idle. Explicit abort is the inverse: idle is authoritative even
              // if a preflight prompt RPC never ACKs, so release the input chain
              // without waiting for that stale transport Promise.
              const firstBoundary = await Promise.race([
                dispatch.then(() => 'accepted' as const),
                idle.then(() => 'idle' as const),
              ]);
              if (firstBoundary === 'idle') return;
              await idle;
            } catch (err) {
              this.resolveTurnIdle(sessionId);
              throw err;
            }
          };
          const next = (previous ? previous.catch(() => {}).then(deliver) : deliver())
            .catch((err) => {
              this.maintenanceFollowUps.delete(sessionId);
              this.updateInputLedger(sessionId, clientId, 'rejected');
              logger.error({ err, sessionId }, 'send input failed');
              this.send({ type: 'error', sessionId, payload: { message: describeFailure('Failed to deliver message', err) } });
            })
            .finally(() => {
              if (this.inputChains.get(sessionId) === next) this.inputChains.delete(sessionId);
            });
          this.inputChains.set(sessionId, next);
          break;
        }
        case 'approve':
        case 'deny':
        case 'always_allow': {
          const decision = msg.type;
          const reason = decision === 'deny' && typeof (msg.payload as { reason?: unknown }).reason === 'string'
            ? ((msg.payload as { reason: string }).reason).trim().slice(0, 2000)
            : '';
          this.resolvePermission(sessionId, msg.payload.permissionId, decision, reason);
          break;
        }
        case 'kill_session':
          this.adapter.killSession(sessionId)
            .catch((err) => logger.error({ err, sessionId }, 'killSession failed'));
          break;
        case 'abort_session': {
          const snapshot = this.card.state(sessionId);
          this.adapter.abortSession(sessionId)
            .then(() => {
              // An open question is visible state too: record the abort so
              // the conversation shows "User aborted" after it.
              if (snapshot.draft || snapshot.action || this.openQuestions.has(sessionId)) {
                this.finishTurnWithStatus(sessionId, {
                  type: 'user_abort',
                  payload: { abortedAt: new Date().toISOString() },
                });
              } else {
                this.clearOpenQuestions(sessionId);
                this.card.clear(sessionId);
              }
              this.pendingTerminalErrors.delete(sessionId);
              const turnId = this.activeInputTurnIds.get(sessionId);
              this.settledAdapterTurnIds.set(sessionId, turnId ?? '__unidentified__');
              if (turnId) this.sessionManager.markInputLedgerSettled(sessionId, turnId);
              this.resolveTurnIdle(sessionId);
              this.sessionManager.markIdle(sessionId);
              this.clearCompacting(sessionId);
              // The user stopped this turn themselves: no turn-end push.
              this.sendTurnIdle(sessionId, { reason: 'aborted' }, null);
              // Turn boundary changed (aborted outcome). See settleAdapterIdle.
              this.broadcastSessionList();
            })
            .catch((err) => {
              logger.error({ err, sessionId }, 'abortSession failed');
              this.send({ type: 'error', sessionId, payload: { message: `Failed to abort session: ${(err as Error).message}` } });
            });
          break;
        }
        case 'delete_session':
          this.deleteSessionEverywhere(sessionId);
          break;
        case 'mark_read': {
          const readSeq = this.sessionManager.markRead(sessionId, msg.payload.seq);
          if (readSeq !== null) {
            this.send({
              type: 'session_read',
              sessionId,
              payload: { seq: readSeq },
            });
          }
          break;
        }
        case 'mark_unread': {
          const rolledBack = this.sessionManager.markUnread(sessionId);
          if (rolledBack !== null) {
            this.send({
              type: 'session_read',
              sessionId,
              payload: { seq: rolledBack },
            });
          }
          break;
        }
        case 'set_session_mode': {
          const mode = normalizeSessionMode(msg.payload.mode);
          this.adapter.setSessionMode(sessionId, mode);
          this.sessionManager.setMode(sessionId, mode);
          this.send({
            type: 'session_mode_set',
            sessionId,
            payload: { mode: toWireSessionMode(mode) },
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
          const previousMeta = this.sessionManager.getMeta(sessionId);
          const previousModel = previousMeta?.model;
          const previousReasoningEffort = previousMeta?.reasoningEffort;
          // Persist the intent before adapter resume so adapters that rebuild a
          // disconnected SDK session can restore the requested model and effort.
          // Roll both back if the adapter rejects the change; never acknowledge
          // configuration that did not reach the agent runtime.
          this.sessionManager.setModel(sessionId, model, reasoningEffort);
          // Pi must see the explicit model before generic lazy resume: a retired
          // provider in pi.jsonl can otherwise make pi exit before set_model.
          // Other agents retain the established resume-then-set ordering.
          const applyModel = this.sessionManager.getMeta(sessionId)?.agent === 'pi'
            ? this.adapter.setSessionModel(sessionId, model, reasoningEffort, contextTier)
                .then(() => this.ensureSessionResumed(sessionId, false, false))
            : this.ensureSessionResumed(sessionId, true, false)
                .then(() => this.adapter.setSessionModel(sessionId, model, reasoningEffort, contextTier));
          applyModel
            .then(() => {
              this.send({
                type: 'session_model_set',
                sessionId,
                payload: { model, reasoningEffort, contextTier },
              });
            })
            .catch((err) => {
              if (previousModel) {
                this.sessionManager.setModel(sessionId, previousModel, previousReasoningEffort);
              }
              logger.error({ err, sessionId }, 'setSessionModel failed');
              this.send({ type: 'error', sessionId, payload: { message: describeFailure('Failed to change model', err) } });
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
      // Without an explicit folder the agent works in the user's home, never
      // the filesystem root.
      const result = await this.adapter.createSession({ model, reasoningEffort, contextTier, cwd: cwd || homedir(), sessionId: preSessionId, agentId });

      // If an initial prompt was provided, send it to the new session.
      // Otherwise mark idle — the SDK only fires session.idle after a turn
      // completes, so without a prompt the session would stay 'active' forever.
      if (prompt && result.sessionId) {
        this.beginAdapterTurn(result.sessionId);
        await this.adapter.sendMessage(result.sessionId, prompt);
      } else if (result.sessionId) {
        this.sessionManager.markIdle(result.sessionId);
        this.send({ type: 'idle', sessionId: result.sessionId, payload: {} });
      }
    } catch (err) {
      this.pendingRequestIds.delete(preSessionId);
      const errorMsg = `Couldn't create the session: ${(err as Error).message}`;
      logger.warn({ err, agentId, model }, 'create_session failed');
      this.send({
        type: 'error',
        sessionId: '',
        payload: { message: errorMsg, ...(requestId && { requestId }) },
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

      // 2. Fork SDK session state and resume. Some adapters (currently
      // Copilot) emit onSessionCreated themselves, while others (Pi) only
      // return after the fork is ready. If the adapter did not consume the
      // pending requestId through that callback, publish session_created here
      // so the requesting Arm can clear its pending state and navigate.
      await this.adapter.forkSession(sourceSessionId, newId);
      const forkedMode = this.sessionManager.getMeta(newId)?.mode;
      if (forkedMode) this.adapter.setSessionMode(newId, forkedMode);
      const pendingRequestId = this.pendingRequestIds.get(newId);
      if (pendingRequestId) {
        this.pendingRequestIds.delete(newId);
        const meta = this.sessionManager.getMeta(newId);
        this.send({
          type: 'session_created',
          sessionId: newId,
          payload: {
            agent: meta?.agent,
            model: meta?.model,
            requestId: pendingRequestId,
            lastSeq: meta?.lastSeq ?? 0,
            ...(meta?.mode && { mode: toWireSessionMode(meta.mode) }),
          },
        } as Partial<ProducerMessage>);
      }

      // 3. Forked session is idle until the user sends a message
      this.sessionManager.markIdle(newId);
      this.send({ type: 'idle', sessionId: newId, payload: {} });

    } catch (err) {
      for (const [sessionId, pendingId] of this.pendingRequestIds) {
        if (pendingId === requestId) this.pendingRequestIds.delete(sessionId);
      }
      logger.error({ err, sourceSessionId }, 'Fork session failed');
      const errorMsg = `Couldn't copy the session: ${(err as Error).message}`;
      this.send({
        type: 'error',
        sessionId: '',
        payload: { message: errorMsg, ...(requestId && { requestId }) },
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
      const krakiSessionIds = new Set(this.sessionManager.getSessionList({ all: true }).map(s => s.id));
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
        payload: { message: `Session already imported as ${existing.krakiSessionId}`, ...(requestId && { requestId }) },
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
      const cwd = clientMeta?.cwd ?? parsedMeta.cwd ?? homedir();

      // Create Kraki session
      this.sessionManager.createSession('copilot', model, krakiSessionId);

      // Persist metadata
      this.sessionManager.updateMeta(krakiSessionId, {
        source,
        autoTitle,
        model,
        createdAt: clientMeta?.startTime,
      });

      // Batch-write the backfilled spine (single write instead of N appends),
      // in the same envelope shape send() persists. Tool activity is not on
      // the spine (it would take seqs that every reader then skips).
      const deviceId = this.authInfo?.deviceId ?? '';
      const spineRows = backfilledMessages
        .filter((m) => RelayClient.PERSISTENT_TYPES.has(m.type))
        .map((m) => ({
          type: m.type,
          ts: m.ts,
          payload: JSON.stringify({
            type: m.type, sessionId: krakiSessionId, deviceId, timestamp: m.ts, payload: JSON.parse(m.payload),
          }),
        }));
      const lastSeq = this.sessionManager.appendMessagesBatch(krakiSessionId, spineRows, true);

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

      // No history broadcast: apps fetch it with request_session_messages
      // when they open the session (the old session_replay_batch pushed up
      // to 500 messages to every app).

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

      logger.info({ localSessionId, krakiSessionId, backfilled: spineRows.length, adapterFailed }, 'Session imported');

      // Start watching events.jsonl for external changes (CLI, VS Code)
      this.eventsWatcher?.watch(krakiSessionId);

    } catch (err) {
      logger.error({ err, localSessionId }, 'Import session failed');
      this.send({
        type: 'error',
        sessionId: localSessionId,
        payload: { message: `Couldn't import the session: ${(err as Error).message}`, ...(requestId && { requestId }) },
      });
    }
  }

  // ── Events watcher for imported sessions ──────────────

  private initEventsWatcher(): void {
    if (this.eventsWatcher) this.eventsWatcher.close();

    this.eventsWatcher = new EventsWatcher(
      (msg) => {
        // Broadcast external events to all arms; send() persists spine types
        // itself (appending here too wrote every external event twice).
        this.mirroringExternalEvent = true;
        try {
          this.send({
            ...msg,
            deviceId: this.authInfo?.deviceId ?? '',
          } as unknown as Partial<ProducerMessage>);
        } finally {
          this.mirroringExternalEvent = false;
        }
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
        this.sessionManager.createSession(
          event.agent,
          event.model,
          event.sessionId,
          event.reasoningEffort,
        );
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
        payload: {
          agent: event.agent,
          model: event.model ?? meta?.model,
          reasoningEffort: event.reasoningEffort ?? meta?.reasoningEffort,
          requestId,
          lastSeq: meta?.lastSeq ?? 0,
          mode: toWireSessionMode(meta?.mode ?? DEFAULT_SESSION_MODE),
        },
      });
    };

    this.adapter.onMessage = (sessionId, event) => {
      if (!this.acceptsAdapterEvent(sessionId, event.turnId)) return;
      // A genuine final reply is authoritative for the turn. Any provider error
      // broadcast before recovery must not be frozen as the outcome at idle.
      this.pendingTerminalErrors.delete(sessionId);
      // Clear the server-side draft state FIRST so a reconnect snapshot doesn't
      // re-seed a stale draft; arms clear the live draft in the SAME store update
      // that lands this permanent bubble (no double-render flash). onBubble does
      // NOT broadcast an empty reset (that clear-then-re-add was the flicker).
      this.card.onBubble(sessionId);
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
      if (!this.acceptsAdapterEvent(sessionId, event.turnId)) return;
      // Streaming narration/progress prose → the draft bubble (coalesced in
      // send()). Rendered as a clean in-flow spine bubble, kept-last per segment.
      this.card.onDelta(sessionId, event.content);
    };

    // Finalized narration prose. Two decoupled axes:
    //  • onNarration → LIVE card reconcile only (onNarrationFinal). Fires on
    //    EVERY finalized segment so the streamed draft is reconciled in place
    //    before the concluding bubble lands (no draft→spine size-jump).
    //  • onNarrationTrace → TRACE axis only: mirror to trace.jsonl for the lazy
    //    "Steps" history. Adapters fire this ONLY for segments that are genuine
    //    intermediate steps — never the trailing one that graduates into the
    //    bubble — so a reply never shows duplicated (last Step + bubble).
    this.adapter.onNarration = (sessionId, event) => {
      if (!this.acceptsAdapterEvent(sessionId, event.turnId)) return;
      this.card.onNarrationFinal(sessionId, event.content);
    };
    this.adapter.onNarrationTrace = (sessionId, event) => {
      if (!this.acceptsAdapterEvent(sessionId, event.turnId)) return;
      this.recordTrace({ type: 'agent_narration', sessionId, payload: { content: event.content, ...(event.parentToolCallId && { parentToolCallId: event.parentToolCallId }) } });
    };

    this.adapter.onPermissionRequest = (sessionId, event) => {
      if (!this.acceptsAdapterEvent(sessionId, event.turnId)) return;
      const action = {
        type: 'permission' as const,
        payload: { ...event.toolArgs, id: event.id, description: event.description },
      };
      this.card.onPrompt(sessionId, action);
      let permissions = this.openPermissions.get(sessionId);
      if (!permissions) {
        permissions = new Map();
        this.openPermissions.set(sessionId, permissions);
      }
      permissions.set(event.id, {
        text: event.description || event.toolArgs.toolName,
        openedAt: new Date().toISOString(),
      });
      this.broadcastSessionList();
      this.recordTrace({ type: 'permission', sessionId, payload: { ...action.payload, ...(event.parentToolCallId && { parentToolCallId: event.parentToolCallId }) } });
    };

    // Auto-resolved (e.g. by an Always Allow rule) — mark the slot approved.
    this.adapter.onPermissionAutoResolved = (sessionId, permissionId) => {
      this.card.resolvePrompt(sessionId, permissionId, { decision: 'approve' });
      this.openPermissions.get(sessionId)?.delete(permissionId);
      this.broadcastSessionList();
      this.recordTrace({ type: 'permission', sessionId, payload: { id: permissionId, description: '', toolName: '', args: {}, decision: 'approve' } });
    };

    // Withdrawn by the agent (timeout/cancel): stop routing answers to it. On
    // the spine the question closes as unanswered once anything else follows.
    this.adapter.onQuestionAutoResolved = (sessionId, questionId) => {
      this.removeOpenQuestion(sessionId, questionId);
      this.broadcastSessionList();
    };

    // The question lands on the spine as an agent_message: its content is the
    // live draft (the agent's lead-in), taken atomically so the explanation and
    // the question can never be shown apart. It does not conclude the turn.
    this.adapter.onQuestionRequest = (sessionId, event) => {
      if (!this.acceptsAdapterEvent(sessionId, event.turnId)) return;
      const lead = this.card.state(sessionId).draft;
      this.card.onBubble(sessionId);
      const message = {
        type: 'agent_message' as const,
        sessionId,
        payload: {
          content: lead,
          question: {
            id: event.id,
            text: event.question,
            ...(event.choices?.length ? { choices: event.choices } : {}),
          },
        },
      };
      // A question waiting on the human is an attention boundary (badge).
      this.send(message, true);
      const questionSeq = (message as typeof message & { seq?: number }).seq;
      this.addOpenQuestion(sessionId, {
        version: 2,
        kind: 'question',
        questionId: event.id,
        question: event.question,
        ...(event.choices?.length ? { choices: event.choices } : {}),
        ...(questionSeq ? { questionSeq } : {}),
        createdAt: new Date().toISOString(),
      });
      this.broadcastSessionList();
    };

    this.adapter.onToolStart = (sessionId, event) => {
      if (!this.acceptsAdapterEvent(sessionId, event.turnId)) return;
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
      const toolStartMsg = {
        type: 'tool_start',
        sessionId,
        payload: {
          toolName: event.toolName,
          headline,
          ...(argsRef && { argsRef }),
          ...(inlineArgs && { args: inlineArgs }),
          toolCallId: event.toolCallId,
          ...(event.parentToolCallId && { parentToolCallId: event.parentToolCallId }),
          ...(event.subagent && { subagent: event.subagent }),
        },
      };
      // Off-spine: mirror to trace.jsonl for the lazy "Steps" history, and fold
      // into the card's action slot — no live standalone broadcast.
      this.recordTrace(toolStartMsg);
      this.card.onToolStart(sessionId, {
        type: 'tool_start',
        payload: {
          toolName: event.toolName,
          headline,
          ...(argsRef && { argsRef }),
          toolCallId: event.toolCallId,
          // Kept so a turn-end synthetic completion stays under its subagent.
          ...(event.parentToolCallId && { parentToolCallId: event.parentToolCallId }),
          ...(event.subagent && { subagent: event.subagent }),
        },
      });
      // Track key files from tool usage
      if (/^(?:read_file|write_file|view|edit|create|read|write|multiedit|notebookedit)$/i.test(event.toolName)) {
        const toolArgs = (event.args ?? {}) as Record<string, unknown>;
        const path = (typeof toolArgs.path === 'string' ? toolArgs.path : typeof toolArgs.file_path === 'string' ? toolArgs.file_path : undefined);
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
      if (!this.acceptsAdapterEvent(sessionId, event.turnId)) return;
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
      const toolCompleteMsg = {
        type: 'tool_complete',
        sessionId,
        payload: {
          toolName: event.toolName,
          headline,
          ...(resultRef && { resultRef }),
          ...(argsRef && { argsRef }),
          ...(inlineArgs && { args: inlineArgs }),
          toolCallId: event.toolCallId,
          ...(event.parentToolCallId && { parentToolCallId: event.parentToolCallId }),
          ...(event.subagent && { subagent: event.subagent }),
          ...(event.success === false && { success: false }),
          ...(event.attachments?.length && { attachments: event.attachments }),
        },
      };
      this.recordTrace(toolCompleteMsg);
      this.card.onToolComplete(sessionId, {
        type: 'tool_complete',
        payload: {
          toolName: event.toolName,
          headline,
          ...(resultRef && { resultRef }),
          ...(argsRef && { argsRef }),
          toolCallId: event.toolCallId,
          ...(event.success === false && { success: false }),
          ...(event.attachments?.length && { attachments: event.attachments }),
        },
      });
    };

    this.adapter.onIdle = (sessionId, event) => {
      if (!this.acceptsAdapterTurn(sessionId, event?.turnId)) return;
      if (this.steerAcceptanceInFlight.has(sessionId)) {
        this.idleDuringSteerAcceptance.add(sessionId);
        return;
      }
      this.settleAdapterIdle(sessionId, event);
    };

    this.adapter.onFlushComplete = (sessionId) => {
      this.eventsWatcher?.resume(sessionId);
    };

    this.adapter.onUsageUpdate = (sessionId, usage) => {
      this.sessionManager.setUsage(sessionId, usage);
    };

    this.adapter.onCompaction = (sessionId, event) => {
      // Compaction is maintenance, not a turn-scoped terminal callback. Its
      // end may arrive after a follow-up has opened a newer logical turn, so
      // retain the owner identity from start and fence against that identity
      // rather than against the current active turn.
      if (event.phase === 'start') {
        if (!this.acceptsAdapterTurn(sessionId, event.turnId)) return;
        if (!this.compactingSessions.has(sessionId)) {
          this.compactionTurnIds.set(sessionId, event.turnId);
        }
        this.setCompacting(sessionId, true, event.reason);
        return;
      }
      const ownerTurnId = this.compactionTurnIds.get(sessionId);
      if (event.turnId && ownerTurnId && event.turnId !== ownerTurnId) return;
      this.setCompacting(sessionId, false);
    };

    this.adapter.onError = (sessionId, event) => {
      if (!this.acceptsAdapterEvent(sessionId, event.turnId)) return;
      const activeTurnId = event.turnId ?? this.activeInputTurnIds.get(sessionId) ?? '__unidentified__';

      // Stage as the terminal outcome so idle freezes it as a `failed` card,
      // AND broadcast the error immediately so apps surface it without waiting
      // for the turn to settle. Keep the best available text: concrete provider
      // failures outrank generic enum values, and invalid values use a safe
      // fallback rather than surfacing `success` or `unknown` as an error.
      const candidate = normalizeTerminalErrorMessage(event.message);
      const current = this.pendingTerminalErrors.get(sessionId);
      const currentForTurn = current?.turnId === activeTurnId ? current : undefined;
      const currentQuality = currentForTurn
        ? normalizeTerminalErrorMessage(currentForTurn.message).quality
        : -1;
      const selected = !currentForTurn || candidate.quality > currentQuality
        ? { message: candidate.message, source: 'backend' as const, turnId: activeTurnId }
        : currentForTurn;
      this.pendingTerminalErrors.set(sessionId, selected);
      this.recordTrace({
        type: 'error',
        sessionId,
        payload: { message: candidate.message },
      });
      // `error` rows are permanent history. A turn that retries can report
      // many errors (and may still recover), so persist only the first one per
      // turn; the rest go to the Steps trace, and a turn that does fail shows
      // the best message on its failed card at idle.
      if (this.errorPersistedForTurn.get(sessionId) === activeTurnId) return;
      this.errorPersistedForTurn.set(sessionId, activeTurnId);
      this.send({
        type: 'error',
        sessionId,
        payload: { message: selected.message },
      });
    };

    // Kraki-originated spine notice (not the agent's words). Persisted like a
    // bubble so the turn — which produced no final reply — still has an
    // anchor for its "Steps" history.
    this.adapter.onSystemMessage = (sessionId, event) => {
      if (!this.acceptsAdapterEvent(sessionId, event.turnId)) return;
      this.card.onBubble(sessionId);
      this.send({
        type: 'system_message',
        sessionId,
        payload: { kind: event.kind, content: event.content },
      });
    };

    this.adapter.onSessionEnded = (sessionId, event) => {
      this.sessionManager.endSession(sessionId, event.reason);
      this.turnCounts.delete(sessionId);
      this.turnStepCounts.delete(sessionId);
      this.titleGenerationInFlight.delete(sessionId);
      this.lastAgentContent.delete(sessionId);
      this.pendingTerminalErrors.delete(sessionId);
      this.settledAdapterTurnIds.delete(sessionId);
      this.activeInputTurnIds.delete(sessionId);
      this.nextInputTurnAnchors.delete(sessionId);
      this.purgeSessionToolState(sessionId);
      this.steerAcceptanceInFlight.delete(sessionId);
      this.idleDuringSteerAcceptance.delete(sessionId);
      this.resolveTurnIdle(sessionId);
      this.clearCompacting(sessionId);
      this.card.delete(sessionId);
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
    //
    // Defensive fail-closed path: an adapter must never evict an active turn,
    // but process lifecycle bugs can violate that contract (for example, a long
    // retry backoff with no events being mistaken for idle). Terminalize every
    // accepted unsettled turn before disconnecting; this also resolves a normal
    // prompt waiter when present, but covers waiter-less steer/initial turns too.
    // Keep a sole open question recoverable: Pi deliberately retains that card
    // across process loss so its answer can become a lazy-resume recovery prompt.
    this.adapter.onSessionEvicted = (sessionId) => {
      this.sleepGuard.release(sessionId);
      const turnId = this.activeInputTurnIds.get(sessionId);
      const hasUnsettledAcceptedTurn = !!turnId
        && this.settledAdapterTurnIds.get(sessionId) !== turnId;
      const hasRecoverableQuestion = !!this.soleOpenQuestion(sessionId);
      if (hasUnsettledAcceptedTurn && !hasRecoverableQuestion) {
        this.pendingTerminalErrors.set(sessionId, {
          message: 'Agent process was evicted before the active turn settled.',
          code: 'process_lost',
          source: 'process',
          turnId,
        });
        this.settleAdapterIdle(sessionId, { turnId });
      }
      this.sessionManager.markDisconnected(sessionId);
      if (!hasRecoverableQuestion) this.card.delete(sessionId);
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
    // Normalising is for leftovers of a PREVIOUS daemon process. This runs on
    // every auth_ok, i.e. also after a relay reconnect, when active/idle
    // sessions are genuinely loaded and possibly mid-turn: marking those
    // disconnected made every running session look stopped to the apps after
    // a Head restart (and turned the next message into a fresh prompt instead
    // of a steer). So only the first authentication of this process
    // normalises.
    const normalise = !this.startupSessionsNormalised;
    this.startupSessionsNormalised = true;
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
      if (normalise && (meta.state === 'active' || meta.state === 'idle')) {
        if (meta.state === 'active') this.closeTurnLostInRestart(meta.id);
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
   * A session left `active` by the previous daemon process (restart or update
   * mid-turn) whose spine ends with the user's prompt never got an outcome:
   * the conversation would just stop after the user's message. Record the
   * turn as failed so every app shows why. A session waiting on an agent
   * question is left alone — its answer can still resume it.
   */
  private closeTurnLostInRestart(sessionId: string): void {
    const lastSeq = this.sessionManager.getMeta(sessionId)?.lastSeq ?? 0;
    if (lastSeq <= 0) return;
    const [last] = this.sessionManager.getMessagesAfterSeq(sessionId, lastSeq - 1, 1);
    if (last?.type !== 'user_message') return;
    this.finishTurnWithStatus(sessionId, {
      type: 'failed',
      payload: {
        message: 'Kraki restarted on this computer while this turn was running.',
        code: 'process_lost',
        failedAt: new Date().toISOString(),
      },
    });
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
  /** Send to the adapter; if the runtime lost the session while meta still
   *  says it is loaded (state drift after an agent crash), reattach once and
   *  retry instead of surfacing "Session not found: <id>". */
  private async sendToAdapter(
    sessionId: string,
    text: string,
    attachments?: import('@kraki/protocol').Attachment[],
    options?: import('./adapters/base.js').SendMessageOptions,
  ): Promise<void> {
    const send = () => options
      ? this.adapter.sendMessage(sessionId, text, attachments, options)
      : this.adapter.sendMessage(sessionId, text, attachments);
    try {
      await send();
    } catch (err) {
      if (!/Session not found/i.test((err as Error)?.message ?? '')) throw err;
      logger.warn({ sessionId }, 'Adapter lost a loaded session; reattaching and retrying once');
      this.sessionManager.markDisconnected(sessionId);
      await this.ensureSessionResumed(sessionId);
      await send();
    }
  }

  private async ensureSessionResumed(sessionId: string, restoreModel = true, active = true): Promise<boolean> {
    const existing = this.resumeInFlight.get(sessionId);
    if (existing) return existing;

    const meta = this.sessionManager.getMeta(sessionId);
    // `ended` is also recoverable: older adapters marked a crashed agent
    // process as ended although its transcript is intact.
    if (!meta || (meta.state !== 'disconnected' && meta.state !== 'ended')) return false;

    const promise = (async () => {
      try {
        const result = this.sessionManager.resumeSession(sessionId, active);
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
        if (restoreModel && meta.model) {
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
        // Surface the real cause. Returning false let the caller continue into
        // the adapter, which then reported an opaque "Session not found: <id>".
        throw new SessionResumeError(meta.agent, err);
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
  private broadcastSessionList(): void {
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

  /** Opening or writing to an archived session brings it back (F2). */
  private unarchiveOnUse(sessionId: string): void {
    if (this.sessionManager.setArchived(sessionId, false)) this.broadcastSessionList();
  }

  private handleRequestArchivedSessions(requesterDeviceId: string, requestId?: string): void {
    const sessions = this.sessionManager.getSessionList({ archived: true });
    const response = {
      type: 'archived_session_list',
      deviceId: this.authInfo?.deviceId ?? '',
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload: { sessions, ...(requestId && { requestId }) },
    };
    const requesterKey = this.consumerKeys.get(requesterDeviceId);
    if (requesterKey) this.sendReliableUnicastTo(requesterDeviceId, requesterKey, response);
    else this.send(response as Partial<ProducerMessage>);
  }

  /** Delete a session's files, live state and agent process. */
  private deleteSessionEverywhere(sessionId: string): void {
    // Remove from local session state SYNCHRONOUSLY. The adapter's
    // killSession runs async and may take a while to talk to the
    // Copilot SDK; we don't want broadcastSessionList to see
    // the still-tracked session and broadcast it back to arms.
    this.sessionManager.removeLinkByKrakiId(sessionId);
    this.sessionManager.deleteSession(sessionId);
    this.lastAgentContent.delete(sessionId);
    this.pendingTerminalErrors.delete(sessionId);
    this.settledAdapterTurnIds.delete(sessionId);
    this.activeInputTurnIds.delete(sessionId);
    this.nextInputTurnAnchors.delete(sessionId);
    this.purgeSessionToolState(sessionId);
    this.send({ type: 'session_deleted', sessionId, payload: {} });
    this.eventsWatcher?.unwatch(sessionId);
    // The agent's last writes (transcript, sidecar) can land after the
    // first removal; remove again once the process is gone so no
    // half-session directory is left behind.
    this.adapter.killSession(sessionId)
      .catch((err) => logger.error({ err, sessionId }, 'killSession on delete failed'))
      .finally(() => this.sessionManager.deleteSession(sessionId));
  }

  /** Delete every archived session (Settings → Delete archived sessions). */
  private handleDeleteArchivedSessions(): void {
    const ids = this.sessionManager.getSessionList({ archived: true }).map((s) => s.id);
    for (const id of ids) this.deleteSessionEverywhere(id);
    logger.info({ count: ids.length }, 'Deleted archived sessions');
    this.broadcastSessionList();
  }

  private handleSetAutoArchiveDays(days: unknown): void {
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > 3650) return;
    this.options.autoArchiveDays = days;
    try { this.options.saveAutoArchiveDays?.(days); } catch (err) { logger.warn({ err }, 'Could not save auto-archive setting'); }
    this.runAutoArchive();
    this.broadcastSessionList();
  }

  /** Override each digest's `preview` with the live open question (if any) so a
   *  reloading arm can render the "pending" status - the question no longer
   *  persists to the spine, so the file-based preview can't surface it.
   *
   *  Compaction is intentionally NOT overlaid onto `state`: conversation state
   *  stays active/idle while the transient `compacting` envelope owns the
   *  orthogonal maintenance indicator. */
  private enrichSessionList<
    T extends { id: string; state: import('@kraki/protocol').SessionState; preview?: import('@kraki/protocol').SessionPreviewDigest },
  >(sessions: T[]): T[] {
    return sessions.map((s) => {
      const compactingReason = this.compactingSessions.get(s.id);
      const attention = this.latestOpenAttention(s.id);
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

  /**
   * Reply to `request_turn_trace` — the tool trace for one turn, read from
   * `trace.jsonl` and keyed by the concluding bubble's spine seq. Unicast the
   * `turn_trace_batch` back to the requester.
   */
  private handleTurnTrace(
    requesterDeviceId: string,
    sessionId: string,
    bubbleSeq: number,
  ): void {
    const requesterKey = this.consumerKeys.get(requesterDeviceId);
    if (!requesterKey) {
      logger.warn({ requesterDeviceId }, 'Turn trace requested but no encryption key for requester');
      return;
    }

    const meta = this.sessionManager.getMeta(sessionId);
    let entries: unknown[] = [];
    let complete = false;
    if (meta) {
      const result = this.sessionManager.readTurnTrace(sessionId, Math.floor(bubbleSeq));
      entries = result.entries;
      complete = result.complete;
    }

    const batchMsg = {
      type: 'turn_trace_batch',
      deviceId: this.authInfo?.deviceId ?? '',
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload: { sessionId, bubbleSeq, entries, complete },
    };
    logger.info({ requesterDeviceId, sessionId, bubbleSeq, count: entries.length, complete }, 'Replied to turn trace request');
    this.sendReliableUnicastTo(requesterDeviceId, requesterKey, batchMsg);
  }

  /** Mirror an off-spine step (tool_start / tool_complete / agent_narration) to
   *  the session's `trace.jsonl` without broadcasting it live — the live view
   *  is served by the status card; this is only for the lazy "Steps" history. */
  private recordTrace(msg: { type: string; sessionId: string; payload: unknown }): void {
    this.sleepGuard.touch(msg.sessionId);
    // Per-turn step counter (chip-producing entries only — tool_complete merges
    // into its matching tool_start chip, so don't count it). The concluding
    // agent_message / system_message stamps this running total as payload.steps
    // (see send()), letting a concluded bubble show its "Steps" affordance from
    // replay alone — WITHOUT first pulling the transient trace.
    if (
      msg.type === 'tool_start' || msg.type === 'agent_narration' ||
      msg.type === 'permission' || msg.type === 'error'
    ) {
      this.turnStepCounts.set(msg.sessionId, (this.turnStepCounts.get(msg.sessionId) ?? 0) + 1);
    }
    const enriched = { ...msg, timestamp: new Date().toISOString() };
    this.sessionManager.appendTrace(msg.sessionId, msg.type, JSON.stringify(enriched));
  }

  private handleSetSessionSubscription(requesterDeviceId: string, sessionId: string | null): void {
    const requesterKey = this.consumerKeys.get(requesterDeviceId);
    if (!requesterKey) {
      logger.warn({ requesterDeviceId, sessionId }, 'Session subscription requested without requester key');
      return;
    }

    if (sessionId === null) {
      this.currentSessionByArm.set(requesterDeviceId, null);
      this.sendReliableUnicastTo(requesterDeviceId, requesterKey, {
        type: 'session_subscription_set',
        deviceId: this.authInfo?.deviceId ?? '',
        seq: ++this.seqCounter,
        timestamp: new Date().toISOString(),
        payload: { accepted: true, sessionId: null, snapshot: null },
      });
      return;
    }

    const digest = this.enrichSessionList(this.sessionManager.getSessionList())
      .find((session) => session.id === sessionId) as SessionDigest | undefined;
    if (!digest) {
      this.sendReliableUnicastTo(requesterDeviceId, requesterKey, {
        type: 'session_subscription_set',
        deviceId: this.authInfo?.deviceId ?? '',
        seq: ++this.seqCounter,
        timestamp: new Date().toISOString(),
        payload: {
          accepted: false,
          sessionId,
          error: { code: 'session_not_found', message: 'Session not found' },
        },
      });
      return;
    }

    // Replace membership before capturing/enqueuing the ACK. Any subsequent
    // card event for this session is sent after the snapshot on stream 0.
    this.currentSessionByArm.set(requesterDeviceId, sessionId);
    const card = this.card.state(sessionId);
    const snapshot: SessionLiveSnapshot = {
      digest,
      spineHeadSeq: digest.lastSeq,
      card: { draft: card.draft, action: card.action },
    };
    this.sendReliableUnicastTo(requesterDeviceId, requesterKey, {
      type: 'session_subscription_set',
      deviceId: this.authInfo?.deviceId ?? '',
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload: { accepted: true, sessionId, snapshot },
    });
  }

  /** Reply to `request_card` — unicast the session's current card snapshot
   *  (agent_message_delta full text + current card_action) to the requester. */
  private handleRequestCard(requesterDeviceId: string, sessionId: string): void {
    const requesterKey = this.consumerKeys.get(requesterDeviceId);
    if (!requesterKey) {
      logger.warn({ requesterDeviceId }, 'Card requested but no encryption key for requester');
      return;
    }
    for (const snap of this.card.snapshot(sessionId)) {
      const enriched = {
        ...snap,
        deviceId: this.authInfo?.deviceId ?? '',
        seq: ++this.seqCounter,
        timestamp: new Date().toISOString(),
      };
      this.sendReliableUnicastTo(requesterDeviceId, requesterKey, enriched);
    }
  }

  /** Keep encrypted frames small so control messages can interleave between
   *  attachment chunks. */
  /** Chunk size for attachment_data. Small enough that one chunk (about 2.4x
   *  on the wire after encryption and framing) never holds the relay link for
   *  long in front of chat traffic and liveness pings. */
  private static readonly ATTACHMENT_CHUNK_BYTES = 128 * 1024;

  /** Serializes and rate-limits attachment bytes (see AttachmentPacer). */
  private readonly attachmentPacer = new AttachmentPacer({
    chunkBytes: RelayClient.ATTACHMENT_CHUNK_BYTES,
    isOnline: (deviceId) => this.onlineConsumers.has(deviceId),
    sendChunk: (job, index, total, slice) => {
      const key = this.consumerKeys.get(job.deviceId);
      if (!key) return 0;
      return this.sendAttachmentChunk(job.deviceId, key, job.sessionId, job.id, job.mimeType, index, total, slice, false);
    },
  });

  /**
   * Serve a `request_attachment` from a consumer device. Paced requests get
   * exactly the requested chunk now; legacy whole-file requests are queued and
   * rate-limited so they cannot saturate the relay link.
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
    if (msg.payload.mode === 'paced') {
      // One chunk per request: read just that range, not the whole file.
      const chunk = RelayClient.ATTACHMENT_CHUNK_BYTES;
      const index = Math.floor(msg.payload.index ?? 0);
      const got = index >= 0 ? this.attachmentStore.readRange(sessionId, id, index * chunk, chunk) : null;
      const total = got ? Math.max(1, Math.ceil(got.size / chunk)) : 0;
      if (!got || index >= total) {
        this.unicastAttachmentError(requesterDeviceId, requesterKey, sessionId, id, 'not_found');
        return;
      }
      const wire = this.sendAttachmentChunk(requesterDeviceId, requesterKey, sessionId, id, got.meta.mimeType, index, total, got.bytes, true);
      this.attachmentPacer.charge(wire);
      return;
    }
    const got = this.attachmentStore.read(sessionId, id);
    if (!got) {
      this.unicastAttachmentError(requesterDeviceId, requesterKey, sessionId, id, 'not_found');
      return;
    }
    // Legacy whole-file request: queued and rate-limited by the pacer.
    this.attachmentPacer.enqueue({
      deviceId: requesterDeviceId,
      sessionId,
      id,
      bytes: got.bytes,
      mimeType: got.meta.mimeType,
    });
  }

  /** Send one attachment chunk; returns its estimated wire size. */
  private sendAttachmentChunk(
    deviceId: string,
    key: string,
    sessionId: string,
    id: string,
    mimeType: string,
    index: number,
    total: number,
    slice: Buffer,
    paced: boolean,
  ): number {
    const data = slice.toString('base64');
    const chunkMsg = {
      type: 'attachment_data' as const,
      deviceId: this.authInfo?.deviceId ?? '',
      sessionId,
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload: {
        id,
        index,
        total,
        mimeType,
        data,
        ...(paced && { paced: true as const }),
      },
    };
    this.sendReliableUnicastTo(deviceId, key, chunkMsg);
    // base64 payload → AES blob base64 → Pulse frame base64.
    return Math.ceil(data.length * 1.8);
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
  /** Largest web-client.log before it is rotated to web-client.log.1. */
  private static readonly CLIENT_LOG_MAX_BYTES = 5 * 1024 * 1024;

  private handleClientLog(deviceId: string, entries: Array<{ ts: string; level: string; scope: string; message: string }> | undefined): void {
    if (!Array.isArray(entries) || entries.length === 0) return;
    try {
      const logPath = join(getKrakiHome(), 'logs', 'web-client.log');
      // App-supplied text: one line per entry (no injected newlines/control
      // characters), bounded size per entry and per batch.
      const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);
      const lines = entries.slice(0, 200)
        .map(e => `${clean(e.ts, 40)} [${clean(deviceId, 80)}] [${clean(e.level, 16)}:${clean(e.scope, 64)}] ${clean(e.message, 4000)}`)
        .join('\n') + '\n';
      try {
        if (statSync(logPath).size > RelayClient.CLIENT_LOG_MAX_BYTES) renameSync(logPath, `${logPath}.1`);
      } catch { /* no log yet */ }
      appendFileSync(logPath, lines, 'utf8');
    } catch {
      // Ignore write errors
    }
  }

  // ── Send to relay ───────────────────────────────────

  // TODO: Make send() accept a discriminated union of ProducerMessage types
  // instead of Partial<ProducerMessage> so TypeScript enforces correct payload
  // shape per message type (e.g. user_message must have payload.content).
  private send(msg: Partial<ProducerMessage>, createsUnread = false): void {
    // Durable outcomes must reach the local spine even while the relay is
    // offline. Reconnect replay pulls from that spine; there is no event queue
    // to recover a reply discarded here. Only live-only deltas may be dropped.
    if (msg.type === 'agent_message_delta' && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) return;

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
      if (type === 'user_message' && (enriched.payload as { delivery?: string } | undefined)?.delivery !== 'steer') {
        this.turnStepCounts.set(sessionId, 0);
        this.turnHasOutcome.delete(sessionId);
        this.lastAgentContent.delete(sessionId);
      } else if (type === 'agent_message' || type === 'system_message' || type === 'interrupted_turn' || type === 'turn_status') {
        this.turnHasOutcome.add(sessionId);
        const p = enriched.payload as Record<string, unknown> | undefined;
        if (p && typeof p === 'object') p.steps = this.turnStepCounts.get(sessionId) ?? 0;
      }
    }
    if (sessionId && RelayClient.PERSISTENT_TYPES.has(type)) {
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
    this.dispatchPushPreview(msg);

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
  private sendEncrypted(msg: Partial<ProducerMessage>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.keyManager) return;

    const type = msg.type;
    const sessionId = msg.sessionId;
    const targetIds = type && RelayClient.SUBSCRIBER_ONLY_TYPES.has(type)
      ? [...this.onlineConsumers].filter((deviceId) => this.currentSessionByArm.get(deviceId) === sessionId)
      : [...this.onlineConsumers];

    if (targetIds.length === 0) {
      traceLog.info({ ns: process.hrtime.bigint().toString(), comp: 'tentacle', evt: 'SEND-DECISION', type, sessionId, droppedReason: 'targets-empty' });
      return;
    }

    const recipients: RecipientKey[] = [];
    const usableTargets: string[] = [];
    for (const deviceId of targetIds) {
      const compactKey = this.consumerKeys.get(deviceId);
      if (!compactKey) continue;
      try {
        recipients.push({ deviceId, publicKey: importPublicKey(compactKey) });
        usableTargets.push(deviceId);
      } catch (err) {
        logger.warn({ err, deviceId }, 'Skipping device with invalid public key');
      }
    }
    if (recipients.length === 0) return;

    traceLog.info({ ns: process.hrtime.bigint().toString(), comp: 'tentacle', evt: 'SEND-OK', type, sessionId, recipients: usableTargets, coalesceKey: coalesceKeyFor(msg) });

    try {
      const plaintext = JSON.stringify(msg);
      const { blob, keys } = encryptToBlob(plaintext, recipients);
      this.sendPayload(JSON.stringify({ blob, keys }), usableTargets, false, coalesceKeyFor(msg), streamForType(msg.type));
    } catch (err) {
      logger.error({ err }, 'Encrypted multicast failed');
    }
  }

  /** Put a pulse frame on the wire using the sender-retained delivery target. */
  private sendPulseEnvelope(pulseB64: string, target?: PulseDeliveryTarget): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
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
    const targets = Array.isArray(target) ? target : [target];
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

  private handlePulseDelivered(payloadJson: string, fragmentSender?: string): void {
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
      if (whole !== null) this.handlePulseDelivered(whole, parsed.src);
      return;
    }
    // Head-originated plaintext control (device_joined/left/removed, etc.): route
    // back through the normal presence handling in handleMessage. This is
    // load-bearing — device_joined registers the app's consumer key. Only the
    // head's own control types are accepted from this plaintext wrapper; auth
    // frames and consumer messages arriving this way are forged and dropped.
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
      const { blob, keys } = parsed as { blob: string; keys: Record<string, string> };
      const decrypted = decryptFromBlob(
        { blob, keys },
        this.authInfo.deviceId,
        this.keyManager.getKeyPair().privateKey,
      );
      const inner = JSON.parse(decrypted) as ConsumerMessage;
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
      traceLog.info({
        ns: process.hrtime.bigint().toString(),
        comp: 'tentacle',
        evt: 'APP-DECRYPT',
        type: (inner as { type?: string }).type,
        sessionId: (inner as { sessionId?: string }).sessionId,
        clientId: (inner as { payload?: { clientId?: string } }).payload?.clientId,
        decryptNs: (process.hrtime.bigint() - decryptStart).toString(),
      });
      this.handleConsumerMessage(inner);
    } catch (err) {
      logger.error({ err }, 'Pulse delivered payload decrypt failed');
    }
  }

  /** Build and dispatch an encrypted push preview over the Head self-channel.
   *  This operation is independent of live subscribers and online targets. */
  private dispatchPushPreview(msg: Partial<ProducerMessage>): void {
    const preview = this.buildPushPreview(msg);
    if (!preview) return;
    this.pulse.send(
      JSON.stringify({ type: 'dispatch_push', payload: { preview } }),
      HEAD_PULSE_TARGET,
      false,
      undefined,
      0,
    );
  }

  /** Build the encrypted push preview for a notification-worthy message. */
  private buildPushPreview(
    msg: Partial<ProducerMessage>,
  ): { blob: string; keys: Record<string, string> } | undefined {
    let previewType: string | undefined;
    let previewSummary: string | undefined;
    if (msg.type === 'card_action') {
      // A permission warrants an offline push — a human must act on it.
      // Tool/tool_batch actions are ambient progress (no push). Skip resolved
      // prompts: the push is for the initial ask only.
      const action = (msg.payload as { action?: CardActionState | null } | undefined)?.action;
      if (action?.type === 'permission' && action.payload.decision === undefined) {
        previewType = 'permission';
        previewSummary = action.payload.description || action.payload.toolName;
      }
    } else if (msg.type === 'agent_message'
      && (msg.payload as { question?: unknown } | undefined)?.question) {
      previewType = 'question';
      previewSummary = (msg.payload as { question: { text: string } }).question.text;
    } else if (msg.type === 'idle') {
      // Only the idle that closes a real user turn notifies; create/import/fork
      // idles bypass sendTurnIdle and never push. The summary is THIS turn's
      // reply (never a previous turn's); a failed turn pushes its error; a
      // reply-less turn pushes with no summary (clients show a generic line).
      const closing = this.closingTurnPush.get(msg.sessionId as string);
      if (!closing) return undefined;
      if (closing.failure !== undefined) {
        previewType = 'error';
        previewSummary = closing.failure;
      } else {
        previewType = 'idle';
        previewSummary = this.lastAgentContent.get(msg.sessionId as string) ?? '';
      }
    }
    if (!previewType || previewSummary === undefined) return undefined;
    const normalizedSummary = truncateUtf8(markdownToPlainText(previewSummary), PUSH_SUMMARY_MAX_BYTES);
    if (!normalizedSummary && previewType !== 'idle') return undefined;
    const meta = this.sessionManager.getMeta(msg.sessionId as string);
    const rawTitle = meta?.title ?? meta?.autoTitle;
    const normalizedTitle = rawTitle ? toWellFormedText(rawTitle).replace(/\s+/g, ' ').trim() : undefined;
    const title = normalizedTitle
      ? Array.from(normalizedTitle).slice(0, 80).join('')
      : undefined;

    // Encrypt to ALL consumerKeys (online + offline). The push preview is
    // specifically for offline delivery — online devices already got the real
    // message via the live pulse stream.
    const previewRecipients: RecipientKey[] = [];
    for (const [deviceId, compactKey] of this.consumerKeys) {
      try {
        previewRecipients.push({ deviceId, publicKey: importPublicKey(compactKey) });
      } catch {
        // skip invalid keys
      }
    }
    if (previewRecipients.length === 0) return undefined;
    traceLog.info({ ns: process.hrtime.bigint().toString(), comp: 'tentacle', evt: 'PUSH-PREVIEW-BUILD', previewType, recipientCount: previewRecipients.length, onlineCount: this.onlineConsumers.size, offlineCount: previewRecipients.length - this.onlineConsumers.size });
    try {
      const preview = JSON.stringify({
        type: previewType,
        ...(normalizedSummary && { summary: normalizedSummary }),
        ...(previewType === 'idle' && !normalizedSummary && { steps: this.turnStepCounts.get(msg.sessionId as string) ?? 0 }),
        sessionId: msg.sessionId,
        ...(title ? { title } : {}),
      });
      const previewBlob = encryptToBlob(preview, previewRecipients);
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
      this.sendPayload(JSON.stringify({ blob, keys }), targetDeviceId, durable, undefined, streamForType((msg as { type?: string }).type));
    } catch (err) {
      logger.error({ err, targetDeviceId }, 'Reliable unicast failed');
    }
  }

  // ── Subscription account usage ───────────────────────

  private accountUsage: AccountUsage[] | null = null;
  /** Advertised as the `account_usage` feature so apps can tell "no accounts" from "too old". */
  private accountUsageEnabled = false;
  setAccountUsageEnabled(enabled: boolean): void {
    if (this.accountUsageEnabled === enabled) return;
    this.accountUsageEnabled = enabled;
    if (this.state === 'connected') this.sendGreetingBroadcast();
  }
  private accountUsageRefresher: (() => Promise<AccountUsage[]>) | null = null;
  private usageRefreshInFlight: Promise<AccountUsage[]> | null = null;
  private usageRefreshRequests = new Map<string, string>();

  setAccountUsageRefresher(refresh: (() => Promise<AccountUsage[]>) | null): void {
    this.accountUsageRefresher = refresh;
    if (this.state === 'connected') this.sendGreetingBroadcast();
  }

  /** Reads the local quota history file for `request_usage_history`. */
  usageHistoryReader: ((since: number) => UsageHistorySample[]) | null = null;
  private static readonly USAGE_HISTORY_MAX_SAMPLES = 20_000;

  /** Latest read-only quota of this machine's subscription accounts; broadcast to online apps. */
  updateAccountUsage(accounts: AccountUsage[]): void {
    this.accountUsage = accounts;
    if (this.state === 'connected') this.broadcastAccountUsage();
  }

  private accountUsageMessage() {
    return {
      type: 'device_usage' as const,
      deviceId: this.authInfo?.deviceId ?? '',
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload: { accounts: this.accountUsage ?? [], updatedAt: new Date().toISOString() },
    };
  }

  private broadcastAccountUsage(): void {
    if (!this.accountUsage) return;
    this.sendEncrypted(this.accountUsageMessage() as Partial<ProducerMessage>);
  }

  private sendAccountUsageTo(targetDeviceId: string, compactPubKey: string): void {
    if (!this.accountUsage) return;
    this.sendReliableUnicastTo(targetDeviceId, compactPubKey, this.accountUsageMessage());
  }

  private async handleRefreshAccountUsage(requesterDeviceId: string, requestId: unknown): Promise<void> {
    const key = this.consumerKeys.get(requesterDeviceId);
    if (!key || typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(requestId)) return;
    const reply = (error?: 'unavailable' | 'disabled' | 'busy') => {
      if (this.state !== 'connected' || !this.onlineConsumers.has(requesterDeviceId)
        || this.consumerKeys.get(requesterDeviceId) !== key) return;
      const message = this.accountUsageMessage();
      this.sendReliableUnicastTo(requesterDeviceId, key, {
        ...message, payload: { ...message.payload, requestId, ...(error && { refreshError: error }) },
      });
    };
    if (!this.accountUsageEnabled || !this.accountUsageRefresher) { reply('disabled'); return; }
    // Bound pending replies to one per authenticated device, and share the
    // actual read across devices. The monitor also enforces provider cooldowns.
    if (this.usageRefreshRequests.has(requesterDeviceId)) { reply('busy'); return; }
    this.usageRefreshRequests.set(requesterDeviceId, requestId);
    try {
      this.usageRefreshInFlight ??= Promise.resolve().then(() => this.accountUsageRefresher!())
        .finally(() => { this.usageRefreshInFlight = null; });
      this.accountUsage = await this.usageRefreshInFlight;
      reply(); // Even an unchanged/throttled read must complete the UI request.
    } catch {
      reply('unavailable'); // Never forward provider exception bodies or credentials.
    } finally {
      this.usageRefreshRequests.delete(requesterDeviceId);
    }
  }

  private handleRequestUsageHistory(requesterDeviceId: string, since?: number): void {
    const key = this.consumerKeys.get(requesterDeviceId);
    if (!key) return;
    const floor = typeof since === 'number' && Number.isFinite(since) ? since : Date.now() / 1000 - 60 * 86400;
    let samples = this.usageHistoryReader?.(floor) ?? [];
    const truncated = samples.length > RelayClient.USAGE_HISTORY_MAX_SAMPLES;
    if (truncated) samples = samples.slice(-RelayClient.USAGE_HISTORY_MAX_SAMPLES);
    this.sendReliableUnicastTo(requesterDeviceId, key, {
      type: 'usage_history',
      deviceId: this.authInfo?.deviceId ?? '',
      seq: ++this.seqCounter,
      timestamp: new Date().toISOString(),
      payload: { samples, ...(truncated && { truncated: true }) },
    });
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
  runningSessionCount(): number {
    return this.sessionManager.getSessionList({ all: true }).filter((s) => s.state === 'active').length;
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
        ...(this.accountUsageEnabled && this.accountUsageRefresher ? ['account_usage_refresh'] : [])],
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

  private updateConsumerKeys(devices: DeviceSummary[]): void {
    this.consumerKeys.clear();
    this.onlineConsumers.clear();
    this.appFeatures.clear();
    this.currentSessionByArm.clear();
    this.legacyReplayWarned.clear();
    for (const d of devices) {
      if (d.role === 'app') {
        const key = d.encryptionKey ?? d.publicKey;
        if (key) {
          this.consumerKeys.set(d.id, key);
          if (d.online) {
            this.onlineConsumers.add(d.id);
            this.currentSessionByArm.set(d.id, null);
          }
        }
      }
    }
  }

  // ── Title generation scheduling ──────────────────────

  private maybeGenerateTitle(sessionId: string): void {
    const meta = this.sessionManager.getMeta(sessionId);
    // The turn counter is in memory. After a daemon restart a session that
    // already has a title must not count from 1 again (that retitled it on
    // every restart): resume past the early refinements.
    const known = this.turnCounts.get(sessionId) ?? (meta?.autoTitle ? 5 : 0);
    const turns = known + 1;
    this.turnCounts.set(sessionId, turns);

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

    this.adapter.generateTitle(sessionId, {
      firstUserMessage: recentMessages[recentMessages.length - 1] ?? lastUserMessage,
      lastUserMessage,
      recentMessages,
      currentTitle,
      // Same agent + same model as the session: the only guaranteed-available pair.
      agent: meta.agent,
      model: meta.model,
      reasoningEffort: meta.reasoningEffort,
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
      this.maybeAutoArchive(now);
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

  /** Unicast the persisted user_message for `clientId` back to `deviceId`. */
  private reechoInput(deviceId: string, sessionId: string, clientId: string): void {
    const key = this.consumerKeys.get(deviceId);
    const seq = this.sessionManager.findUserMessageSeqByClientId(sessionId, clientId);
    // Each early return leaves the sender's input unconfirmed; say why.
    if (!key || seq === null) {
      logger.warn({ sessionId, deviceId, clientId, reason: !key ? 'no_consumer_key' : 'no_user_message' }, 'Cannot re-echo duplicate input');
      return;
    }
    const [row] = this.sessionManager.getMessagesAfterSeq(sessionId, seq - 1, 1);
    if (!row || row.seq !== seq) {
      logger.warn({ sessionId, deviceId, clientId, seq, rowSeq: row?.seq ?? null }, 'Cannot re-echo duplicate input: row mismatch');
      return;
    }
    try {
      const message = JSON.parse(row.payload) as Record<string, unknown>;
      message.seq = row.seq;
      if (!message.timestamp) message.timestamp = row.ts;
      if (!message.sessionId) message.sessionId = sessionId;
      this.sendReliableUnicastTo(deviceId, key, message);
      logger.info({ sessionId, deviceId, seq }, 'Re-echoed duplicate input');
    } catch (err) {
      logger.warn({ err, sessionId, seq }, 'Could not re-echo duplicate input');
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
