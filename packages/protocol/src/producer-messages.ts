// Producer messages (tentacle → app): sessions, turns, tools, cards, status, greeting.

import type { ToolArgs } from './tools.js';
import { type ContentRef, type Attachment } from './attachments.js';
import { type BaseEnvelope } from './message-base.js';

// ============================================================
// Producer messages (tentacle → app, inside encrypted blob)
// ============================================================

export interface SessionCreatedMessage extends BaseEnvelope {
  type: 'session_created';
  payload: {
    agent: string;
    model?: string;
    reasoningEffort?: import('./devices.js').ReasoningEffort;
    /** Echoed from create_session for request tracking */
    requestId?: string;
    /** Current last message seq (0 for new sessions, >0 for forks) */
    lastSeq?: number;
    /** Permission mode the session starts in (wire name). */
    mode?: import('./sessions.js').WireSessionMode;
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
    /** Echoed delivery intent. A steer remains visible in the spine but is
     *  part of the current logical agent turn, so trace and artifact consumers
     *  must not treat it as a new turn boundary. */
    delivery?: 'prompt' | 'steer';
    /** Set when this message answers a question (`agent_message.payload.question.id`). */
    answerTo?: string;
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
    /** Present when the agent asks the human (`ask_user`). `content` is the
     *  agent's lead-in prose (may be empty). The human can always answer in
     *  free text; `choices` are only shortcuts that send their text as the
     *  answer. Still open while no other spine message follows it (answered by
     *  the `user_message` with `answerTo === question.id`; any other following
     *  message means it was not answered). */
    question?: {
      id: string;
      text: string;
      choices?: string[];
    };
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
     *  a permission is not broadcast standalone, so its payload's sole live
     *  home is the {@link CardActionState} slot. Absent on old-session
     *  spine records. `always_allow` appears only in history written by
     *  tentacles before 0.38.7. */
    decision?: 'approve' | 'deny' | 'always_allow';
    /** Trace/history-only terminal state when the turn ended before a decision. */
    cancelled?: boolean;
    /** Set when a subagent asked: the dispatching step's toolCallId. */
    parentToolCallId?: string;
  };
}

/**
 * A subagent run, attached to the trace step that dispatched it (the agent's
 * Task/Agent/task/spawn tool call, or a synthetic step for one child of a
 * multi-child dispatch). The subagent's own steps carry `parentToolCallId`
 * pointing at that step; its report is the dispatching step's tool result.
 * Clients show the step as a card that opens the subagent's own steps.
 * Every field is a display hint — unknown/absent fields degrade gracefully.
 */
export interface SubagentInfo {
  /** Short role / agent name, e.g. "scout", "Explore", "find_codeword". */
  name: string;
  /** One-line task description (never the full prompt). */
  task?: string;
  status?: 'running' | 'completed' | 'failed' | 'stopped';
  /** Total tokens the subagent used, when the agent reports it. */
  tokens?: number;
  /** Number of tool calls the subagent made, when reported. */
  toolCount?: number;
  durationMs?: number;
}

/**
 * Tool-lifecycle trace record. Under the three-axis model these are neither
 * persisted to messages.jsonl nor assigned a per-session (spine) seq. Current
 * Tentacle mirrors them to `trace.jsonl` and projects live state through the
 * server-owned `card_action` slot; it does not broadcast raw standalone tool
 * messages. Arms may still decode this shape for pulled trace history and
 * legacy Tentacle compatibility, merging `tool_start` → `tool_complete` by
 * `toolCallId`. History is pulled via {@link TurnTraceBatchMessage}, keyed by
 * the concluding bubble's seq.
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
    /** Set when a subagent made this call: the dispatching step's toolCallId. */
    parentToolCallId?: string;
    /** Set when this step dispatched a subagent. */
    subagent?: SubagentInfo;
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
    /** See {@link ToolStartMessage}. */
    parentToolCallId?: string;
    /** Latest subagent state. A dispatch step may complete more than once
     *  (e.g. a background subagent: launch receipt, then its report); the
     *  last `tool_complete` for a toolCallId is authoritative. */
    subagent?: SubagentInfo;
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
    /** Set when a subagent said this: the dispatching step's toolCallId. */
    parentToolCallId?: string;
  };
}

