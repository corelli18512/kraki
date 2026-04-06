// ------------------------------------------------------------
// Push notification provider interface
// ------------------------------------------------------------

/** Payload forwarded to the push service — encrypted, opaque to the relay. */
export interface PushPayload {
  /** Encrypted preview blob (base64) */
  blob: string;
  /** RSA-wrapped AES key for this specific device (base64) */
  key: string;
}

/** Result of a push send attempt. */
export interface PushResult {
  success: boolean;
  /** Error message if send failed */
  error?: string;
  /** True if the token is permanently invalid (e.g. APNs 410 Gone) — caller should delete it */
  gone?: boolean;
}

/** Abstract push notification provider. Implement for each push service. */
export interface PushProvider {
  /** Provider name — must match the token's provider field (e.g. 'apns') */
  readonly name: string;

  /** Send an encrypted preview payload to a device. */
  send(token: string, payload: PushPayload, opts?: {
    environment?: string;
    bundleId?: string;
  }): Promise<PushResult>;

  /** Clean up resources (e.g. HTTP/2 sessions). */
  close?(): void;
}
