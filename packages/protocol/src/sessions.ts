// ------------------------------------------------------------
// Session types
// ------------------------------------------------------------

export interface Session {
  id: string;
  channelId: string;
  deviceId: string;
  agent: string;
  model?: string;
  messageCount: number;
  lastSeq: number;
  createdAt: string;
}

export interface SessionSummary {
  id: string;
  deviceId: string;
  deviceName: string;
  agent: string;
  model?: string;
  messageCount: number;
}
