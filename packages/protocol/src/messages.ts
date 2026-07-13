// ------------------------------------------------------------
// Kraki Protocol — Message types and envelopes
// ------------------------------------------------------------
//
// The relay is a thin encrypted forwarder. It never reads message
// content — only the envelope fields visible to it.
//
// Two envelope directions:
//   Unicast   — app → specific tentacle (has `to` field)
//   Broadcast — tentacle → all devices (has optional `notify`)
//
// Inner messages (ProducerMessage / ConsumerMessage) are encrypted
// inside the blob and only visible to endpoints after decryption.
//
// Reliable per-hop delivery (seq / ack / resume / durable) is handled by
// the pulse layer, framed in the `pulse` envelope field — see
// PulseFrameField below. It does not interact with the per-session
// application seq inside the encrypted blob.
// ------------------------------------------------------------

// ============================================================
// Relay envelopes (visible to relay)
// ============================================================

/** Per-hop pulse framing (visible to the relay, like a WS frame header).
 *
 *  When present, this envelope is carried by the pulse reliable-delivery layer
 *  (pulse = a reliable WebSocket replacement). `pulse` holds the base64 of the
 *  COMPLETE pulse wire frame, whose payload segment is the E2E ciphertext. The
 *  relay — itself a pulse endpoint on each hop — decodes the frame to read
 *  seq / ack / durable / hello / resend and to route, ack, and durably store;
 *  it treats the frame's payload segment as opaque bytes it never decrypts.
 *
 *  The ciphertext lives INSIDE the pulse frame (not in `blob`) so that pulse's
 *  own outbox, resume, and durable persistence carry it. `keys` (per-recipient
 *  wrapped AES keys) stays an envelope field because the relay reads it for
 *  fan-out and the recipient needs it to decrypt. For a pulse-carried envelope,
 *  `blob` is unused (empty string); the payload is in `pulse`.
 *
 *  Absent ⇒ legacy fire-and-forget path (`blob`/`keys` as before). Peers that
 *  don't speak pulse simply never set it. */
export interface PulseFrameField {
  /** base64 of the complete pulse wire frame (header + payload; the payload
   *  segment is the E2E ciphertext, opaque to the relay). */
  pulse?: string;
}

/** Reserved pulse routing target meaning "deliver to the head (relay) itself"
 *  rather than forward to a device. A pulse frame addressed here carries
 *  PLAINTEXT control JSON (update_preferences / remove_device /
 *  (un)register_push_token) — the head is the legitimate recipient, so there is
 *  no E2E on this hop and the payload is NOT an E2E {blob,keys}. The `@` prefix
 *  cannot collide with a real deviceId (which are `dev_`/`app_`-prefixed or a
 *  uuid, never `@`-prefixed). */
export const HEAD_PULSE_TARGET = '@head';

/** App → specific tentacle. Relay reads `to` for routing. */
export interface UnicastEnvelope extends PulseFrameField {
  type: 'unicast';
  /** Target device ID */
  to: string;
  /** Encrypted payload: base64(iv + ciphertext + tag) */
  blob: string;
  /** Per-device RSA-OAEP encrypted AES key (base64) */
  keys: Record<string, string>;
  /** Optional reference ID, echoed back in server_error responses */
  ref?: string;
}

/** Tentacle → all devices. Relay broadcasts to all other devices under the user. */
export interface BroadcastEnvelope extends PulseFrameField {
  type: 'broadcast';
  /** Encrypted payload: base64(iv + ciphertext + tag) */
  blob: string;
  /** Per-device RSA-OAEP encrypted AES key (base64) */
  keys: Record<string, string>;
  /** Encrypted preview for push notifications to offline devices.
   *  Presence signals the relay to send a push. Contains a truncated
   *  summary encrypted with the same recipients as the main blob. */
  pushPreview?: BlobPayload;
}

export type RelayEnvelope = UnicastEnvelope | BroadcastEnvelope;

/** Encrypted blob payload — shared between crypto and app layers. */
export interface BlobPayload {
  /** base64(iv ‖ ciphertext ‖ tag) */
  blob: string;
  /** Per-recipient RSA-OAEP encrypted AES key (base64), keyed by deviceId */
  keys: Record<string, string>;
}

/** Ping / pong control messages for connection keepalive. */
export interface PingMessage {
  type: 'ping';
}

export interface PongMessage {
  type: 'pong';
}

// ============================================================
// Attachment types (shared between producer and consumer)
// ============================================================

/** Inline image carried directly in a message payload as base64.
 *  Used for user_message uploads from the PWA (already capped to ~3 MB by
 *  client-side compression) and small images that don't justify the
 *  attachment-store pipeline. */
export interface ImageAttachment {
  type: 'image';
  mimeType: string;
  /** base64-encoded image bytes */
  data: string;
  /** Optional caption shown beside/under the image */
  caption?: string;
  /** Optional original filename */
  name?: string;
}

