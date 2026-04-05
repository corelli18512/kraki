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
}
