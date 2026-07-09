/**
 * Abstract base class for coding agent adapters.
 *
 * Each concrete adapter (Copilot, Claude Code, Codex, etc.) wraps
 * an agent's SDK and normalises its events into Kraki protocol types.
 *
 * The tentacle runtime sets the `on*` callbacks before calling `start()`.
 * The adapter fires them as the agent produces events.
 */

import type { ToolArgs, ModelDetail, SessionUsage } from '@kraki/protocol';
import type { SessionContext } from '../session-manager.js';

// ── Callback payload types ──────────────────────────────

export interface SessionCreatedEvent {
  sessionId: string;
  agent: string;
  model?: string;
}

export interface MessageEvent {
  content: string;
}

export interface MessageDeltaEvent {
  content: string;
}

export interface PermissionRequestEvent {
  id: string;
  toolArgs: ToolArgs;
  description: string;
}

export interface QuestionRequestEvent {
  id: string;
  question: string;
  choices?: string[];
  allowFreeform: boolean;
}

export interface ToolStartEvent {
  toolName: string;
  args: Record<string, unknown>;
  toolCallId?: string;
}

export interface ToolCompleteEvent {
  toolName: string;
  result: string;
  toolCallId?: string;
  success?: boolean;
  attachments?: import('@kraki/protocol').Attachment[];
}

/** Emitted alongside a tool_complete that carries one or more
 *  `ContentRef`s. Tells the runtime (RelayClient) to broadcast the bytes
 *  to all connected devices as `attachment_data` chunks. */
export interface AttachmentBytesEvent {
  refs: Array<import('@kraki/protocol').ContentRef>;
}

export interface SessionEndedEvent {
  reason: string;
}

export interface ErrorEvent {
  message: string;
}

/** A Kraki-originated system notice (not the agent's words). See
 *  protocol `SystemMessage`. First use: `kind: 'no_reply'`. */
export interface SystemMessageEvent {
  kind: string;
  content?: string;
}

// ── Session configuration ───────────────────────────────

export interface CreateSessionConfig {
  /** Agent-specific model identifier (e.g. "claude-opus-4.6-1m") */
  model?: string;
  /** Reasoning effort level (for models that support it) */
  reasoningEffort?: string;
  /** Context tier (for models that support long_context) */
  contextTier?: string;
  /** Working directory for the session */
  cwd?: string;
  /** Caller-supplied session ID (adapter may ignore) */
  sessionId?: string;
  /** Target agent when using MultiAgentAdapter */
  agentId?: import('@kraki/protocol').AgentId;
}

// ── Session info returned by listSessions ───────────────

export interface SessionInfo {
  id: string;
  state: 'active' | 'idle' | 'ended';
  model?: string;
  cwd?: string;
  summary?: string;
}

// ── Permission decision type ────────────────────────────

export type PermissionDecision = 'approve' | 'deny' | 'always_allow';

// ── The adapter interface ───────────────────────────────

export abstract class AgentAdapter {
  // --- Callbacks (set by the tentacle runtime) ---

  onSessionCreated: ((event: SessionCreatedEvent) => void) | null = null;
  onMessage: ((sessionId: string, event: MessageEvent) => void) | null = null;
  onMessageDelta: ((sessionId: string, event: MessageDeltaEvent) => void) | null = null;
  /** Streaming chunk of a FINALIZE resummarize (finalize_reply.text) — the
   *  agent's rewritten closing message, streamed at the end of the turn so the
   *  draft bubble morphs seamlessly into the final reply. Distinct from
   *  onMessageDelta (ongoing working narration): this replaces the frozen draft
   *  in place. Adapters that don't stream a resummarize leave this null and
   *  crystallize the whole finalize text via onMessage instead. */
  onFinalizeDelta: ((sessionId: string, event: MessageDeltaEvent) => void) | null = null;
  /** Called at message_end with the FINALIZED assistant narration prose (private
   *  reasoning). The streaming delta (onMessageDelta) is ephemeral/live-only;
   *  this finalized text is persisted to the TRACE axis (trace.jsonl) as an
   *  `agent_narration` step, interleaved with tool steps, so a turn's steps can
   *  be pulled later. NEVER a spine bubble (that is the final reply only). */
  onNarration: ((sessionId: string, event: MessageEvent) => void) | null = null;
  /** Called to MIRROR a finalized narration segment to the TRACE axis
   *  (trace.jsonl) as an `agent_narration` step — the durable "Steps" history,
   *  distinct from onNarration's live draft reconcile. Split from onNarration so
   *  an adapter can reconcile the live draft on EVERY segment (avoiding a
   *  draft→bubble size-jump) while tracing ONLY the segments that are genuine
   *  intermediate steps — never the trailing segment that graduates into the
   *  concluding bubble (which would otherwise show duplicated: once as the last
   *  Step and once as the bubble). */
  onNarrationTrace: ((sessionId: string, event: MessageEvent) => void) | null = null;
  onPermissionRequest: ((sessionId: string, event: PermissionRequestEvent) => void) | null = null;
  /** Called when a permission is auto-resolved (e.g. by "Always Allow" for same tool kind, or cancelled on cleanup) */
  onPermissionAutoResolved: ((sessionId: string, permissionId: string, resolution: 'approved' | 'cancelled') => void) | null = null;
  onQuestionAutoResolved: ((sessionId: string, questionId: string) => void) | null = null;
  onQuestionRequest: ((sessionId: string, event: QuestionRequestEvent) => void) | null = null;
  onToolStart: ((sessionId: string, event: ToolStartEvent) => void) | null = null;
  onToolComplete: ((sessionId: string, event: ToolCompleteEvent) => void) | null = null;
  /** Called immediately after onToolComplete when bytes need to be pushed
   *  (broadcast as `attachment_data` chunks) to connected devices. */
  onAttachmentBytes: ((sessionId: string, event: AttachmentBytesEvent) => void) | null = null;
  onIdle: ((sessionId: string) => void) | null = null;
  /** Called when the adapter has finished all writes to the session's history file
   *  after a turn completes. Used by EventsWatcher to safely resume watching. */
  onFlushComplete: ((sessionId: string) => void) | null = null;
  onError: ((sessionId: string, event: ErrorEvent) => void) | null = null;
  /** Called when Kraki itself needs to leave a spine notice (not the agent's
   *  words) — e.g. `kind: 'no_reply'` when a turn ends without any reply.
   *  Rendered as a system-marked bubble that still anchors the turn's Steps. */
  onSystemMessage: ((sessionId: string, event: SystemMessageEvent) => void) | null = null;
  onSessionEnded: ((sessionId: string, event: SessionEndedEvent) => void) | null = null;
  /** Called when a session is evicted from the in-memory adapter map to free
   *  runtime memory. The session is NOT ended — its on-disk state is intact
   *  and the next interaction will lazy-resume it. The relay-client uses
   *  this to mark the session `disconnected` in SessionManager so the meta
   *  state matches reality. No arm broadcast: load-state is internal. */
  onSessionEvicted: ((sessionId: string) => void) | null = null;
  /** Called when the agent produces a title for a session (e.g. via SDK event). */
  onTitleChanged: ((sessionId: string, title: string) => void) | null = null;
  /** Called with updated cumulative token usage for a session */
  onUsageUpdate: ((sessionId: string, usage: SessionUsage) => void) | null = null;