/** Reference to content stored in the tentacle's attachment store —
 *  used as a lazy handle for image bytes, large tool output, large args,
 *  etc. The ref flows inline in messages; bytes flow separately via
 *  `attachment_data` chunks. */
export interface ContentRef {
  type: 'content_ref';
  /** Content-addressed id: sha256 hex truncated to 32 chars. */
  id: string;
  mimeType: string;
  /** Decoded byte size of the underlying content. */
  size: number;
  /** Optional caption (used for image attachments). */
  caption?: string;
  /** Optional original filename, e.g. "screenshot.png". */
  name?: string;
  /** Optional intrinsic width in CSS pixels — populated when the
   *  tentacle could parse it cheaply from an image file header. */
  width?: number;
  /** Optional intrinsic height in CSS pixels. */
  height?: number;
}

/** @deprecated Old name for {@link ContentRef}. Kept as alias during the
 *  v0.17 transition so callers can be migrated in one step. */
export type AttachmentRef = ContentRef;

export type Attachment = ImageAttachment | ContentRef;

// ============================================================
// Inner message base (inside encrypted blob, invisible to relay)
// ============================================================

interface BaseEnvelope {
  deviceId: string;
  seq: number;
  timestamp: string;
  sessionId?: string;
}

// ============================================================
// Producer messages (tentacle → app, inside encrypted blob)
// ============================================================

export interface SessionCreatedMessage extends BaseEnvelope {
  type: 'session_created';
  payload: {
    agent: string;
    model?: string;
    /** Echoed from create_session for request tracking */
    requestId?: string;
    /** Current last message seq (0 for new sessions, >0 for forks) */
    lastSeq?: number;
  };
}

export interface SessionEndedMessage extends BaseEnvelope {
  type: 'session_ended';
  payload: {
    reason: string;
  };
}

export interface UserMessage extends BaseEnvelope {
  type: 'user_message';
  payload: {
    content: string;
    attachments?: Attachment[];
    /** Echoed back from the originating `send_input.payload.clientId`,
     *  if any. Used by clients to correlate this broadcast with the
     *  pending placeholder they inserted optimistically on Send. Absent
     *  on legacy clients or historical replays — clients must fall back
     *  to a positional heuristic in that case. */
    clientId?: string;
  };
}

export interface AgentMessage extends BaseEnvelope {
  type: 'agent_message';
  payload: {
    content: string;
    attachments?: Attachment[];
    /** Number of TRACE steps (tool_start + agent_narration) recorded for this
     *  turn up to and including this bubble. Stamped by the tentacle at emit
     *  time from a running per-turn counter. Lets a concluded bubble show its
     *  "Steps" affordance from replay alone — WITHOUT first pulling the trace —
     *  so the button no longer depends on the (transient, non-persisted) trace
     *  being present in the client's store. `> 0` ⇒ the turn has steps to pull.
     *  Absent on pre-0.18 sessions (backfilled by scripts/backfill-trace.mjs). */
    steps?: number;
  };
}

/**
 * The streaming DRAFT BUBBLE for the in-progress turn — the assistant's live
 * words (narration / progress / conclusion). It is NOT shown inside the status
 * card; arms render it as a clean in-flow spine bubble that graduates to a
 * permanent {@link AgentMessage} at turn end. Keep-last semantics: each new
 * narration segment (or a finalize resummarize) `reset`s the draft, so only the
 * latest text shows. The tentacle owns and accumulates the full text; on the
 * wire it streams incrementally: each chunk is a `content` delta the client
 * APPENDS, unless `reset` is set (start of a new segment, a resummarize, or a
 * reconnect snapshot) in which case the client REPLACES the current text with
 * `content` first. Never persisted to the spine; the finalized prose lives in
 * `trace.jsonl` and is pulled per-turn for the "Steps" history.
 */
export interface AgentMessageDelta extends BaseEnvelope {
  type: 'agent_message_delta';
  payload: {
    /** Delta chunk to append (or the full text when `reset` is true). */
    content: string;
    /** When true, replace the current draft text with `content` before
     *  rendering (new narrative segment, a resummarize, or a reconnect push).
     *  Additive: legacy clients that ignore it fall back to append-only
     *  streaming (their original behavior). */
    reset?: boolean;
  };
}

export interface PermissionRequest extends BaseEnvelope {
  type: 'permission';
  payload: ToolArgs & {
    id: string;
    description: string;
    /** Only set when this request occupies a RESOLVED card slot (read-only
     *  view showing the outcome). Never present on a live/pending request —
     *  permission/question no longer broadcast standalone, so their payload's
     *  sole live home is the {@link CardActionState} slot. Absent on old-session
     *  spine records. */
    decision?: 'approve' | 'deny' | 'always_allow';
    /** Trace/history-only terminal state when the turn ended before a decision. */
    cancelled?: boolean;
  };
}

