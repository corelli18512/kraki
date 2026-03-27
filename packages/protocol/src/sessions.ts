// ------------------------------------------------------------
// Session types — managed by tentacle and frontend, not relay
// ------------------------------------------------------------

export type SessionState = 'active' | 'idle';

export interface SessionSummary {
  id: string;
  deviceId: string;
  deviceName: string;
  agent: string;
  model?: string;
  state: SessionState;
  messageCount: number;
}

/** Compact session metadata sent in session_list for sync. */
export interface SessionDigest {
  id: string;
  agent: string;
  model?: string;
  title?: string;
  state: SessionState;
  lastSeq: number;
  readSeq: number;
  messageCount: number;
  createdAt: string;
}
