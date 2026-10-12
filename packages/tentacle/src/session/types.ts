/** Session state shapes (on disk under ~/.kraki/sessions/<id>/). */

// ── Types ───────────────────────────────────────────────

/** A single logged message in a session's message log. */
export interface LoggedMessage {
  seq: number;
  type: string;
  payload: string;
  ts: string;
}

/**
 * One line in a session's `trace.jsonl` — a tool/action trace record mirrored
 * off the spine and projected live through `card_action`. Tagged with the
 * turn's start seq (the user_message
 * that began the turn) so a turn's steps can be pulled by its bubble seq.
 * `payload` is the full enriched wire message (same JSON that was broadcast).
 */
export interface TraceLine {
  turnStartSeq: number;
  type: string;
  payload: string;
  ts: string;
}

// ── Types ───────────────────────────────────────────────

export interface SessionContext {
  summary: string;
  keyFiles: string[];
  lastUserMessage: string;
  pendingAction?: string;
  updatedAt: string;
}

export type SessionMode = import('@kraki/protocol').SessionMode;

/** One session_list entry (a SessionDigest without live overlays). */
export interface SessionListEntry {
  id: string;
  agent: string;
  model?: string;
  reasoningEffort?: import('@kraki/protocol').ReasoningEffort;
  title?: string;
  autoTitle?: string;
  state: 'active' | 'idle';
  mode: import('@kraki/protocol').WireSessionMode;
  pinned?: boolean;
  archived?: boolean;
  lastSeq: number;
  readSeq: number;
  messageCount: number;
  createdAt: string;
  lastActivityAt?: string;
  usage?: import('@kraki/protocol').SessionUsage;
  source?: import('@kraki/protocol').LocalSessionSource | 'imported';
  preview?: import('@kraki/protocol').SessionPreviewDigest;
}

export interface SessionMeta {
  id: string;
  /** A fork whose attachments are still being linked from this session. */
  attachmentsFrom?: string;
  agent: string;
  model?: string;
  reasoningEffort?: import('@kraki/protocol').ReasoningEffort;
  title?: string;
  autoTitle?: string;
  state: 'active' | 'idle' | 'ended' | 'disconnected';
  mode: SessionMode;
  pinned?: boolean;
  /** Archived: left out of session_list until opened or written to (F2). */
  archived?: boolean;
  currentRunId: string;
  totalRuns: number;
  lastSeq: number;
  readSeq: number;
  createdAt: string;
  updatedAt: string;
  /** Cumulative token usage (persisted across restarts) */
  usage?: import('@kraki/protocol').SessionUsage;
  /** Origin of this session — set for imported sessions */
  source?: import('@kraki/protocol').LocalSessionSource | 'imported';
  /** Seq numbers of idle messages — used for turn-aligned pagination. */
  idleSeqs?: number[];
  /** Spine seq of the user_message that began the current turn. Trace
   *  entries (tool_start/tool_complete) are tagged with this so a turn's
   *  steps can be pulled by its concluding bubble seq. Mid-turn spine
   *  messages (permission/question) do NOT move it. */
  currentTurnStartSeq?: number;
}

export interface RunRecord {
  id: string;
  startedAt: string;
  endedAt?: string;
  endReason?: string;
}

/** Durable human-blocking state kept outside the model transcript. The
 *  question itself is on the spine (an `agent_message` carrying `question`);
 *  this record only lets Tentacle route an answer after a restart. */
export interface PendingHumanAction {
  version: 2;
  kind: 'question';
  questionId: string;
  question: string;
  choices?: string[];
  /** Spine seq of the question message. */
  questionSeq?: number;
  createdAt: string;
}

/** Restart-safe identity record for an Arm send_input request. Never stores
 * message body; the hash is only used to detect clientId reuse with different input. */
export interface InputLedgerEntry {
  version: 1;
  clientId: string;
  status: 'pending' | 'persisted' | 'dispatching' | 'delivered' | 'settled' | 'rejected';
  requestedDelivery: 'prompt' | 'steer';
  delivery: 'prompt' | 'steer' | 'follow_up';
  turnId: string;
  contentLength: number;
  contentHash: string;
  userSeq?: number;
  updatedAt: string;
}

/** Link between a local Copilot session and a Kraki session. */
export interface SessionLink {
  localSessionId: string;
  krakiSessionId: string;
  source: import('@kraki/protocol').LocalSessionSource;
  cwd?: string;
  branch?: string;
  linkedAt: string;
}