export interface QuestionRequest extends BaseEnvelope {
  type: 'question';
  payload: {
    id: string;
    question: string;
    choices?: string[];
    /** Whether the human may type a freeform answer in addition to `choices`. */
    allowFreeform?: boolean;
    /** Only set when this request occupies a RESOLVED card slot — see
     *  {@link PermissionRequest} `decision`. */
    answer?: string;
    /** A cancelled question remains visible but is never actionable. */
    cancelled?: boolean;
  };
}

/**
 * Live tool-lifecycle broadcast. Under the three-axis model these are no
 * longer persisted to messages.jsonl nor assigned a per-session (spine)
 * seq — they are removed from PERSISTENT_TYPES and instead mirrored to
 * `trace.jsonl`. They REMAIN the live wire event for a streaming turn's
 * steps: clients render them immediately and merge `tool_start` →
 * `tool_complete` by `toolCallId`. History / on-idle refresh is pulled via
 * {@link TurnTraceBatchMessage}, keyed by the concluding bubble's seq (no
 * separate turn id — a turn is already identified by its spine bubble).
 */
export interface ToolStartMessage extends BaseEnvelope {
  type: 'tool_start';
  payload: {
    toolName: string;
    /** Short user-facing preview of the tool invocation, composed on
     *  the tentacle side (≤ MAX_HEADLINE chars, ends with "…" if
     *  truncated). Always present; safe to render immediately even on
     *  cold replay. UX may upgrade to the full args text once
     *  `argsRef` resolves. */
    headline: string;
    /** Lazy ref to the full args JSON. Present when args exceed a tiny
     *  inline floor (so we don't pay a sha256 + round trip for trivial
     *  args). Absent for trivially small args. */
    argsRef?: ContentRef;
    /** Unique ID for this tool invocation (matches tool_complete) */
    toolCallId?: string;
  };
}

/** Live tool-completion broadcast — see {@link ToolStartMessage}. Also
 *  moved off the spine (transient broadcast + `trace.jsonl`), merged with
 *  its matching `tool_start` by `toolCallId`. */
export interface ToolCompleteMessage extends BaseEnvelope {
  type: 'tool_complete';
  payload: {
    toolName: string;
    /** Same headline as the matching `tool_start`, repeated for
     *  replay-completeness (a client that joins after `tool_start` has
     *  been buffered out should still see a chip header). */
    headline: string;
    /** Lazy ref to the full result body. Always present except when the
     *  tool produced no result text at all. Results are uniformly lazy
     *  so the wire shape stays predictable and replay batches stay flat. */
    resultRef?: ContentRef;
    /** Lazy ref to the full args JSON, repeated for replay convenience. */
    argsRef?: ContentRef;
    /** Unique ID matching the tool_start */
    toolCallId?: string;
    /** Whether the tool execution succeeded (default true if absent). */
    success?: boolean;
    /** Synthetic terminal outcome when the turn ended before this tool returned.
     *  `cancelled` means the user aborted; `interrupted` means the turn failed
     *  elsewhere (backend/process/model) and the tool result is unknown. */
    termination?: 'cancelled' | 'interrupted';
    /** Images produced by the tool (e.g. from `kraki-show_image`).
     *  Separate from `resultRef` because images render as a grid below
     *  the chip rather than as an expandable text body. */
    attachments?: Attachment[];
  };
}

/**
 * Finalized assistant NARRATION prose for one step of a turn — mirrored to the
 * TRACE axis for the lazy "Steps" history. The live draft bubble is streamed via
 * {@link AgentMessageDelta}; at `message_end` the finalized prose is ALSO emitted as
 * this trace step (broadcast live + mirrored to `trace.jsonl`, never the spine).
 * Pulled per-turn via {@link TurnTraceBatchMessage}, interleaved with tool steps
 * in append order.
 */
export interface AgentNarrationMessage extends BaseEnvelope {
  type: 'agent_narration';
  payload: {
    content: string;
  };
}

