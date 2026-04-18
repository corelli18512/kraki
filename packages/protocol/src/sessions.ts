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
}

export interface SessionSummary {
  id: string;
  deviceId: string;
  deviceName: string;
  agent: string;
  model?: string;
  title?: string;
  autoTitle?: string;
  state: SessionState;
  messageCount: number;
  /** Origin of this session. Absent for sessions created natively in Kraki. */
  source?: LocalSessionSource | 'imported';
}

/** Compact session metadata sent in session_list for sync. */
export interface SessionDigest {
  id: string;
  agent: string;
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
}

// ------------------------------------------------------------
// Local session types — for local session sync / import feature
// ------------------------------------------------------------

/** Where a local session originated. */
export type LocalSessionSource = 'copilot-cli' | 'vscode' | 'unknown';

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
