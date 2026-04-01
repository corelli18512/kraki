// ------------------------------------------------------------
// Device types
// ------------------------------------------------------------

export type DeviceRole = 'tentacle' | 'app';
export type DeviceKind = 'desktop' | 'server' | 'vm' | 'web' | 'ios' | 'android';

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
  /** Available agent models (e.g. ["claude-sonnet-4", "gpt-4.1"]) */
  models?: string[];
}