  // --- Lifecycle ---

  /** Start the adapter (e.g. spawn CLI server). */
  abstract start(): Promise<void>;

  /** Stop the adapter and release all resources. */
  abstract stop(): Promise<void>;

  // --- Session management ---

  /** Create a new agent session. */
  abstract createSession(config: CreateSessionConfig): Promise<{ sessionId: string }>;

  /** Fork a session by copying SDK state and resuming the copy. */
  async forkSession(sourceSessionId: string, newSessionId: string): Promise<{ sessionId: string }> {
    // Default: just resume with the new ID (adapters that manage SDK state should override)
    return this.resumeSession(newSessionId);
  }

  /** Resume a previously created session with recovery context. */
  abstract resumeSession(sessionId: string, context?: SessionContext): Promise<{ sessionId: string }>;

  /** Send a user message to a session. */
  abstract sendMessage(sessionId: string, text: string, attachments?: import('@kraki/protocol').Attachment[]): Promise<void>;

  /** Respond to a pending permission request. */
  abstract respondToPermission(
    sessionId: string,
    permissionId: string,
    decision: PermissionDecision,
  ): Promise<void>;

  /** Respond to a pending agent question. */
  abstract respondToQuestion(
    sessionId: string,
    questionId: string,
    answer: string,
    wasFreeform: boolean,
  ): Promise<void>;

  /** Kill / disconnect a session. */
  abstract killSession(sessionId: string): Promise<void>;

  /** Abort the current turn (session stays alive). Override in concrete adapters. */
  async abortSession(_sessionId: string): Promise<void> { /* no-op by default */ }

  /** List known sessions. */
  abstract listSessions(): Promise<SessionInfo[]>;

  /** List available models. Override in concrete adapters. */
  async listModels(): Promise<string[]> { return []; }

  /** List available models with rich metadata. Override in concrete adapters. */
  async listModelDetails(): Promise<ModelDetail[]> { return []; }

  /** Set permission mode for a session. Override in concrete adapters. */
  setSessionMode(_sessionId: string, _mode: 'safe' | 'discuss' | 'execute' | 'delegate'): void { /* no-op by default */ }

  /** Generate a title for a session via LLM. Override in concrete adapters. */
  async generateTitle(_context: { firstUserMessage: string; lastUserMessage?: string; recentMessages?: string[]; currentTitle?: string }): Promise<string | null> { return null; }

  /** Change model (and optionally reasoning effort / context tier) for a session. Override in concrete adapters. */
  async setSessionModel(_sessionId: string, _model: string, _reasoningEffort?: string, _contextTier?: string): Promise<void> { /* no-op by default */ }

  /** Get current cumulative usage for a session. Override in concrete adapters. */
  getSessionUsage(_sessionId: string): SessionUsage | null { return null; }

  /** Restore persisted usage totals (called on session resume). */
  setSessionUsage(_sessionId: string, _usage: SessionUsage): void { /* no-op by default */ }

  /** Pre-register a session→agent mapping (used by MultiAgentAdapter for resume). */
  registerSessionAgent(_sessionId: string, _agentId: string): void { /* no-op by default */ }
}
