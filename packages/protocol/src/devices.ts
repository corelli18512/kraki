// ------------------------------------------------------------
// Device types
// ------------------------------------------------------------

export type DeviceRole = 'tentacle' | 'app';
export type DeviceKind = 'desktop' | 'server' | 'vm' | 'web' | 'ios' | 'android';

/** General agent category — extensible for future non-coding agents. */
export type AgentType = 'code';

/** Specific agent implementation within a type. */
export type AgentId = 'copilot' | 'claude';

/** Agent info reported by a tentacle. */
export interface AgentCapabilities {
  type: AgentType;
  id: AgentId;
  models?: string[];
  modelDetails?: ModelDetail[];
}

export interface Device {
  id: string;
  channelId: string;
  name: string;
  role: DeviceRole;
  kind?: DeviceKind;
  publicKey?: string;
  lastSeen: string;
  createdAt: string;
}

export interface DeviceSummary {
  id: string;
  name: string;
  role: DeviceRole;
  kind?: DeviceKind;
  /** Public key for auth (RSASSA-PKCS1-v1_5) */
  publicKey?: string;
  /** Public key for E2E encryption (RSA-OAEP). If absent, use publicKey. */
  encryptionKey?: string;
  online: boolean;
  /** Capabilities reported by the device (e.g. available models) */
  capabilities?: DeviceCapabilities;
  /** ISO timestamp of last connection */
  lastSeen?: string;
  /** ISO timestamp of device registration */
  createdAt?: string;
}

export interface DeviceInfo {
  name: string;
  role: DeviceRole;
  kind?: DeviceKind;
  /** Public key for challenge-response auth (RSASSA-PKCS1-v1_5, SPKI base64) */
  publicKey?: string;
  /** Public key for E2E encryption (RSA-OAEP, SPKI base64). If omitted, publicKey is used. */
  encryptionKey?: string;
  /** Client-provided stable device ID for reconnection. If omitted, server generates one. */
  deviceId?: string;
  /** Capabilities reported by the device */
  capabilities?: DeviceCapabilities;
}

export interface DeviceCapabilities {
  /** Agent running on this device */
  agent?: AgentCapabilities;
}

// ── Push notification providers ──────────────────────────

export type PushProviderType = 'apns' | 'fcm' | 'web_push';

// ── Model metadata ──────────────────────────────────────

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** Model info exposed through the protocol (subset of SDK ModelInfo). */
export interface ModelDetail {
  id: string;
  name: string;
  supportsReasoningEffort: boolean;
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
  /** Total token ceiling for the model (e.g. 200000). */
  contextWindow?: number;
}