/**
 * The single "action slot" of the server-owned status card. tool, tool_batch,
 * permission and question share this ONE slot on equal footing (last-write-wins
 * by time) — there is no precedence between them. The tentacle owns the ENTIRE
 * decision of what occupies the slot; clients render it verbatim and perform
 * ZERO precedence/derivation logic. `id` is the round-trip handle: clients
 * answer a permission/question by sending approve/deny/always_allow/answer with
 * this id. When a permission/question is resolved it stays in the slot with its
 * `decision`/`answer` set (read-only) until a newer action replaces it or the
 * card clears.
 *
 * The agent may run tool calls in PARALLEL. A single running tool occupies the
 * slot as the tool's `tool_start`/`tool_complete` step; two-or-more concurrent
 * tools collapse into `tool_batch` carrying only the count (the per-tool detail
 * lives on the TRACE/"Steps" axis, keeping the live card a fixed-size single
 * slot). When the concurrency drops back to one, the slot returns to that
 * single tool step.
 *
 * DESIGN: a card action is just "the current step" — and a step already has a
 * wire type. Rather than redefine parallel `tool`/`permission`/`question`
 * shapes, each variant REUSES the existing message's `type` + `payload`
 * verbatim (minus the envelope): a running tool is a {@link ToolStartMessage},
 * a finished tool a {@link ToolCompleteMessage}, an open prompt a
 * {@link PermissionRequest}/{@link QuestionRequest}. The slot's discriminant is
 * therefore the message's own `type`; clients render it with the SAME code they
 * use for the live/trace step. A resolved prompt stays in the slot with its
 * payload's `decision`/`answer` set. `tool_batch` is the sole synthetic variant
 * (a concurrency count with no standalone message).
 */
export type CardActionState =
  | Pick<ToolStartMessage, 'type' | 'payload'>
  | Pick<ToolCompleteMessage, 'type' | 'payload'>
  | {
      type: 'tool_batch';
      payload: {
        /** How many tools are running CONCURRENTLY right now (always >= 2). Only
         *  the count is transmitted — the expandable per-tool detail comes from
         *  the TRACE/"Steps" axis, so the live card stays a fixed-size slot. */
        running: number;
      };
    }
  | Pick<PermissionRequest, 'type' | 'payload'>
  | Pick<QuestionRequest, 'type' | 'payload'>
  | {
      /** Transient Pi runtime activity. Never persisted to the conversation or
       *  trace; it only occupies the server-owned live status-card slot. */
      type: 'compaction';
      payload: {
        phase: 'running';
        reason?: 'manual' | 'threshold' | 'overflow';
      };
    }
  | {
      type: 'user_abort';
      payload: {
        abortedAt: string;
      };
    }
  | {
      type: 'failed';
      payload: {
        message: string;
        code?: string;
        source?: 'adapter' | 'backend' | 'process';
        failedAt: string;
      };
    };

/**
 * The ACTION part of the server-owned status card — the single active
 * affordance, or `null` when the slot is empty. Broadcast whenever the slot
 * changes (a tool starts/finishes, a permission/question opens, or an
 * affordance is resolved). Replace semantics: the payload always carries the
 * full current action state (or null), so reconnect = tentacle pushes the
 * current snapshot.
 */
export interface CardAction extends BaseEnvelope {
  type: 'card_action';
  payload: {
    action: CardActionState | null;
  };
}

export interface IdleMessage extends BaseEnvelope {
  type: 'idle';
  payload: {
    /** Cumulative session token usage (present when tracked by adapter) */
    usage?: import('./sessions.js').SessionUsage;
    /** Why the session went idle */
    reason?: 'completed' | 'aborted' | 'failed';
  };
}

export interface ActiveMessage extends BaseEnvelope {
  type: 'active';
  payload: Record<string, never>;
}

export interface ErrorMessage extends BaseEnvelope {
  type: 'error';
  payload: {
    message: string;
  };
}

/**
 * A Kraki-originated spine message — NOT the agent's words. Rendered like an
 * `agent_message` (persistent bubble, anchors the turn's "Steps" history) but
 * visually marked as a system notice so it's clear Kraki authored it.
 *
 * First use: `kind: 'no_reply'` — a turn ended without any `present_to_user`
 * (even after the single nudge). Instead of a silent void, Kraki leaves this
 * notice so the turn still has a bubble to hang its Steps off of.
 *
 * `content` is optional; when absent the client renders a default label keyed
 * off `kind`.
 */
export interface SystemMessage extends BaseEnvelope {
  type: 'system_message';
  payload: {
    kind: 'no_reply' | (string & {});
    content?: string;
    /** See {@link AgentMessage.payload.steps}. A `no_reply` notice also anchors
     *  a turn's Steps history, so it carries the same running step count. */
    steps?: number;
  };
}

/**
 * Durable snapshot of the live turn at the instant the user explicitly aborted.
 * Unlike the transient CardManager state, this lives on the conversation spine
 * and is replayed forever. It is Kraki UI history only and is never injected into
 * the agent/model transcript.
 */
export interface InterruptedTurnMessage extends BaseEnvelope {
  type: 'interrupted_turn';
  payload: {
    reason: 'user_aborted' | 'process_lost';
    draft: string;
    action: CardActionState | null;
    interruptedAt: string;
    /** Running tool actions are frozen as cancelled in history. */
    cancelled: true;
    /** Trace-step count accumulated before interruption. */
    steps?: number;
  };
}

