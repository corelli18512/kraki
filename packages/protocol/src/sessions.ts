// ------------------------------------------------------------
// Session types — managed by tentacle and frontend, not relay
// ------------------------------------------------------------

export type SessionState = 'active' | 'idle';

/** Permission mode that controls how the agent's tool usage and questions are handled. */
export type SessionMode = 'safe' | 'discuss' | 'execute' | 'delegate';

/** Cumulative token usage for a session. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
  totalDurationMs: number;
  /** Prompt tokens used by the last turn — per-turn snapshot, NOT cumulative. */
  contextTokens?: number;
}

export interface SessionSummary {
  id: string;
  deviceId: string;
  deviceName: string;
  agent: import('./devices.js').AgentId;
  model?: string;
  title?: string;
  autoTitle?: string;
  state: SessionState;
  messageCount: number;
  /** Origin of this session. Absent for sessions created natively in Kraki. */
  source?: LocalSessionSource | 'imported';
  /** Open ask_user questions blocking the current turn (see SessionDigest).
   *  Seeds the "pending" status for sessions not yet opened after a reload;
   *  superseded by live question / question_resolved once connected. */
  pendingQuestions?: number;
}

/** Sidebar preview — last meaningful message for list display and sort. */
export interface SessionPreviewDigest {
  /** Truncated plain-text preview (max ~80 chars, markdown stripped). */
  text: string;
  /** Message type that produced the preview. */
  type: 'agent' | 'user' | 'error' | 'permission' | 'question' | 'answer';
  /** ISO 8601 timestamp of the source message. Used for sidebar sort order. */
  timestamp: string;
}

/** Compact session metadata sent in session_list for sync. */
export interface SessionDigest {
  id: string;
  agent: import('./devices.js').AgentId;
  model?: string;
  title?: string;
  autoTitle?: string;
  state: SessionState;
  mode: SessionMode;
  lastSeq: number;
  readSeq: number;
  messageCount: number;
  createdAt: string;
  usage?: SessionUsage;
  pinned?: boolean;
  /** Origin of this session. Absent for sessions created natively in Kraki. */
  source?: LocalSessionSource | 'imported';
  /** Sidebar preview computed by tentacle from the last few messages. */
  preview?: SessionPreviewDigest;
  /** Count of open ask_user questions blocking this session's current turn.
   *  Present (and > 0) only while the session is "pending" — a running turn
   *  waiting on human input. Lets a freshly reloaded arm render the pending
   *  status for sessions it hasn't opened yet (before per-session replay).
   *  Optional + additive so older/other clients (e.g. iOS) simply ignore it. */
  pendingQuestions?: number;
}

// ------------------------------------------------------------
// Local session types — for local session sync / import feature
// ------------------------------------------------------------

/** Where a local session originated. */
export type LocalSessionSource = 'copilot-cli' | 'claude-code' | 'vscode' | 'unknown';

/**
 * A Copilot session discovered on the local filesystem.
 * Lightweight descriptor — no message history.
 * Sent from tentacle to arm as part of local_sessions_list.
 */
export interface LocalSession {
  sessionId: string;

  /** Where the CLI was launched. Always present. */
  cwd: string;
  /** Git repo root. Preferred tree grouping key. Absent ~46% of sessions. */
  gitRoot?: string;
  /** "owner/repo" format. Best display label when available. */
  repository?: string;
  /** Git branch. Absent when gitRoot is absent. */
  branch?: string;

  /** SDK-generated summary. Absent for very new sessions. */
  summary?: string;
  /** Model ID (e.g. "claude-opus-4.6-1m"). Only if scanner read events.jsonl line 1. */
  model?: string;
  /** ISO 8601 creation time. */
  startTime: string;
  /** ISO 8601 last activity. */
  modifiedTime: string;

  /** Lock file exists + PID alive. */
  isLive: boolean;
  source: LocalSessionSource;
  /** Set if already imported into Kraki. */
  linkedKrakiSessionId?: string;
}
