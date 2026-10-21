/** Shared by HeadServer and its handler modules: per-socket state, options, limits. */

import type { VoiceResource } from '@kraki/protocol';
import { LeaseIssuer } from '../lease-issuer.js';
import type { AuthProvider } from '../auth.js';
import type { PushManager } from '../push/index.js';
import type { AuthBackend } from '../auth-backend.js';

/** Custom Words has its own channel (`auth_ok.voiceVocabulary` and
 *  `voice_vocabulary_updated`). Never ship it inside generic preferences: that
 *  would duplicate it on every auth and broadcast it on every theme change. */
export function publicPreferences(prefs: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!prefs || !('voiceVocabulary' in prefs)) return prefs;
  const { voiceVocabulary: _omitted, ...rest } = prefs;
  return rest;
}

export interface ClientState {
  deviceId?: string;
  userId?: string;
  authenticated: boolean;
  ip?: string;
  isAlive: boolean;
  /** When the socket opened (ms epoch). */
  connectedAt?: number;
  /** The last `auth` attempt's method and device, for failure logs. */
  authMethod?: string;
  authDeviceId?: string;
  authenticatedAt?: number;
  /** At most one daily activity write per authenticated app socket/day. */
  foregroundDay?: string;
  pendingNonce?: string;
  /** An `auth` / `auth_response` is awaiting its backend. */
  authInFlight?: boolean;
  pendingDeviceId?: string;
  pendingDeviceInfo?: { encryptionKey?: string };
  pendingAuthMethod?: string;
  /** Auth step timings (ms epoch / durations) for the authenticated log line. */
  authTiming?: { startedAt: number; challengeMs?: number; challengeSentAt?: number; signMs?: number; verifyMs?: number; tokenMs?: number };
  /** Replaced by a newer socket of the same device: closing, inert. */
  evicted?: boolean;
  /** Closes the socket if it never authenticates (G1). */
  authTimer?: ReturnType<typeof setTimeout>;
  /** The auth deadline was already extended once for a backend call. */
  authDeadlineExtended?: boolean;

  // ── Liveness uncertainty (device_pending broadcast) ──
  /** Timestamp when pong grace period expires (null = no pending ping). */
  pongOverdueAt: number | null;
  /** Whether we already broadcast device_pending for this ping cycle. */
  pendingLivenessBroadcast: boolean;
  /** Diagnostic: last time we sent a ping to this client (ms epoch). */
  lastPingSentAt?: number;
  /** Diagnostic: last time we received a pong from this client (ms epoch). */
  lastPongRecvAt?: number;
  /** Last time any frame arrived from this client (ms epoch). */
  lastInboundAt?: number;
  /** ws.bufferedAmount when the last ping was queued. */
  bufferedAtPing?: number;
  /** Declared at auth: this client's Pulse accepts progress heartbeats. */
  pulseProgressAck?: boolean;
  /** An app reported it left the screen but kept its socket for a short
   *  grace period (`app_visibility`). Still online for delivery, but
   *  notifications go out as if it were offline. */
  hidden?: boolean;
}

/** Capabilities advertised in `auth_ok.features`. */
export const HEAD_FEATURES = ['app_visibility'] as const;

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
  /** Lease (device voice credential) lifetime in seconds. Default 86400 (24h). */
  voiceLeaseTtlSec?: number;
  /** The only voice limit: max seconds of audio per user per UTC day. Default 7200 (2h). */
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
  /**
   * Close sockets that have not authenticated within this time (ms).
   * Default 15s. A socket that asked for `auth_info` (an app on its login
   * screen, waiting for the user to finish signing in) gets
   * `loginScreenAuthTimeoutMs` instead (default 10 min).
   */
  authTimeoutMs?: number;
  loginScreenAuthTimeoutMs?: number;
}

export const DEFAULT_VOICE_LEASE_TTL_SEC = 86_400;
export const DEFAULT_VOICE_DAILY_QUOTA_SEC = 7_200;
export const MIN_VOICE_LEASE_GRANT_SEC = 1;
export const VALID_VOICE_RESOURCES = new Set<VoiceResource>(['voice/doubao']);

export const DEFAULT_MAX_PAYLOAD = 10 * 1024 * 1024;
export const DEFAULT_AUTH_TIMEOUT_MS = 15_000;
export const DEFAULT_LOGIN_SCREEN_AUTH_TIMEOUT_MS = 10 * 60_000;
export const MAX_MULTICAST_TARGETS = 64;
/** Send-buffer ceiling per socket before a stalled client is disconnected. */
export const MAX_WS_BUFFERED_BYTES = 32 * 1024 * 1024;

/** How often the liveness sweep runs (ms). Faster than the 30s ping timer so
 *  device_pending detection latency tracks the recipient's ping cadence
 *  (~10s), not the slower liveness check cadence. */
export const LIVENESS_SWEEP_INTERVAL_MS = 2_500;
/** Grace period after ping before broadcasting device_pending (ms).
 *  Overridable via PONG_GRACE_MS environment variable. */
export const PONG_GRACE_MS = Math.max(1_000, parseInt(process.env.PONG_GRACE_MS ?? '8000', 10) || 8_000);

export function isValidMessage(msg: unknown): msg is { type: string; [key: string]: unknown } {
  if (typeof msg !== 'object' || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  return typeof obj.type === 'string' && obj.type.length > 0;
}

export function isValidAuth(msg: Record<string, unknown>): boolean {
  if (!msg.device || typeof msg.device !== 'object') return false;
  const dev = msg.device as Record<string, unknown>;
  if (typeof dev.name !== 'string' || typeof dev.role !== 'string') return false;
  if (dev.role !== 'tentacle' && dev.role !== 'app') return false;
  if (!msg.auth || typeof msg.auth !== 'object') return false;
  const auth = msg.auth as Record<string, unknown>;
  if (typeof auth.method !== 'string') return false;
  return true;
}