/**
 * Durable terminal status-card snapshot. The card's action is itself the turn
 * outcome (`user_abort` or `failed`); unfinished work remains in TRACE with a
 * cancelled/interrupted resolution. This is UI history only and is never added
 * to the model transcript. `interrupted_turn` remains readable for legacy
 * history, while new terminal turns use this generic card container.
 */
export interface TurnStatusMessage extends BaseEnvelope {
  type: 'turn_status';
  payload: {
    draft: string;
    action: Extract<CardActionState, { type: 'user_abort' | 'failed' }>;
    finishedAt: string;
    steps?: number;
  };
}

export interface SessionModeSetMessage extends BaseEnvelope {
  type: 'session_mode_set';
  payload: {
    mode: import('./sessions.js').SessionMode;
  };
}

export interface SessionModelSetMessage extends BaseEnvelope {
  type: 'session_model_set';
  payload: {
    model: string;
    reasoningEffort?: import('./devices.js').ReasoningEffort;
    contextTier?: import('./devices.js').ContextTier;
  };
}

export interface SessionDeletedMessage extends BaseEnvelope {
  type: 'session_deleted';
  payload: Record<string, never>;
}

/** Broadcast by tentacle when a session title changes (manual or auto-generated). */
export interface SessionTitleUpdatedMessage extends BaseEnvelope {
  type: 'session_title_updated';
  payload: {
    /** Manual user-set title (undefined = not set) */
    title?: string;
    /** LLM-generated title */
    autoTitle?: string;
  };
}

/** Greeting sent by tentacle to a newly joined app via unicast. */
export interface DeviceGreetingMessage extends BaseEnvelope {
  type: 'device_greeting';
  payload: {
    name: string;
    kind?: string;
    agents?: import('./devices.js').AgentCapabilities[];
    version?: string;
  };
}

