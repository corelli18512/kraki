// The base every inner message extends (inside the encrypted blob, invisible to the relay).

// ============================================================
// Inner message base (inside encrypted blob, invisible to relay)
// ============================================================

export interface BaseEnvelope {
  deviceId: string;
  seq: number;
  timestamp: string;
  sessionId?: string;
}
