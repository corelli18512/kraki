// History and subscription messages: pages, ranges, turn traces, live snapshots, session lists; and the ProducerMessage union.

import { type BaseEnvelope } from './message-base.js';
import { type SessionCreatedMessage, type SessionEndedMessage, type UserMessage, type AgentMessage, type AgentMessageDelta, type PermissionRequest, type ToolStartMessage, type ToolCompleteMessage, type AgentNarrationMessage, type CardActionState, type CardAction, type CompactingMessage, type IdleMessage, type ActiveMessage, type ErrorMessage, type SystemMessage, type InterruptedTurnMessage, type TurnStatusMessage, type SessionModeSetMessage, type SessionModelSetMessage, type SessionDeletedMessage, type SessionTitleUpdatedMessage, type DeviceGreetingMessage } from './producer-messages.js';
import { type LocalNotificationMessage, type DeviceUsageMessage, type DeviceUpdateStatusMessage, type UsageHistoryMessage, type SessionReplayBatchMessage } from './usage-messages.js';

// ── Turn-aware message pagination ───────────────────

/** Sent by app to tentacle to request turn-aligned messages for a session. */
export interface RequestSessionMessagesMessage extends BaseEnvelope {
  type: 'request_session_messages';
  payload: {
    /** Session to load messages for. */
    sessionId: string;
    /** Load messages strictly before this seq. Omit to load from head. */
    beforeSeq?: number;
    /**
     * Head requests only: the requester already stores every message through
     * this seq, so a head batch may start right after it instead of at the
     * latest turn (a reconnect usually misses one or two messages, not a
     * turn of ~100). Older Tentacles ignore it and send the whole turn.
     */
    afterSeq?: number;
  };
}

/** Sent by tentacle to a device with turn-aligned messages for a session. */
export interface SessionMessagesBatchMessage extends BaseEnvelope {
  type: 'session_messages_batch';
  payload: {
    /** The session these messages belong to. */
    sessionId: string;
    /** Messages in ascending seq order. Always composed of complete turns. */
    messages: ProducerMessage[];
    /** Lowest seq in messages. If 1, no older messages exist. */
    firstSeq: number;
    /** Highest seq in messages. */
    lastSeq: number;
    /** True if this batch covers the session head. */
    containsHead: boolean;
  };
}

// ── Range-based message fetch ───────────────────────

/**
 * Sent by app to tentacle to fetch an EXACT seq range from a session.
 *
 * Distinct from `request_session_messages` which is turn-aligned and
 * always anchored at the upper end. This endpoint exists for clients
 * that know precisely which seqs they want — e.g. gap recovery when a
 * push delivers a seq jump, or web's IndexedDB cache filling holes.
 *
 * Pagination is caller-driven: chunk `[fromSeq..toSeq]` yourself before
 * sending. The server applies a defensive backstop on very large ranges
 * — if it triggers, the reply keeps the newer end and sets
 * `truncated: true` so the caller can iterate to fill the older remainder.
 */
export interface RequestSessionMessagesRangeMessage extends BaseEnvelope {
  type: 'request_session_messages_range';
  payload: {
    /** Session to fetch from. */
    sessionId: string;
    /** Inclusive lower bound. Server clamps to ≥ 1. */
    fromSeq: number;
    /** Inclusive upper bound. Server clamps to ≤ session head seq. */
    toSeq: number;
  };
}

/**
 * Sent by tentacle in response to `request_session_messages_range`.
 *
 * Per-session seqs are strictly monotonic and only assigned to
 * persistent message types. `messages` is normally contiguous within
 * `[firstSeq..lastSeq]`; older session logs may defensively contain
 * non-persistent stragglers which the server filters out, in which
 * case the returned set is a subset of `[firstSeq..lastSeq]`.
 *
 * Empty `messages` occurs when the session is unknown, the requested
 * range falls entirely outside `[1..headSeq]`, or `fromSeq > toSeq`
 * after server-side clamping. In that case `firstSeq` and `lastSeq`
 * are both `0` and `truncated` is `false`.
 */
