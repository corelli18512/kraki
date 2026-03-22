// ------------------------------------------------------------
// Session types — managed by tentacle and frontend, not relay
// ------------------------------------------------------------

export type SessionState = 'active' | 'idle' | 'ended';

export interface SessionSummary {
  id: string;
  deviceId: string;
  deviceName: string;
  agent: string;
  model?: string;
  state: SessionState;
  messageCount: number;
}
