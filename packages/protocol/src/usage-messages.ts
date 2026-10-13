// Account usage, local notifications, device updates and session replay messages.

import { type ProducerMessage } from './history-messages.js';
import { type BaseEnvelope } from './message-base.js';

// ── Subscription account usage (read-only, per tentacle) ─────

/** Which quota window this is. Providers change their windows; `other` keeps
 *  unknown ones visible instead of dropping them. */
export type AccountUsageWindowKind = 'five_hour' | 'weekly' | 'other';

export interface AccountUsageWindow {
  /** Provider window id, stable per account (e.g. `five_hour`, `seven_day`, `primary_window`). */
  id: string;
  kind: AccountUsageWindowKind;
  /** Human label for `other` windows (e.g. a model-scoped weekly limit). */
  title?: string;
  /** 0–100, already clamped. Never invented: a missing window is omitted. */
  remainingPercent: number;
  /** ISO timestamp of the scheduled reset, when the provider reports one. */
  resetsAt?: string;
  durationSeconds?: number;
}

export interface AccountUsage {
  /** Opaque, hashed provider account identity. Same account on two machines → same key. */
  accountKey: string;
  provider: 'claude' | 'codex';
  /** Masked account label (e.g. `co•••ai@gmail.com`). */
  label?: string;
  /** Raw provider plan id (e.g. `default_claude_max_20x`, `prolite`). */
  plan?: string;
  windows: AccountUsageWindow[];
  /** Last successful read (UTC ISO); empty before the first success. */
  fetchedAt: string;
  /** Present when the last attempt failed; windows then hold the last good reading (possibly none). */
  error?: string;
  /** Agents on this machine signed in with this account (`pi`, `claude`, `codex`), so an app can tell
   *  which account a Session is spending. One account may be shared by several machines and agents. */
  agents?: string[];
  /** Two worst-case polling intervals plus a grace period, in seconds. */
  staleAfterSeconds?: number;
  /** Earliest provider-permitted retry after a rate limit, not a quota reset. */
  retryAt?: string;
}

/** The subscription accounts this tentacle can read and their remaining quota.
 *  Sent to each app on join and broadcast whenever a reading changes. */
/**
 * tentacle → app (unicast, local link only): the push preview for an App on
 * the same machine, sent alongside the Head's `notification_preview` copy.
 * `preview` is the plaintext preview JSON (this message is itself E2E
 * encrypted). Both copies carry the same `nid`; the App posts it once.
 */
export interface LocalNotificationMessage extends BaseEnvelope {
  type: 'local_notification';
  payload: { preview: string };
}

export interface DeviceUsageMessage extends BaseEnvelope {
  type: 'device_usage';
  payload: {
    accounts: AccountUsage[];
    updatedAt: string;
    /** Present only on a targeted reply to refresh_account_usage. */
    requestId?: string;
    refreshError?: 'unavailable' | 'disabled' | 'busy';
  };
}

/** One recorded quota reading (local history, used for heatmaps later). */
export interface UsageHistorySample {
  /** Measurement time, epoch seconds. */
  t: number;
  /** accountKey */
  k: string;
  /** window id */
  w: string;
  /** window length in seconds */
  d?: number;
  /** used percent */
  u: number;
  /** scheduled reset, epoch seconds */
  r?: number;
}

/** Request an immediate, coalesced read. Provider cooldowns still apply.
 * Only send to devices advertising account_usage_refresh. Never durable. */
export interface RefreshAccountUsageMessage extends BaseEnvelope {
  type: 'refresh_account_usage';
  payload: { requestId: string };
}

/** App → tentacle: update Kraki on this computer to the newest release.
 *  Only send to computers whose greeting has `update.remote`. Without
 *  `when`, a computer with running sessions answers `busy` and does nothing;
 *  `now` stops them, `idle` waits until none is running. */
export interface UpdateDeviceMessage extends BaseEnvelope {
  type: 'update_device';
  payload: { requestId: string; when?: 'now' | 'idle' };
}

export type DeviceUpdatePhase =
  | 'busy'            // sessions are running; ask the user (runningSessions)
  | 'waiting_idle'    // will start once no session is running
  | 'downloading'     // progress 0…1 when known
  | 'installing'      // the computer goes offline for a few seconds next
  | 'updated'         // sent by the new version once it is online
  | 'failed'          // nothing changed (error says why)
  | 'rolled_back';    // the new version didn't come up; the old one is back

/** Tentacle → apps: progress and outcome of an update (broadcast). */
export interface DeviceUpdateStatusMessage extends BaseEnvelope {
  type: 'device_update_status';
  payload: {
    requestId?: string;
    phase: DeviceUpdatePhase;
    from?: string;
    to?: string;
    progress?: number;
    runningSessions?: number;
    error?: string;
  };
}

/** Tentacle → app reply to `request_usage_history`. */
export interface UsageHistoryMessage extends BaseEnvelope {
  type: 'usage_history';
  payload: {
    samples: UsageHistorySample[];
    /** True when older samples exist beyond the returned range. */
    truncated?: boolean;
  };
}

/**
 * Sent by tentacle to a device after replaying all buffered messages for a session.
 * @deprecated Use `request_session_messages` / `session_messages_batch` instead.
 * Removal plan: docs/protocol-compatibility.md.
 */
export interface SessionReplayBatchMessage extends BaseEnvelope {
  type: 'session_replay_batch';
  payload: {
    /** The session that was replayed. */
    sessionId: string;
    /** The replayed messages, in seq order. */
    messages: ProducerMessage[];
    /** The highest seq included in this batch. */
    lastSeq: number;
    /** The total highest seq in the session (for detecting if more messages are available). */
    totalLastSeq: number;
  };
}