export interface SessionMessagesRangeBatchMessage extends BaseEnvelope {
  type: 'session_messages_range_batch';
  payload: {
    /** The session these messages belong to. */
    sessionId: string;
    /** Messages in ascending seq order. */
    messages: ProducerMessage[];
    /** `messages[0].seq`, or `0` if `messages` is empty. */
    firstSeq: number;
    /** `messages.at(-1).seq`, or `0` if `messages` is empty. */
    lastSeq: number;
    /** True iff the server's defensive cap reduced the range from the
     *  older end. Caller may iterate by requesting another page
     *  ending at `firstSeq - 1`. */
    truncated: boolean;
  };
}

// ── Turn trace (TRACE axis) ─────────────────────────

/** One recorded step in a turn's trace. These are exactly the live tool
 *  broadcast messages, stored verbatim in `trace.jsonl`, so the client
 *  merges them by `toolCallId` with the SAME code path it uses live. */
export type TraceEntry =
  | ToolStartMessage
  | ToolCompleteMessage
  | AgentNarrationMessage
  | PermissionRequest;

/**
 * app → tentacle: pull the tool trace for one turn from `trace.jsonl`.
 *
 * A turn is identified by its concluding bubble's spine seq — no separate
 * turn id exists. The client sends the `agent_message` seq it wants to
 * expand; the tentacle resolves the enclosing turn (the steps recorded
 * between the previous spine message and this one) and returns them.
 *
 * Typical callers: (a) user expands a historical bubble's steps; (b) on
 * `idle` the client pulls the just-finished turn's authoritative step list.
 *
 * Note the key is the *concluding* bubble's seq, so this only addresses
 * turns that have ended. A still-running turn has no bubble seq yet — its
 * steps are shown live from the ongoing tool broadcasts, and a client that
 * joined mid-turn (and thus missed earlier steps) reconciles to the full
 * list via the (b) pull once the turn goes idle.
 */
export interface RequestTurnTraceMessage extends BaseEnvelope {
  type: 'request_turn_trace';
  payload: {
    sessionId: string;
    /** Spine seq of the bubble (agent_message) whose steps to expand. */
    bubbleSeq: number;
  };
}

/**
 * app → tentacle (unicast): asks for the current status-card snapshot of a
 * session. Sent on session-open / reconnect when the session is not idle, so a
 * client that missed the live agent_message_delta/card_action broadcasts can seed
 * its card. The tentacle replies by unicasting the current `agent_message_delta`
 * (reset:true, full text) + `card_action` (current action or null).
 */
export interface RequestCardMessage extends BaseEnvelope {
  type: 'request_card';
  payload: {
    sessionId: string;
  };
}

/** tentacle → requester (unicast): the turn's trace read from `trace.jsonl`. */
export interface TurnTraceBatchMessage extends BaseEnvelope {
  type: 'turn_trace_batch';
  payload: {
    sessionId: string;
    /** Echoes the requested bubble seq. */
    bubbleSeq: number;
    /** In recorded order. Leaf args/result stay lazy via ContentRef. */
    entries: TraceEntry[];
    /** False when the turn is still running — the client keeps appending
     *  from live tool broadcasts after applying this batch. True once ended. */
    complete: boolean;
  };
}

/** App → Tentacle, per connection: behaviours this app supports (sent after
 *  a greeting that advertises them). `fragments`: can reassemble fragments. */
export interface ClientFeaturesMessage extends BaseEnvelope {
  type: 'client_features';
  payload: {
    features: string[];
  };
}

/** Atomic subscribe/replace/unsubscribe request for one Arm's visible session. */
export interface SetSessionSubscriptionMessage extends BaseEnvelope {
  type: 'set_session_subscription';
  payload: {
    sessionId: string | null;
    /** Echoed in the ACK so the App can tell this request's answer from a
     *  stale one (e.g. an ACK still in flight on a replaced route). */
    requestId?: string;
  };
}

/** Bounded live-state snapshot returned with a successful subscription ACK. */
export interface SessionLiveSnapshot {
  digest: import('./sessions.js').SessionDigest;
  spineHeadSeq: number;
  card: {
    draft: string;
    action: CardActionState | null;
  };
}

/** Tentacle acknowledgement and live-ready barrier for session subscription.
 *  Every variant also carries the request's `requestId` when one was sent. */
export interface SessionSubscriptionSetMessage extends BaseEnvelope {
  type: 'session_subscription_set';
  payload: { requestId?: string } & (
    | {
        accepted: true;
        sessionId: string;
        snapshot: SessionLiveSnapshot;
      }
    | {
        accepted: true;
        sessionId: null;
        snapshot: null;
      }
    | {
        accepted: false;
        sessionId: string;
        error: {
          code: 'session_not_found';
          message: string;
        };
      });
}