/**
 * The single "action slot" of the server-owned status card. tool, tool_batch
 * and permission share this ONE slot on equal footing (last-write-wins by
 * time) — there is no precedence between them. The tentacle owns the ENTIRE
 * decision of what occupies the slot; clients render it verbatim and perform
 * ZERO precedence/derivation logic. A permission's `id` is the round-trip
 * handle: clients answer it by sending approve/deny with this id.
 * When a permission is resolved it stays in the slot with its `decision` set
 * (read-only) until a newer action replaces it or the card clears.
 *
 * Questions are NOT a card action: they live on the spine as
 * `agent_message.payload.question` and are answered with `send_input`
 * (`answerTo`).
 *
 * The agent may run tool calls in PARALLEL. A single running tool occupies the
 * slot as the tool's `tool_start`/`tool_complete` step; two-or-more concurrent
 * tools collapse into `tool_batch` carrying only the count (the per-tool detail
 * lives on the TRACE/"Steps" axis, keeping the live card a fixed-size single
 * slot). When the concurrency drops back to one, the slot returns to that
 * single tool step.
 *
 * DESIGN: a card action is just "the current step" — and a step already has a
 * wire type. Rather than redefine parallel shapes, each variant REUSES the
 * existing message's `type` + `payload` verbatim (minus the envelope): a
 * running tool is a {@link ToolStartMessage}, a finished tool a
 * {@link ToolCompleteMessage}, an open prompt a {@link PermissionRequest}. The
 * slot's discriminant is therefore the message's own `type`; clients render it
 * with the SAME code they use for the live/trace step. `tool_batch`,
 * `user_abort` and `failed` are the synthetic variants (a concurrency count and
 * the two terminal outcomes, which have no standalone message).
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

/**
 * The agent runtime is compacting its context. This is transient maintenance,
 * orthogonal to the active/idle conversational state: a completed turn may be
 * idle and accept a fresh user message while threshold compaction continues.
 * Overflow recovery can still coincide with an active turn.
 *
 * Never persisted to spine/TRACE. `phase: 'end'.nextState` remains for wire
 * compatibility with older clients; new clients use it only as a fallback and
 * keep compaction in their independent runtime-status store.
 */
export interface CompactingMessage extends BaseEnvelope {
  type: 'compacting';
  sessionId: string;
  payload:
    | {
        phase: 'start';
        reason?: 'manual' | 'threshold' | 'overflow';
      }
    | {
        phase: 'end';
        nextState: 'active' | 'idle';
      };
}

export interface IdleMessage extends BaseEnvelope {
  type: 'idle';
  payload: {
    /** Cumulative session token usage (present when tracked by adapter) */
    usage?: import('./sessions.js').SessionUsage;
    /** Why the session went idle */
    reason?: 'completed' | 'aborted' | 'failed';
    /** User-visible image/HTML artifacts produced during the turn closed by
     *  this idle. Durable spine authority; bytes remain in AttachmentStore. */
    turnArtifacts?: ContentRef[];
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
    /** Echoed from create_session / fork_session / import_session when the
     *  error is that request's failure, so the requester can resolve its
     *  pending placeholder instead of timing out. */
    requestId?: string;
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
    mode: import('./sessions.js').WireSessionMode;
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
    /** Behaviours an app may rely on. `idempotent_input`: a `send_input`
     *  retried with the same clientId is never dispatched twice and is
     *  re-echoed, so apps may re-send unconfirmed inputs automatically.
     *  `fragments`: accepts and (to apps that reply with `client_features`)
     *  sends large payloads as fragments (see fragments.ts). */
    features?: string[];
    /** Whether a newer Kraki is available for this computer (absent from
     *  tentacles older than 0.36). */
    update?: DeviceUpdateInfo;
  };
}

/** How Kraki is installed on a computer, which decides how it is updated:
 *  `mac-app` = built into Kraki for Mac (the app is the unit of update),
 *  `app-bundle` = the CLI's macOS Kraki.app, `binary` = single executable,
 *  `npm` = `npm i -g @kraki/tentacle`, `windows-app` = built into Kraki for
 *  Windows (updated with the app, never in place). */
export type KrakiInstallMethod = 'mac-app' | 'windows-app' | 'app-bundle' | 'binary' | 'npm' | 'unknown';

export interface DeviceUpdateInfo {
  installedVia: KrakiInstallMethod;
  /** Version of what an update replaces: the Mac app's version for
   *  `mac-app`, otherwise the tentacle's. */
  current: string;
  /** Set only when a newer version than `current` is available. */
  latest?: string;
  /** Newest published tentacle, so apps can tell computers that predate
   *  this field that they are out of date. */
  latestTentacle?: string;
  /** This computer accepts `update_device` from apps. */
  remote?: boolean;
  /** Why it doesn't: turned off on the computer, the install isn't writable
   *  by the user Kraki runs as (e.g. npm under a root-owned prefix), or an
   *  install method that can't be updated in place. */
  remoteBlock?: 'disabled' | 'not_writable' | 'unsupported';
  /** ISO time of the last successful check. */
  checkedAt?: string;
}