/**
 * Sent by tentacle to a device after replaying all buffered messages for a session.
 * @deprecated Use `request_session_messages` / `session_messages_batch` instead.
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

// ── Turn-aware message pagination ───────────────────

/** Sent by app to tentacle to request turn-aligned messages for a session. */
export interface RequestSessionMessagesMessage extends BaseEnvelope {
  type: 'request_session_messages';
  payload: {
    /** Session to load messages for. */
    sessionId: string;
    /** Load messages strictly before this seq. Omit to load from head. */
    beforeSeq?: number;
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
  | PermissionRequest
  | QuestionRequest;

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

/** Sent by tentacle to app with metadata for all active sessions. */
export interface SessionListMessage extends BaseEnvelope {
  type: 'session_list';
  payload: {
    sessions: import('./sessions.js').SessionDigest[];
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
    | { resolution: 'always_allowed' }
    | { resolution: 'cancelled'; reason?: string }
  );
}

/** Broadcast by tentacle when a question is answered (so all apps can clear the card). */
export interface QuestionResolvedMessage extends BaseEnvelope {
  type: 'question_resolved';
  payload: {
    questionId: string;
    answer: string;
    cancelled?: boolean;
  };
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

/** Chunk of attachment bytes — flows either as a broadcast (live, immediately
 *  after the message that referenced the attachment) or as a unicast response
 *  to `request_attachment`. The relay never sees the bytes; payload is inside
 *  the encrypted blob like any other message. */
export interface AttachmentDataMessage extends BaseEnvelope {
  type: 'attachment_data';
  payload: {
    /** Attachment id from the matching `AttachmentRef`. */
    id: string;
    /** 0-based chunk index. */
    index: number;
    /** Total chunk count for this attachment. */
    total: number;
    /** MIME type echoed for convenience. */
    mimeType: string;
    /** base64 of this chunk's bytes. Empty when `error` is set. */
    data: string;
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
  | QuestionRequest
  | ToolStartMessage
  | ToolCompleteMessage
  | AgentNarrationMessage
  | CardAction
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
  | SessionListMessage
  | PermissionResolvedMessage
  | QuestionResolvedMessage
  | LocalSessionsListMessage
  | AttachmentDataMessage;

// ============================================================
// Consumer messages (app → tentacle, inside encrypted blob)
// ============================================================

export interface SendInputMessage extends BaseEnvelope {
  type: 'send_input';
  payload: {
    text: string;
    attachments?: Attachment[];
    /** Client-generated correlation id (UUID). When present, tentacle
     *  echoes it back inside the resulting `user_message` broadcast,
     *  allowing the originating client to resolve its pending
     *  placeholder unambiguously — even with multiple in-flight sends,
     *  reconnects, or multi-device scenarios. Optional for back-compat
     *  with older clients. */
    clientId?: string;
    /** Delivery intent chosen by the app from its observed session state.
     *  `steer` interjects into the current active turn; omitted/`prompt`
     *  preserves the normal idle-session prompt behavior. */
    delivery?: 'prompt' | 'steer';
  };
}

export interface ApproveMessage extends BaseEnvelope {
  type: 'approve';
  payload: {
    permissionId: string;
  };
}

export interface DenyMessage extends BaseEnvelope {
  type: 'deny';
  payload: {
    permissionId: string;
  };
}

export interface AlwaysAllowMessage extends BaseEnvelope {
  type: 'always_allow';
  payload: {
    permissionId: string;
    /** Tool kind to add to the allow list (e.g. 'shell', 'write') */
    toolKind?: string;
  };
}

export interface AnswerMessage extends BaseEnvelope {
  type: 'answer';
  payload: {
    questionId: string;
    answer: string;
    attachments?: Attachment[];
    /** True when the answer was typed freely rather than picked from a
     *  provided choice. Adapters (e.g. copilot) use this to decide whether the
     *  answer maps to a listed option or is custom text. Optional for backward
     *  compatibility; treated as `false` when absent. */
    wasFreeform?: boolean;
  };
}

export interface KillSessionMessage extends BaseEnvelope {
  type: 'kill_session';
  payload: Record<string, never>;
}

export interface AbortSessionMessage extends BaseEnvelope {
  type: 'abort_session';
  payload: Record<string, never>;
}

export interface CreateSessionMessage extends BaseEnvelope {
  type: 'create_session';
  payload: {
    /** Client-generated request ID for tracking success/failure */
    requestId: string;
    /** Target tentacle device ID */
    targetDeviceId: string;
    /** Which agent to use for this session */
    agentId: import('./devices.js').AgentId;
    /** Agent model to use (e.g. "claude-sonnet-4") */
    model: string;
    /** Reasoning effort level (only for models that support it) */
    reasoningEffort?: import('./devices.js').ReasoningEffort;
    /** Context tier (only for models that support long_context) */
    contextTier?: import('./devices.js').ContextTier;
    /** Initial prompt to send after session is created */
    prompt?: string;
    /** Working directory for the session */
    cwd?: string;
  };
}

export interface SetSessionModeMessage extends BaseEnvelope {
  type: 'set_session_mode';
  payload: {
    mode: import('./sessions.js').SessionMode;
  };
}

export interface SetSessionModelMessage extends BaseEnvelope {
  type: 'set_session_model';
  payload: {
    model: string;
    reasoningEffort?: import('./devices.js').ReasoningEffort;
    contextTier?: import('./devices.js').ContextTier;
  };
}

export interface DeleteSessionMessage extends BaseEnvelope {
  type: 'delete_session';
  payload: Record<string, never>;
}

export interface ForkSessionMessage extends BaseEnvelope {
  type: 'fork_session';
  payload: {
    /** Client-generated request ID for tracking success/failure */
    requestId: string;
    /** Session to fork from */
    sourceSessionId: string;
  };
}

export interface MarkReadMessage extends BaseEnvelope {
  type: 'mark_read';
  payload: {
    /** The highest seq the client has seen for this session */
    seq: number;
  };
}

/**
 * Sent by app to tentacle to request replay for a specific session.
 * @deprecated Use `request_session_messages` / `session_messages_batch` instead.
 */
export interface RequestSessionReplayMessage extends BaseEnvelope {
  type: 'request_session_replay';
  payload: {
    /** Session to replay. */
    sessionId: string;
    /** Replay messages with seq strictly greater than this value. Use 0 for full replay. */
    afterSeq: number;
    /** Max number of messages to return. Omit for all. */
    limit?: number;
  };
}

/** Sent by app to tentacle to rename a session. */
export interface RenameSessionMessage extends BaseEnvelope {
  type: 'rename_session';
  payload: {
    /** New manual title. Empty string clears manual title (reverts to auto-title). */
    title: string;
  };
}

export interface PinSessionMessage extends BaseEnvelope {
  type: 'pin_session';
  payload: {
    pinned: boolean;
  };
}

/** Mark a session as unread. Tentacle rolls back readSeq. */
export interface MarkUnreadMessage extends BaseEnvelope {
  type: 'mark_unread';
  payload: Record<string, never>;
}

/** Request catalog of local Copilot sessions for the import picker. */
export interface RequestLocalSessionsMessage extends BaseEnvelope {
  type: 'request_local_sessions';
  payload: {
    requestId?: string;
    filter?: {
      /** Case-insensitive substring across summary, cwd, gitRoot, repository, branch. */
      search?: string;
      /** Only live sessions. */
      liveOnly?: boolean;
      /** Include already-imported sessions. Default false. */
      includeLinked?: boolean;
    };
  };
}

/** Import a local Copilot session into Kraki.
 *  Tentacle resumes the same session ID — both Kraki and original CLI share state on disk. */
export interface ImportSessionMessage extends BaseEnvelope {
  type: 'import_session';
  payload: {
    /** Echoed in session_created.payload.requestId on success. */
    requestId: string;
    /** Must match a sessionId from a previous local_sessions_list. */
    localSessionId: string;
    /** Metadata from the picker — avoids re-scanning filesystem on import. */
    meta?: {
      cwd?: string;
      summary?: string;
      source?: import('./sessions.js').LocalSessionSource;
      model?: string;
      branch?: string;
      startTime?: string;
    };
  };
}

/** Sent by app to tentacle to request the bytes of a stored attachment.
 *  Used when a client sees an `AttachmentRef` it can't satisfy from its local
 *  cache (typical after reconnect/replay). Tentacle responds with one or more
 *  `attachment_data` messages addressed to the requester. */
export interface RequestAttachmentMessage extends BaseEnvelope {
  type: 'request_attachment';
  payload: {
    /** Attachment id from the AttachmentRef. */
    id: string;
    /** Session the attachment belongs to (used for AttachmentStore scoping). */
    sessionId: string;
  };
}

export type ConsumerMessage =
  | SendInputMessage
  | ApproveMessage
  | DenyMessage
  | AlwaysAllowMessage
  | AnswerMessage
  | KillSessionMessage
  | AbortSessionMessage
  | CreateSessionMessage
  | ForkSessionMessage
  | SetSessionModeMessage
  | SetSessionModelMessage
  | DeleteSessionMessage
  | MarkReadMessage
  | MarkUnreadMessage
  | RequestSessionReplayMessage
  | RequestSessionMessagesMessage
  | RequestSessionMessagesRangeMessage
  | RequestTurnTraceMessage
  | RequestCardMessage
  | RenameSessionMessage
  | PinSessionMessage
  | RequestLocalSessionsMessage
  | ImportSessionMessage
  | RequestAttachmentMessage;

// ============================================================
// Auth credentials — discriminated union by method
// ============================================================

export interface GithubTokenAuth {
  method: 'github_token';
  token: string;
}

export interface GithubOAuthAuth {
  method: 'github_oauth';
  code: string;
  /**
   * PKCE code verifier — the random string whose SHA-256 hash was sent
   * as `code_challenge` when this OAuth flow was started. Optional for
   * back-compat, but required by GitHub's token-exchange endpoint when
   * a `code_challenge` was originally provided.
   */
  codeVerifier?: string;
  /**
   * The exact `redirect_uri` the client used in the authorize URL.
   * GitHub validates this matches at token-exchange time when the
   * authorize request included one. Optional to preserve back-compat
   * with older clients that never sent it.
   */
  redirectUri?: string;
}

export interface PairingAuth {
  method: 'pairing';
  token: string;
}

export interface ChallengeAuth {
  method: 'challenge';
  deviceId: string;
}

export interface ApiKeyAuth {
  method: 'apikey';
  key: string;
}

export interface OpenAuth {
  method: 'open';
  sharedKey?: string;
}

export type AuthMethod = GithubTokenAuth | GithubOAuthAuth | PairingAuth | ChallengeAuth | ApiKeyAuth | OpenAuth;

// ============================================================
// Control messages (device ↔ relay, unencrypted)
// ============================================================

export interface AuthMessage {
  type: 'auth';
  auth: AuthMethod;
  device: DeviceInfo;
}

export interface AuthOkMessage {
  type: 'auth_ok';
  deviceId: string;
  /** The auth method that was used */
  authMethod: AuthMethod['method'];
  user: { id: string; login: string; provider: string; email?: string; preferences?: Record<string, unknown>; region?: string };
  devices: DeviceSummary[];
  /** GitHub OAuth client ID (present when GitHub OAuth is configured for web login) */
  githubClientId?: string;
  /** VAPID public key for Web Push (present when web_push is enabled) */
  vapidPublicKey?: string;
  /** Relay server version */
  relayVersion?: string;
  /**
   * Voice dictation capability for this region. Absent when the head has
   * no voice broker configured — arm should hide the mic UI in that case.
   * See `VoiceCapability` for the contract.
   */
  voice?: VoiceCapability;
}

export type AuthErrorCode =
  | 'auth_rejected'
  | 'unknown_auth_method'
  | 'pairing_disabled'
  | 'invalid_pairing_token'
  | 'unknown_device'
  | 'no_pending_challenge'
  | 'device_not_found'
  | 'invalid_signature'
  | 'user_not_found'
  | 'device_registration_failed'
  | 'wrong_region';

export interface AuthErrorMessage {
  type: 'auth_error';
  /** Machine-readable auth failure reason for client behavior */
  code: AuthErrorCode;
  message: string;
  /** When code is 'wrong_region', the correct relay URL to connect to */
  redirect?: string;
}

export interface AuthChallengeMessage {
  type: 'auth_challenge';
  nonce: string;
}

export interface AuthResponseMessage {
  type: 'auth_response';
  deviceId: string;
  signature: string;
}

export interface ServerErrorMessage {
  type: 'server_error';
  message: string;
  /** Echoed from UnicastEnvelope.ref if present */
  ref?: string;
}

/** One-shot pairing token request — no device registration needed */
export interface RequestPairingTokenMessage {
  type: 'request_pairing_token';
  /** Auth token (e.g. GitHub token) to prove identity */
  token: string;
}

export interface PairingTokenCreatedMessage {
  type: 'pairing_token_created';
  token: string;
  expiresIn: number;
}

export interface CreatePairingTokenMessage {
  type: 'create_pairing_token';
}

/** Pre-auth request to discover server capabilities. */
export interface AuthInfoRequest {
  type: 'auth_info';
}

/** Server response with supported auth methods and features. */
export interface AuthInfoResponse {
  type: 'auth_info_response';
  /** Supported auth methods (e.g. ['github_token', 'github_oauth', 'pairing']) */
  methods: AuthMethod['method'][];
  /** GitHub OAuth client ID (present when github_oauth is available) */
  githubClientId?: string;
  /** VAPID public key for Web Push (present when web_push is enabled) */
  vapidPublicKey?: string;
}

/** Sent to all connected devices when a new device joins the user's account. */
export interface DeviceJoinedMessage {
  type: 'device_joined';
  device: DeviceSummary;
}

/** Sent to all connected devices when a device disconnects. */
export interface DeviceLeftMessage {
  type: 'device_left';
  deviceId: string;
}

/** Sent to all connected devices when a device's liveness is uncertain
 *  (ping sent but pong not yet received within the grace period).
 *  Transient: will be followed by either device_joined (recovered)
 *  or device_left (terminated). */
export interface DevicePendingMessage {
  type: 'device_pending';
  deviceId: string;
}

/** Request to remove an offline device from the user's account. */
export interface RemoveDeviceMessage {
  type: 'remove_device';
  deviceId: string;
}

/** Broadcast confirmation that a device was removed. */
export interface DeviceRemovedMessage {
  type: 'device_removed';
  deviceId: string;
}

/** Update user preferences on the relay (e.g. intro dismissal flags). */
export interface UpdatePreferencesMessage {
  type: 'update_preferences';
  preferences: Record<string, unknown>;
}

/** Confirmation that preferences were updated. */
export interface PreferencesUpdatedMessage {
  type: 'preferences_updated';
  preferences: Record<string, unknown>;
}

// ── Push notification token management ──────────────────

/** Register a push notification token for this device. */
export interface RegisterPushTokenMessage {
  type: 'register_push_token';
  payload: {
    /** Push provider type */
    provider: import('./devices.js').PushProviderType;
    /** Device token from the push service */
    token: string;
    /** APNs environment */
    environment?: 'production' | 'sandbox';
    /** APNs topic (bundle ID) */
    bundleId?: string;
  };
}

/** Confirmation that a push token was registered. */
export interface PushTokenRegisteredMessage {
  type: 'push_token_registered';
  payload: {
    provider: import('./devices.js').PushProviderType;
  };
}

/** Remove the push token for this device. */
export interface UnregisterPushTokenMessage {
  type: 'unregister_push_token';
  payload: {
    provider: import('./devices.js').PushProviderType;
  };
}

export type ControlMessage =
  | AuthMessage
  | AuthOkMessage
  | AuthErrorMessage
  | AuthChallengeMessage
  | AuthResponseMessage
  | ServerErrorMessage
  | RequestPairingTokenMessage
  | PairingTokenCreatedMessage
  | CreatePairingTokenMessage
  | AuthInfoRequest
  | AuthInfoResponse
  | DeviceJoinedMessage
  | DeviceLeftMessage
  | DevicePendingMessage
  | RemoveDeviceMessage
  | DeviceRemovedMessage
  | UpdatePreferencesMessage
  | PreferencesUpdatedMessage
  | RegisterPushTokenMessage
  | PushTokenRegisteredMessage
  | UnregisterPushTokenMessage;

// ============================================================
// Union of all messages
// ============================================================

/** Inner message (decrypted from blob) */
export type InnerMessage = ProducerMessage | ConsumerMessage;

/** Everything that flows over the WebSocket */
export type Message = RelayEnvelope | ControlMessage;

// Re-export types used in control messages
import type { DeviceSummary, DeviceRole, DeviceInfo, DeviceCapabilities, PushProviderType } from './devices.js';
import type { SessionSummary, SessionDigest, SessionMode, SessionUsage } from './sessions.js';
import type { ToolArgs } from './tools.js';
import type { VoiceCapability } from './voice.js';
export type { DeviceSummary, DeviceRole, DeviceInfo, DeviceCapabilities, PushProviderType, SessionSummary, SessionDigest, SessionMode, SessionUsage, ToolArgs };