/** Sent by tentacle to app with metadata for all active sessions.
 *  Archived sessions are left out; `archivedCount` says how many there are
 *  (fetch them with `request_archived_sessions`). */
export interface SessionListMessage extends BaseEnvelope {
  type: 'session_list';
  payload: {
    sessions: import('./sessions.js').SessionDigest[];
    /** Number of archived sessions on this computer. Absent from old tentacles. */
    archivedCount?: number;
    /** Days without messages before an unpinned session is archived; 0 = never. */
    autoArchiveDays?: number;
  };
}

/** Response to `request_archived_sessions`. Unicast to the requester. */
export interface ArchivedSessionListMessage extends BaseEnvelope {
  type: 'archived_session_list';
  payload: {
    sessions: import('./sessions.js').SessionDigest[];
    requestId?: string;
  };
}

/** Broadcast by tentacle when a permission is resolved (so all apps can clear the card). */
export interface PermissionResolvedMessage extends BaseEnvelope {
  type: 'permission_resolved';
  payload: {
    permissionId: string;
  } & (
    | { resolution: 'approved' }
    | { resolution: 'denied'; reason?: string }
    /** Only from tentacles before 0.38.7. */
    | { resolution: 'always_allowed' }
    | { resolution: 'cancelled'; reason?: string }
  );
}

/** Broadcast by tentacle when a session's pin state changes. */
export interface SessionPinnedMessage extends BaseEnvelope {
  type: 'session_pinned';
  payload: {
    pinned: boolean;
  };
}

/** Broadcast by tentacle when a session's read position is updated. */
export interface SessionReadMessage extends BaseEnvelope {
  type: 'session_read';
  payload: {
    /** The highest seq marked as read */
    seq: number;
  };
}

/** Response to request_local_sessions. Unicast to requester only. */
export interface LocalSessionsListMessage extends BaseEnvelope {
  type: 'local_sessions_list';
  payload: {
    /** All sessions matching filter, sorted by modifiedTime desc. */
    sessions: import('./sessions.js').LocalSession[];
    /** Echoed from request for correlation. */
    requestId?: string;
  };
}

/** Chunk of attachment bytes returned as a unicast response to
 *  `request_attachment`. The relay never sees the bytes; payload is inside the
 *  encrypted blob like any other message. */
export interface AttachmentDataMessage extends BaseEnvelope {
  type: 'attachment_data';
  payload: {
    /** Attachment id from the matching `ContentRef`. */
    id: string;
    /** 0-based chunk index. */
    index: number;
    /** Total chunk count for this attachment. */
    total: number;
    /** MIME type echoed for convenience. */
    mimeType: string;
    /** base64 of this chunk's bytes. Empty when `error` is set. */
    data: string;
    /** Set by tentacles that support one-chunk-at-a-time attachment pulls. */
    paced?: true;
    /** When set, this chunk carries an error instead of bytes (index/total
     *  should be 0/0). */
    error?: 'not_found' | 'unauthorized' | 'too_large';
  };
}

export type ProducerMessage =
  | SessionCreatedMessage
  | SessionEndedMessage
  | SessionDeletedMessage
  | UserMessage
  | AgentMessage
  | AgentMessageDelta
  | PermissionRequest
  | ToolStartMessage
  | ToolCompleteMessage
  | AgentNarrationMessage
  | CardAction
  | CompactingMessage
  | TurnTraceBatchMessage
  | IdleMessage
  | ActiveMessage
  | ErrorMessage
  | SystemMessage
  | InterruptedTurnMessage
  | TurnStatusMessage
  | SessionModeSetMessage
  | SessionTitleUpdatedMessage
  | SessionModelSetMessage
  | SessionPinnedMessage
  | SessionReadMessage
  | DeviceGreetingMessage
  | SessionReplayBatchMessage
  | SessionMessagesBatchMessage
  | SessionMessagesRangeBatchMessage
  | SessionSubscriptionSetMessage
  | SessionListMessage
  | PermissionResolvedMessage
  | LocalSessionsListMessage
  | ArchivedSessionListMessage
  | AttachmentDataMessage
  | DeviceUsageMessage
  | LocalNotificationMessage
  | UsageHistoryMessage
  | DeviceUpdateStatusMessage;
